import * as path from 'path';
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { LogRecord } from '../store/model';
import { severityLabel } from './format';
import { getNonce, htmlShell } from './webviewUtil';

export class LogsPanel {
  private static panels = new Map<string, LogsPanel>();

  private disposables: vscode.Disposable[] = [];
  private snapshot: LogRecord[] = [];

  static show(controller: OtelController, instanceId: string): void {
    const existing = LogsPanel.panels.get(instanceId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const inst = controller.store.getInstance(instanceId);
    const title = inst ? `Logs: ${inst.serviceName}` : 'Logs';
    const panel = vscode.window.createWebviewPanel(
      'otel.logs',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    LogsPanel.panels.set(instanceId, new LogsPanel(panel, controller, instanceId));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m) => this.onMessage(m),
      null,
      this.disposables
    );
    this.disposables.push(this.controller.store.onDidChange(() => this.postData()));
    this.postData();
  }

  private postData(): void {
    const inst = this.controller.store.getInstance(this.instanceId);
    if (!inst) {
      this.panel.webview.postMessage({ type: 'data', rows: [], gone: true });
      return;
    }
    this.snapshot = inst.logs.toArray();
    const rows = this.snapshot.map((l, i) => ({
      i,
      time: new Date(l.timeMs || l.observedTimeMs || 0).toISOString(),
      sev: l.severityText || severityLabel(l.severityNumber),
      sevNum: l.severityNumber,
      msg: renderBody(l.body),
      attrs: summarizeAttrs(l.attrs),
      hasCode: !!l.codeLocation,
      traceId: l.traceId ?? '',
    }));
    this.panel.webview.postMessage({ type: 'data', rows });
  }

  private async onMessage(m: any): Promise<void> {
    if (m?.type === 'navigate') {
      await this.navigateToCode(m.index);
    } else if (m?.type === 'openInEditor') {
      await this.openInEditor(m.index);
    } else if (m?.type === 'ready') {
      this.postData();
    }
  }

  private async navigateToCode(index: number): Promise<void> {
    const log = this.snapshot[index];
    const loc = log?.codeLocation;
    if (!loc) {
      vscode.window.showInformationMessage(
        'No code location on this log (requires code.filepath / code.lineno attributes).'
      );
      return;
    }
    const uri = await resolveWorkspaceFile(loc.filepath);
    if (!uri) {
      vscode.window.showWarningMessage(`Could not locate file: ${loc.filepath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = Math.max(0, (loc.line ?? 1) - 1);
    const pos = new vscode.Position(line, Math.max(0, (loc.column ?? 1) - 1));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private async openInEditor(index: number): Promise<void> {
    const log = this.snapshot[index];
    if (!log) return;
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(serializeLog(log), null, 2),
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  private render(): string {
    const nonce = getNonce();
    return htmlShell(this.panel.webview, nonce, BODY, SCRIPT, STYLE);
  }

  private dispose(): void {
    LogsPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function renderBody(body: any): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function summarizeAttrs(attrs: Record<string, any>): string {
  const keys = Object.keys(attrs);
  if (!keys.length) return '';
  return keys
    .slice(0, 8)
    .map((k) => `${k}=${typeof attrs[k] === 'object' ? JSON.stringify(attrs[k]) : attrs[k]}`)
    .join('  ');
}

function serializeLog(log: LogRecord): any {
  return {
    time: new Date(log.timeMs || 0).toISOString(),
    observedTime: log.observedTimeMs ? new Date(log.observedTimeMs).toISOString() : undefined,
    severityNumber: log.severityNumber,
    severityText: log.severityText,
    body: log.body,
    traceId: log.traceId,
    spanId: log.spanId,
    scope: log.scope,
    codeLocation: log.codeLocation,
    attributes: log.attrs,
  };
}

async function resolveWorkspaceFile(filepath: string): Promise<vscode.Uri | undefined> {
  if (path.isAbsolute(filepath)) {
    const uri = vscode.Uri.file(filepath);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      /* fall through to workspace search */
    }
  }
  const base = path.basename(filepath);
  const matches = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 5);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const rel = filepath.replace(/\\/g, '/');
    return matches.find((u) => u.path.endsWith(rel)) ?? matches[0];
  }
  return undefined;
}

const STYLE = `
  .rows { overflow: auto; }
  td.msg { max-width: 60ch; word-break: break-word; white-space: pre-wrap; }
  td.attrs { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .sev { font-weight: 600; }
  .sev-error, .sev-fatal { color: var(--vscode-errorForeground); }
  .sev-warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .count { margin-left: auto; }
`;

const BODY = `
<div class="toolbar">
  <input id="q" type="text" placeholder="Filter text..." style="min-width:180px" />
  <select id="level">
    <option value="0">All levels</option>
    <option value="1">Trace+</option>
    <option value="5">Debug+</option>
    <option value="9">Info+</option>
    <option value="13">Warn+</option>
    <option value="17">Error+</option>
  </select>
  <input id="attr" type="text" placeholder="attr=value" style="min-width:140px" />
  <button id="nav" class="secondary">Navigate To Code</button>
  <button id="open" class="secondary">Open In Editor</button>
  <span id="count" class="count muted"></span>
</div>
<div class="rows"><table><thead>
  <tr><th style="width:200px">Time</th><th style="width:70px">Level</th><th>Message</th><th>Attributes</th></tr>
</thead><tbody id="tbody"></tbody></table>
<div id="empty" class="empty">Waiting for logs…</div>
</div>
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let allRows = [];
let selected = -1;
const tbody = document.getElementById('tbody');
const empty = document.getElementById('empty');
const q = document.getElementById('q');
const level = document.getElementById('level');
const attr = document.getElementById('attr');
const count = document.getElementById('count');

function sevClass(n){ if(n>=21)return'sev-fatal'; if(n>=17)return'sev-error'; if(n>=13)return'sev-warn'; return''; }

function apply(){
  const text = q.value.toLowerCase();
  const minLevel = parseInt(level.value,10)||0;
  const a = attr.value.trim().toLowerCase();
  let filtered = allRows.filter(r => {
    if (r.sevNum < minLevel) return false;
    if (text && !(r.msg.toLowerCase().includes(text) || r.attrs.toLowerCase().includes(text) || (r.sev||'').toLowerCase().includes(text))) return false;
    if (a && !r.attrs.toLowerCase().includes(a)) return false;
    return true;
  });
  const MAX = 2000;
  const truncated = filtered.length > MAX;
  if (truncated) filtered = filtered.slice(filtered.length - MAX);
  render(filtered);
  count.textContent = filtered.length + (truncated ? '+ ' : ' ') + 'of ' + allRows.length + ' logs';
  empty.style.display = allRows.length ? 'none' : 'block';
}

function render(rows){
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const r of rows){
    const tr = document.createElement('tr');
    tr.className = 'selectable' + (r.i===selected?' selected':'');
    tr.dataset.i = r.i;
    tr.innerHTML =
      '<td class="muted">'+esc(r.time)+'</td>'+
      '<td class="sev '+sevClass(r.sevNum)+'">'+esc(r.sev)+'</td>'+
      '<td class="msg">'+esc(r.msg)+(r.hasCode?' <span class="muted">[code]</span>':'')+'</td>'+
      '<td class="attrs">'+esc(r.attrs)+'</td>';
    tr.addEventListener('click', ()=>{ selected = r.i; apply(); });
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

q.addEventListener('input', apply);
level.addEventListener('change', apply);
attr.addEventListener('input', apply);
document.getElementById('nav').addEventListener('click', ()=>{ if(selected>=0) vscode.postMessage({type:'navigate', index:selected}); });
document.getElementById('open').addEventListener('click', ()=>{ if(selected>=0) vscode.postMessage({type:'openInEditor', index:selected}); });

window.addEventListener('message', (e)=>{
  const m = e.data;
  if (m.type === 'data'){ allRows = m.rows; if(selected>=allRows.length) selected=-1; apply(); }
});
vscode.postMessage({type:'ready'});
`;
