import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { formatDuration } from './format';
import { AttrFilter, buildWaterfall, parseAttrFilter, traceMatchesAttrFilter } from './waterfall';
import { getNonce, htmlShell } from './webviewUtil';

export class TracesPanel {
  private static panels = new Map<string, TracesPanel>();
  private disposables: vscode.Disposable[] = [];
  private attrFilter: AttrFilter | undefined;

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
    const filter = this.attrFilter;
    const traces = [...inst.traces.values()]
      .filter((t) => !filter || traceMatchesAttrFilter(t.spans.values(), filter))
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
    } else if (m?.type === 'attrFilter' && typeof m.text === 'string') {
      this.attrFilter = parseAttrFilter(m.text);
      this.postList();
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

const STYLE = `
  .split { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .list { flex: 1 1 45%; min-height: 120px; overflow: auto; border-bottom: 2px solid var(--vscode-panel-border); }
  .wf-split { flex: 1 1 55%; min-height: 0; display: flex; }
  .wf { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 8px; }
  .err { color: var(--vscode-errorForeground); }
  .bar-row { display: flex; align-items: center; height: 22px; font-size: 0.9em; cursor: pointer; }
  .bar-row:hover { background: var(--vscode-list-hoverBackground); }
  .bar-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .bar-row.selected .kind, .bar-row.selected .bar-dur { color: inherit; }
  .bar-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .bar-label { width: 40%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { position: relative; flex: 1; height: 14px; background: var(--vscode-editorWidget-background); border-radius: 2px; }
  .bar { position: absolute; height: 14px; background: var(--vscode-charts-blue, #3794ff); border-radius: 2px; min-width: 2px; }
  .bar.error { background: var(--vscode-charts-red, #f14c4c); }
  .bar-dur { width: 90px; text-align: right; padding-left: 8px; color: var(--vscode-descriptionForeground); }
  .svc-badge { font-size: 0.8em; padding: 0 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
  .kind { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-left: 6px; }
  #spanDetail { flex: 0 0 40%; min-width: 260px; overflow: auto; padding: 8px; border-left: 1px solid var(--vscode-panel-border); }
  #spanDetail[hidden] { display: none; }
  .sd-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
  .sd-title { flex: 1; min-width: 0; word-break: break-word; }
  #spanDetail h4 { margin: 12px 0 4px; }
  .kv { table-layout: fixed; }
  .kv td { padding: 2px 6px; }
  .kv td.k { width: 35%; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .kv .val { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .sd-event { margin: 6px 0 10px; }
  @media (max-width: 700px) {
    .wf-split { flex-direction: column; }
    #spanDetail { flex: 0 0 auto; max-height: 50%; min-width: 0; border-left: none; border-top: 1px solid var(--vscode-panel-border); }
  }
`;

const BODY = `
<div class="split">
  <div class="toolbar">
    <input id="minDur" type="number" min="0" placeholder="min ms" style="width:90px" />
    <input id="tid" type="text" placeholder="trace id contains…" style="min-width:160px" />
    <input id="attrFilter" type="text" placeholder="attr key[=value]…" title="key: attribute present · key=value: value contains text (case-insensitive)" style="min-width:200px" />
    <label><input id="errOnly" type="checkbox" /> errors only</label>
    <span id="count" class="muted count" style="margin-left:auto"></span>
  </div>
  <div class="list"><table><thead>
    <tr><th>Trace</th><th style="width:120px">Duration</th><th style="width:70px">Spans</th><th style="width:180px">Start</th><th>Services</th></tr>
  </thead><tbody id="tbody"></tbody></table>
  <div id="empty" class="empty">Waiting for traces…</div>
  </div>
  <div class="wf-split">
    <div id="wfMain" class="wf"><div id="wfTitle" class="muted">Select a trace and click Examine to view spans.</div><div id="wf"></div></div>
    <aside id="spanDetail" hidden></aside>
  </div>
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
const wf = document.getElementById('wf');
const detail = document.getElementById('spanDetail');
let currentTrace = '';
let currentRows = [];
let selectedSpan = '';

const ESC_MAP = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c=>ESC_MAP[c]); }

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
  document.getElementById('wfTitle').textContent = 'Trace '+traceId+'  ·  '+rows.length+' spans  ·  '+totalMs.toFixed(2)+'ms  ·  click a span for details';
  if (traceId !== currentTrace) selectedSpan = '';
  currentTrace = traceId;
  currentRows = rows;
  wf.innerHTML='';
  const scale = totalMs>0? 100/totalMs : 0;
  rows.forEach((r, i)=>{
    const row=document.createElement('div');
    row.className='bar-row'+(r.spanId===selectedSpan?' selected':'');
    row.dataset.idx=String(i);
    row.tabIndex=0;
    const pad = r.depth*14;
    const left = r.offsetMs*scale;
    const width = Math.max(0.5, r.durationMs*scale);
    row.innerHTML =
      '<div class="bar-label" style="padding-left:'+pad+'px" title="'+esc(r.name)+'">'+
        '<span class="svc-badge">'+esc(r.service)+'</span>'+esc(r.name)+'<span class="kind">'+esc(r.kind)+'</span></div>'+
      '<div class="bar-track"><div class="bar'+(r.hasError?' error':'')+'" style="left:'+left+'%;width:'+width+'%"></div></div>'+
      '<div class="bar-dur">'+r.durationMs.toFixed(2)+'ms</div>';
    wf.appendChild(row);
  });
  const sel = rows.find(r=>r.spanId===selectedSpan);
  if (sel) renderSpanDetail(sel); else hideDetail();
}

function selectSpan(idx){
  const r = currentRows[idx];
  if (!r) return;
  selectedSpan = r.spanId;
  for (const el of wf.querySelectorAll('.bar-row')) el.classList.toggle('selected', el.dataset.idx===String(idx));
  renderSpanDetail(r);
}

function hideDetail(){
  selectedSpan = '';
  for (const el of wf.querySelectorAll('.bar-row.selected')) el.classList.remove('selected');
  detail.hidden = true;
  detail.innerHTML = '';
}

function fmtOffset(ms){ return (ms>=0?'+':'')+ms.toFixed(2)+'ms'; }

function kvTable(entries){
  return '<table class="kv">'+entries.map(a=>'<tr><td class="k">'+esc(a.key)+'</td><td>'+
    (a.structured ? '<pre class="val">'+esc(a.value)+'</pre>' : '<div class="val">'+esc(a.value)+'</div>')+
    '</td></tr>').join('')+'</table>';
}

function metaRow(k, html){ return '<tr><td class="k">'+esc(k)+'</td><td>'+html+'</td></tr>'; }

function renderSpanDetail(r){
  let status = esc(r.status)+(r.statusMessage ? ' — '+esc(r.statusMessage) : '');
  if (r.hasError) status = '<span class="err">'+status+'</span>';
  let meta = metaRow('Status', status)+
    metaRow('Duration', esc(r.durationMs.toFixed(2)+'ms'))+
    metaRow('Start', esc(fmtOffset(r.offsetMs)))+
    metaRow('Span ID', '<code>'+esc(r.spanId)+'</code>');
  if (r.parentSpanId) meta += metaRow('Parent ID', '<code>'+esc(r.parentSpanId)+'</code>');
  if (r.scope) meta += metaRow('Scope', esc(r.scope));
  let html =
    '<div class="sd-head"><div class="sd-title"><span class="svc-badge">'+esc(r.service)+'</span><strong>'+esc(r.name)+'</strong>'+
      '<span class="kind">'+esc(r.kind)+'</span></div>'+
      '<button id="sdClose" class="secondary" title="Close" aria-label="Close span details">×</button></div>'+
    '<table class="kv">'+meta+'</table>'+
    '<h4>Attributes ('+r.attrs.length+')</h4>'+
    (r.attrs.length ? kvTable(r.attrs) : '<div class="muted">No attributes</div>')+
    '<h4>Events ('+r.events.length+')</h4>';
  if (!r.events.length) html += '<div class="muted">No events</div>';
  for (const ev of r.events){
    html += '<div class="sd-event"><div><strong>'+esc(ev.name)+'</strong> <span class="muted">'+esc(fmtOffset(ev.offsetMs))+'</span></div>'+
      (ev.attrs.length ? kvTable(ev.attrs) : '')+'</div>';
  }
  detail.innerHTML = html;
  detail.hidden = false;
  detail.scrollTop = 0;
}

wf.addEventListener('click', (e)=>{
  const row = e.target.closest('.bar-row');
  if (row) selectSpan(Number(row.dataset.idx));
});
wf.addEventListener('keydown', (e)=>{
  if (e.key!=='Enter' && e.key!==' ') return;
  const row = e.target.closest('.bar-row');
  if (!row) return;
  e.preventDefault();
  selectSpan(Number(row.dataset.idx));
});
detail.addEventListener('click', (e)=>{ if (e.target.closest('#sdClose')) hideDetail(); });

minDur.addEventListener('input', apply);
tid.addEventListener('input', apply);
errOnly.addEventListener('change', apply);
const attrFilter = document.getElementById('attrFilter');
let attrTimer;
attrFilter.addEventListener('input', ()=>{
  clearTimeout(attrTimer);
  attrTimer = setTimeout(()=>vscode.postMessage({type:'attrFilter', text:attrFilter.value}), 200);
});

window.addEventListener('message', (e)=>{
  const m=e.data;
  if(m.type==='list'){ traces=m.traces; if(!traces.find(t=>t.traceId===selected)) selected=''; apply(); }
  else if(m.type==='waterfall'){ renderWaterfall(m.traceId, m.rows, m.totalMs); }
});
vscode.postMessage({type:'ready'});
`;
