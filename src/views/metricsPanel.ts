import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Metric } from '../store/model';
import { getNonce, htmlShell } from './webviewUtil';

export class MetricsPanel {
  private static panels = new Map<string, MetricsPanel>();
  private disposables: vscode.Disposable[] = [];

  static show(controller: OtelController, instanceId: string): void {
    const existing = MetricsPanel.panels.get(instanceId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const inst = controller.store.getInstance(instanceId);
    const panel = vscode.window.createWebviewPanel(
      'otel.metrics',
      inst ? `Metrics: ${inst.serviceName}` : 'Metrics',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    MetricsPanel.panels.set(instanceId, new MetricsPanel(panel, controller, instanceId));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, SCRIPT, STYLE);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') this.postData();
    }, null, this.disposables);
    this.disposables.push(this.controller.store.onDidChange(() => this.postData()));
    this.postData();
  }

  private postData(): void {
    const inst = this.controller.store.getInstance(this.instanceId);
    if (!inst) {
      this.panel.webview.postMessage({ type: 'data', metrics: [], gone: true });
      return;
    }
    const metrics = [...inst.metrics.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => ({
        name: m.name,
        type: m.type,
        unit: m.unit ?? '',
        description: m.description ?? '',
        points: summarizePoints(m),
      }));
    this.panel.webview.postMessage({ type: 'data', metrics });
  }

  private dispose(): void {
    MetricsPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function labels(attrs: Record<string, any>): string {
  const keys = Object.keys(attrs);
  if (!keys.length) return '';
  return keys.map((k) => `${k}=${attrs[k]}`).join(', ');
}

function summarizePoints(m: Metric): { labels: string; value: string }[] {
  return m.dataPoints.slice(0, 50).map((dp) => {
    if (m.type === 'histogram') {
      const count = dp.count ?? 0;
      const sum = dp.sum ?? 0;
      const avg = count ? sum / count : 0;
      return {
        labels: labels(dp.attrs),
        value: `count=${count} sum=${round(sum)} avg=${round(avg)}`,
      };
    }
    return { labels: labels(dp.attrs), value: `${round(dp.value ?? 0)}` };
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const STYLE = `
  .type-badge { font-size: 0.8em; padding: 0 5px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  td.name { font-family: var(--vscode-editor-font-family, monospace); }
  .pt { display:block; }
  .pt .lbl { color: var(--vscode-descriptionForeground); }
`;

const BODY = `
<div class="toolbar">
  <input id="q" type="text" placeholder="Filter metric name…" style="min-width:200px" />
  <span id="count" class="muted count" style="margin-left:auto"></span>
</div>
<div class="rows"><table><thead>
  <tr><th style="width:32%">Metric</th><th style="width:110px">Type</th><th style="width:70px">Unit</th><th>Data points (latest)</th></tr>
</thead><tbody id="tbody"></tbody></table>
<div id="empty" class="empty">Waiting for metrics…</div>
</div>
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let metrics = [];
const tbody=document.getElementById('tbody');
const empty=document.getElementById('empty');
const q=document.getElementById('q');
const count=document.getElementById('count');
function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function apply(){
  const f=q.value.toLowerCase();
  const rows=metrics.filter(m=>!f||m.name.toLowerCase().includes(f));
  tbody.innerHTML='';
  const frag=document.createDocumentFragment();
  for(const m of rows){
    const tr=document.createElement('tr');
    const pts=m.points.map(p=>'<span class="pt"><span class="lbl">'+esc(p.labels||'(no labels)')+'</span> → '+esc(p.value)+'</span>').join('');
    tr.innerHTML='<td class="name" title="'+esc(m.description)+'">'+esc(m.name)+'</td>'+
      '<td><span class="type-badge">'+esc(m.type)+'</span></td>'+
      '<td class="muted">'+esc(m.unit)+'</td>'+
      '<td>'+pts+'</td>';
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  count.textContent=rows.length+' of '+metrics.length+' metrics';
  empty.style.display=metrics.length?'none':'block';
}
q.addEventListener('input', apply);
window.addEventListener('message', e=>{ const m=e.data; if(m.type==='data'){ metrics=m.metrics; apply(); }});
vscode.postMessage({type:'ready'});
`;
