import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Span } from '../store/model';
import { getNonce, htmlShell } from './webviewUtil';

type NodeType = 'service' | 'database' | 'queue' | 'external';

interface MapNode {
  id: string;
  label: string;
  type: NodeType;
}
interface MapEdge {
  source: string;
  target: string;
  count: number;
  errors: number;
}

export class ServiceMapPanel {
  private static current: ServiceMapPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  static show(controller: OtelController): void {
    if (ServiceMapPanel.current) {
      ServiceMapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'otel.serviceMap',
      'OpenTelemetry Service Map',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ServiceMapPanel.current = new ServiceMapPanel(panel, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController
  ) {
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, SCRIPT, STYLE);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') this.postGraph();
    }, null, this.disposables);
    this.disposables.push(this.controller.store.onDidChange(() => this.postGraph()));
    this.postGraph();
  }

  private postGraph(): void {
    const { nodes, edges } = buildGraph(this.controller.store.getAllTaggedSpans());
    this.panel.webview.postMessage({ type: 'graph', nodes, edges });
  }

  private dispose(): void {
    ServiceMapPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function str(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function buildGraph(tagged: { span: Span; serviceName: string }[]): {
  nodes: MapNode[];
  edges: MapEdge[];
} {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const serviceBySpan = new Map<string, string>();

  const addNode = (id: string, label: string, type: NodeType) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, type });
  };
  const addEdge = (source: string, target: string, isError: boolean) => {
    if (source === target) return;
    const key = `${source}\u0000${target}`;
    const e = edges.get(key) ?? { source, target, count: 0, errors: 0 };
    e.count++;
    if (isError) e.errors++;
    edges.set(key, e);
  };

  for (const { span, serviceName } of tagged) {
    addNode(`svc:${serviceName}`, serviceName, 'service');
    serviceBySpan.set(span.spanId, serviceName);
  }

  for (const { span, serviceName } of tagged) {
    const a = span.attrs;
    const isError = span.statusCode === 'ERROR';
    const db = str(a['db.system']);
    const msg = str(a['messaging.system']);
    if (db) {
      const name = str(a['db.namespace']) ?? str(a['db.name']) ?? db;
      const id = `db:${db}:${name}`;
      addNode(id, `${db}: ${name}`, 'database');
      addEdge(`svc:${serviceName}`, id, isError);
    } else if (msg) {
      const dest = str(a['messaging.destination.name']) ?? str(a['messaging.destination']) ?? msg;
      const id = `queue:${msg}:${dest}`;
      addNode(id, `${msg}: ${dest}`, 'queue');
      addEdge(`svc:${serviceName}`, id, isError);
    } else if (span.kind === 'CLIENT') {
      const peer =
        str(a['peer.service']) ??
        str(a['server.address']) ??
        str(a['net.peer.name']) ??
        str(a['rpc.service']);
      if (peer && !serviceExists(nodes, peer)) {
        const id = `ext:${peer}`;
        addNode(id, peer, 'external');
        addEdge(`svc:${serviceName}`, id, isError);
      }
    }
  }

  // Cross-service edges via parent/child across services.
  for (const { span, serviceName } of tagged) {
    if (!span.parentSpanId) continue;
    const parentService = serviceBySpan.get(span.parentSpanId);
    if (parentService && parentService !== serviceName) {
      addEdge(`svc:${parentService}`, `svc:${serviceName}`, span.statusCode === 'ERROR');
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function serviceExists(nodes: Map<string, MapNode>, name: string): boolean {
  return nodes.has(`svc:${name}`);
}

const STYLE = `
  #wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
  svg { width:100%; height:100%; display:block; }
  .node rect, .node ellipse { stroke: var(--vscode-panel-border); stroke-width:1.5; }
  .node.service rect { fill: var(--vscode-button-background); }
  .node.database ellipse { fill: var(--vscode-charts-purple, #b180d7); }
  .node.queue rect { fill: var(--vscode-charts-orange, #d18616); }
  .node.external rect { fill: var(--vscode-charts-green, #89d185); }
  .node text { fill: var(--vscode-button-foreground); font-size: 12px; pointer-events:none; }
  .node.database text, .node.queue text, .node.external text { fill: #1e1e1e; }
  .edge { stroke: var(--vscode-descriptionForeground); fill:none; marker-end:url(#arrow); }
  .edge.error { stroke: var(--vscode-errorForeground); }
  .edge-label { fill: var(--vscode-descriptionForeground); font-size: 10px; }
`;

const BODY = `
<div class="toolbar">
  <strong>Service Map</strong>
  <span class="muted">services · databases · queues · external</span>
  <button id="relayout" class="secondary" style="margin-left:auto">Re-layout</button>
</div>
<div id="wrap"><svg id="svg"></svg></div>
<div id="empty" class="empty">No traces yet. Generate distributed traces (e.g. HTTP calls) to populate the map.</div>
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let nodes=[], edges=[];
const svg=document.getElementById('svg');
const empty=document.getElementById('empty');
function esc(s){ return (s==null?'':String(s)).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function layout(){
  const W=svg.clientWidth||800, H=svg.clientHeight||600;
  const cx=W/2, cy=H/2;
  const services=nodes.filter(n=>n.type==='service');
  const others=nodes.filter(n=>n.type!=='service');
  const pos={};
  const rS=Math.min(W,H)/3;
  services.forEach((n,i)=>{ const a=(i/Math.max(1,services.length))*Math.PI*2 - Math.PI/2; pos[n.id]={x:cx+rS*Math.cos(a), y:cy+rS*Math.sin(a)}; });
  const rO=Math.min(W,H)/2.1;
  others.forEach((n,i)=>{ const a=(i/Math.max(1,others.length))*Math.PI*2; pos[n.id]={x:cx+rO*Math.cos(a), y:cy+rO*Math.sin(a)}; });
  return pos;
}

function render(){
  empty.style.display = nodes.length? 'none':'block';
  const pos=layout();
  const maxCount=Math.max(1,...edges.map(e=>e.count));
  let s='<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="var(--vscode-descriptionForeground)"/></marker></defs>';
  for(const e of edges){
    const a=pos[e.source], b=pos[e.target]; if(!a||!b) continue;
    const w=1+3*(e.count/maxCount);
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    s+='<path class="edge'+(e.errors?' error':'')+'" style="stroke-width:'+w+'" d="M'+a.x+','+a.y+' L'+b.x+','+b.y+'"/>';
    s+='<text class="edge-label" x="'+mx+'" y="'+my+'">'+e.count+(e.errors?(' ⚠'+e.errors):'')+'</text>';
  }
  for(const n of nodes){
    const p=pos[n.id]; if(!p) continue;
    const label=esc(n.label);
    const wLbl=Math.max(60, label.length*7+16);
    if(n.type==='database'){
      s+='<g class="node database" transform="translate('+p.x+','+p.y+')"><ellipse rx="'+(wLbl/2)+'" ry="20"/><text text-anchor="middle" dy="4">'+label+'</text></g>';
    } else {
      s+='<g class="node '+n.type+'" transform="translate('+p.x+','+p.y+')"><rect x="'+(-wLbl/2)+'" y="-16" width="'+wLbl+'" height="32" rx="4"/><text text-anchor="middle" dy="4">'+label+'</text></g>';
    }
  }
  svg.innerHTML=s;
}

document.getElementById('relayout').addEventListener('click', render);
window.addEventListener('resize', render);
window.addEventListener('message', e=>{ const m=e.data; if(m.type==='graph'){ nodes=m.nodes; edges=m.edges; render(); }});
vscode.postMessage({type:'ready'});
`;
