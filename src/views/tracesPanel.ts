import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Span } from '../store/model';
import { formatDuration } from './format';
import { getNonce, htmlShell } from './webviewUtil';

interface WaterfallRow {
  spanId: string;
  parentSpanId?: string;
  name: string;
  depth: number;
  offsetMs: number;
  durationMs: number;
  kind: string;
  status: string;
  service: string;
  hasError: boolean;
  attrs: Record<string, any>;
}

export class TracesPanel {
  private static panels = new Map<string, TracesPanel>();
  private disposables: vscode.Disposable[] = [];

  static show(controller: OtelController, instanceId: string): void {
    const existing = TracesPanel.panels.get(instanceId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const inst = controller.store.getInstance(instanceId);
    const panel = vscode.window.createWebviewPanel(
      'otel.traces',
      inst ? `Traces: ${inst.serviceName}` : 'Traces',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    TracesPanel.panels.set(instanceId, new TracesPanel(panel, controller, instanceId));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, SCRIPT, STYLE);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.disposables.push(this.controller.store.onDidChange(() => this.postList()));
    this.postList();
  }

  private postList(): void {
    const inst = this.controller.store.getInstance(this.instanceId);
    if (!inst) {
      this.panel.webview.postMessage({ type: 'list', traces: [], gone: true });
      return;
    }
    const traces = [...inst.traces.values()]
      .sort((a, b) => b.startMs - a.startMs)
      .map((t) => {
        const root = t.rootSpanId ? t.spans.get(t.rootSpanId) : undefined;
        const rootName =
          root?.name ?? [...t.spans.values()].sort((a, b) => a.startMs - b.startMs)[0]?.name ?? '(unknown)';
        return {
          traceId: t.traceId,
          root: rootName,
          start: new Date(t.startMs).toISOString(),
          durationMs: t.durationMs,
          durationLabel: formatDuration(t.durationMs),
          spanCount: t.spans.size,
          hasError: t.hasError,
          services: [...t.serviceNames].join(', '),
        };
      });
    this.panel.webview.postMessage({ type: 'list', traces });
  }

  private onMessage(m: any): void {
    if (m?.type === 'examine' && typeof m.traceId === 'string') {
      this.postWaterfall(m.traceId);
    } else if (m?.type === 'ready') {
      this.postList();
    }
  }

  private postWaterfall(traceId: string): void {
    const tagged = this.controller.store.getSpansForTrace(traceId);
    const rows = buildWaterfall(tagged);
    const total = rows.reduce((max, r) => Math.max(max, r.offsetMs + r.durationMs), 0);
    this.panel.webview.postMessage({ type: 'waterfall', traceId, rows, totalMs: total });
  }

  private dispose(): void {
    TracesPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function buildWaterfall(tagged: { span: Span; serviceName: string }[]): WaterfallRow[] {
  const byId = new Map<string, { span: Span; serviceName: string }>();
  for (const t of tagged) byId.set(t.span.spanId, t);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const t of tagged) {
    const parent = t.span.parentSpanId;
    if (parent && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(t.span.spanId);
      children.set(parent, list);
    } else {
      roots.push(t.span.spanId);
    }
  }
  const traceStart = Math.min(...tagged.map((t) => t.span.startMs));
  const rows: WaterfallRow[] = [];
  const sortByStart = (a: string, b: string) =>
    (byId.get(a)!.span.startMs - byId.get(b)!.span.startMs);

  const visit = (spanId: string, depth: number): void => {
    const entry = byId.get(spanId);
    if (!entry) return;
    const s = entry.span;
    rows.push({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      depth,
      offsetMs: Math.max(0, s.startMs - traceStart),
      durationMs: s.durationMs,
      kind: s.kind,
      status: s.statusCode,
      service: entry.serviceName,
      hasError: s.statusCode === 'ERROR',
      attrs: s.attrs,
    });
    const kids = (children.get(spanId) ?? []).sort(sortByStart);
    for (const k of kids) visit(k, depth + 1);
  };
  for (const r of roots.sort(sortByStart)) visit(r, 0);
  return rows;
}

const STYLE = `
  .split { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .list { flex: 1 1 45%; min-height: 120px; overflow: auto; border-bottom: 2px solid var(--vscode-panel-border); }
  .wf { flex: 1 1 55%; min-height: 0; overflow: auto; padding: 8px; }
  .err { color: var(--vscode-errorForeground); }
  .bar-row { display: flex; align-items: center; height: 22px; font-size: 0.9em; }
  .bar-label { width: 40%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { position: relative; flex: 1; height: 14px; background: var(--vscode-editorWidget-background); border-radius: 2px; }
  .bar { position: absolute; height: 14px; background: var(--vscode-charts-blue, #3794ff); border-radius: 2px; min-width: 2px; }
  .bar.error { background: var(--vscode-charts-red, #f14c4c); }
  .bar-dur { width: 90px; text-align: right; padding-left: 8px; color: var(--vscode-descriptionForeground); }
  .svc-badge { font-size: 0.8em; padding: 0 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
  .kind { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-left: 6px; }
`;

const BODY = `
<div class="split">
  <div class="toolbar">
    <input id="minDur" type="number" min="0" placeholder="min ms" style="width:90px" />
    <input id="tid" type="text" placeholder="trace id contains…" style="min-width:160px" />
    <label><input id="errOnly" type="checkbox" /> errors only</label>
    <span id="count" class="muted count" style="margin-left:auto"></span>
  </div>
  <div class="list"><table><thead>
    <tr><th>Trace</th><th style="width:120px">Duration</th><th style="width:70px">Spans</th><th style="width:180px">Start</th><th>Services</th></tr>
  </thead><tbody id="tbody"></tbody></table>
  <div id="empty" class="empty">Waiting for traces…</div>
  </div>
  <div class="wf"><div id="wfTitle" class="muted">Select a trace and click Examine to view spans.</div><div id="wf"></div></div>
</div>
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let traces = [];
let selected = '';
const tbody = document.getElementById('tbody');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const minDur = document.getElementById('minDur');
const tid = document.getElementById('tid');
const errOnly = document.getElementById('errOnly');

function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function apply(){
  const md = parseFloat(minDur.value)||0;
  const f = tid.value.trim().toLowerCase();
  const eo = errOnly.checked;
  const rows = traces.filter(t => t.durationMs>=md && (!f || t.traceId.toLowerCase().includes(f)) && (!eo || t.hasError));
  tbody.innerHTML='';
  const frag=document.createDocumentFragment();
  for (const t of rows){
    const tr=document.createElement('tr');
    tr.className='selectable'+(t.traceId===selected?' selected':'');
    tr.innerHTML='<td>'+(t.hasError?'<span class="err">●</span> ':'')+esc(t.root)+' <span class="muted">'+esc(t.traceId.slice(0,12))+'…</span></td>'+
      '<td>'+esc(t.durationLabel)+'</td><td>'+t.spanCount+'</td><td class="muted">'+esc(t.start)+'</td><td class="muted">'+esc(t.services)+'</td>';
    tr.addEventListener('click', ()=>{ selected=t.traceId; vscode.postMessage({type:'examine', traceId:t.traceId}); apply(); });
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  count.textContent = rows.length+' of '+traces.length+' traces';
  empty.style.display = traces.length ? 'none':'block';
}

function renderWaterfall(traceId, rows, totalMs){
  document.getElementById('wfTitle').textContent = 'Trace '+traceId+'  ·  '+rows.length+' spans  ·  '+totalMs.toFixed(2)+'ms';
  const wf=document.getElementById('wf'); wf.innerHTML='';
  const scale = totalMs>0? 100/totalMs : 0;
  for (const r of rows){
    const row=document.createElement('div'); row.className='bar-row';
    const pad = r.depth*14;
    const left = r.offsetMs*scale;
    const width = Math.max(0.5, r.durationMs*scale);
    row.innerHTML =
      '<div class="bar-label" style="padding-left:'+pad+'px" title="'+esc(r.name)+'">'+
        '<span class="svc-badge">'+esc(r.service)+'</span>'+esc(r.name)+'<span class="kind">'+esc(r.kind)+'</span></div>'+
      '<div class="bar-track"><div class="bar'+(r.hasError?' error':'')+'" style="left:'+left+'%;width:'+width+'%"></div></div>'+
      '<div class="bar-dur">'+r.durationMs.toFixed(2)+'ms</div>';
    wf.appendChild(row);
  }
}

minDur.addEventListener('input', apply);
tid.addEventListener('input', apply);
errOnly.addEventListener('change', apply);

window.addEventListener('message', (e)=>{
  const m=e.data;
  if(m.type==='list'){ traces=m.traces; if(!traces.find(t=>t.traceId===selected)) selected=''; apply(); }
  else if(m.type==='waterfall'){ renderWaterfall(m.traceId, m.rows, m.totalMs); }
});
vscode.postMessage({type:'ready'});
`;
