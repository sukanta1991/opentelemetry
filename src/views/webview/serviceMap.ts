// SPDX-License-Identifier: Apache-2.0
// Service map webview app. Telemetry strings reach the DOM only through textContent/attributes.

import type { MapSelection, ModelEdge, ModelNode, NodeDetails, ServiceMapModel, TraceRef } from '../serviceMapModel';
import { formatTimestamp } from '../format';
import { Layout, MAX_NODE_WIDTH, edgeKey, layoutGraph, topologyKey } from './serviceMapLayout';
import {
  HEALTH_GLYPH,
  HEALTH_LABEL,
  HostMessage,
  LABEL_MIN_SCALE,
  OpenTarget,
  TraceList,
  ViewMessage,
  ViewTransform,
  basename,
  centerOn,
  edgeLabel,
  edgePath,
  edgeWidth,
  fitTransform,
  formatCalls,
  formatCount,
  formatMs,
  formatPercent,
  formatRate,
  loadMapState,
  nodeAriaLabel,
  nodeSubtitle,
  sameSelection,
  sparklinePath,
  truncateLabel,
  zoomAt,
} from './serviceMapView';
import { TIME_RANGE_LABEL, TIME_RANGE_OPTIONS, isTimeRangeKind } from './timeRange';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHAR_WIDTH = 7;
const SPARK_WIDTH = 64;
const SPARK_HEIGHT = 10;
const DRAG_THRESHOLD_PX = 3;
const PERSIST_DELAY_MS = 300;

const vscode = acquireVsCodeApi();
const state = loadMapState(vscode.getState());

let model: ServiceMapModel | null = null;
let details: NodeDetails | null = null;
let seq = 0;
// The seq of the details currently on screen; may lag `seq` until the next frame renders.
let renderedSeq = 0;
let layout: Layout | null = null;
let layoutKey = '';
let view: ViewTransform | null = state.view;
// True while the view came from fit(), so a resize re-fits instead of keeping a stale pan.
let autoFit = !view;
let lastSig = '';
let frame = 0;
let banner: { kind: 'gone' | 'error'; text: string } | null = null;
// The host renders the initial timezone choice on <body>; later changes arrive as `timeZone` messages.
let localTime = document.body.dataset.useLocalTime !== 'false';

function byId<T extends HTMLElement | SVGElement>(id: string): T {
  return document.getElementById(id) as unknown as T;
}

const wrap = byId<HTMLDivElement>('wrap');
const svg = byId<SVGSVGElement>('svg');
const viewport = byId<SVGGElement>('viewport');
const emptyEl = byId<HTMLDivElement>('empty');
const noteEl = byId<HTMLDivElement>('note');
const detailsEl = byId<HTMLElement>('details');
const rangeSel = byId<HTMLSelectElement>('range');
const asOfEl = byId<HTMLSpanElement>('asOf');
const partialEl = byId<HTMLSpanElement>('partial');
const hiddenEl = byId<HTMLSpanElement>('hiddenNodes');

function post(msg: ViewMessage): void {
  vscode.postMessage(msg);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(
    () => vscode.setState({ range: state.range, selection: state.selection, view: autoFit ? null : view }),
    PERSIST_DELAY_MS
  );
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function timeOfDay(ms: number): string {
  return formatTimestamp(ms, localTime).slice(11, 19);
}

// --- Toolbar ----------------------------------------------------------------------------

for (const r of TIME_RANGE_OPTIONS) {
  const o = el('option', undefined, r === 'all' ? 'All retained' : TIME_RANGE_LABEL[r]);
  o.value = r;
  rangeSel.append(o);
}
rangeSel.value = state.range;
rangeSel.addEventListener('change', () => {
  if (!isTimeRangeKind(rangeSel.value)) return;
  state.range = rangeSel.value;
  persist();
  post({ type: 'setRange', range: state.range });
});
byId<HTMLButtonElement>('fit').addEventListener('click', () => fit());
byId<HTMLButtonElement>('relayout').addEventListener('click', () => {
  layoutKey = '';
  view = null;
  render();
});

function renderToolbar(): void {
  asOfEl.textContent = model && model.nodes.length ? `as of ${timeOfDay(model.anchorMs)}` : '';
  partialEl.hidden = !model?.partial;
  if (model?.partial) {
    partialEl.title = `Only ${formatMs(model.effectiveWindowMs)} of data is retained or received for this window; rates use that span.`;
  }
  hiddenEl.hidden = !model?.hiddenNodes;
  hiddenEl.textContent = model?.hiddenNodes ? `${model.hiddenNodes} hidden` : '';
  hiddenEl.title = 'Least-called dependencies hidden to keep the map readable.';
}

// --- Zoom and pan -----------------------------------------------------------------------

function applyView(): void {
  if (!view) return;
  viewport.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.scale})`);
  svg.classList.toggle('zoomed-out', view.scale < LABEL_MIN_SCALE);
}

function fit(): void {
  if (!layout) return;
  view = fitTransform(layout.width, layout.height, wrap.clientWidth, wrap.clientHeight);
  autoFit = true;
  applyView();
  persist();
}

svg.addEventListener(
  'wheel',
  (e) => {
    if (!view) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    autoFit = false;
    applyView();
    persist();
  },
  { passive: false }
);

let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null = null;
svg.addEventListener('pointerdown', (e) => {
  if (!view || e.button !== 0 || (e.target as Element).closest('.node, .edge-group')) return;
  drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false, id: e.pointerId };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', (e) => {
  if (!drag || !view || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  autoFit = false;
  svg.classList.add('panning');
  view = { ...view, tx: drag.tx + dx, ty: drag.ty + dy };
  applyView();
});
svg.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const clicked = !drag.moved;
  drag = null;
  svg.classList.remove('panning');
  svg.releasePointerCapture(e.pointerId);
  if (clicked) select(null);
  else persist();
});

// --- Selection ----------------------------------------------------------------------------

function select(selection: MapSelection | null, center = false): void {
  if (sameSelection(selection, state.selection)) return;
  state.selection = selection;
  if (!selection) details = null;
  else if (details && !sameSelection(details.selection, selection)) details = null;
  persist();
  post({ type: 'select', selection });
  if (center && selection?.kind === 'node' && layout && view) {
    const b = layout.boxes.get(selection.id);
    if (b) {
      view = centerOn(view, b.x, b.y, wrap.clientWidth, wrap.clientHeight);
      autoFit = false;
      applyView();
    }
  }
  renderGraph();
  renderDetails();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selection) select(null);
});

function selectable(target: Element, selection: MapSelection, label: string): void {
  target.setAttribute('tabindex', '0');
  target.setAttribute('role', 'button');
  target.setAttribute('aria-label', label);
  target.setAttribute('aria-pressed', String(sameSelection(selection, state.selection)));
  target.setAttribute(
    'data-key',
    selection.kind === 'node' ? selection.id : edgeKey(selection.source, selection.target)
  );
  target.addEventListener('click', () => select(selection));
  target.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      select(selection);
    }
  });
}

// --- Graph ------------------------------------------------------------------------------

function nodeById(id: string): ModelNode | undefined {
  return model?.nodes.find((n) => n.id === id);
}

function arrowDefs(): SVGDefsElement {
  const defs = svgEl('defs');
  for (const h of ['ok', 'warn', 'critical', 'idle']) {
    const m = svgEl('marker', {
      id: `arrow-${h}`,
      markerWidth: 10,
      markerHeight: 10,
      refX: 9,
      refY: 3,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    });
    m.append(svgEl('path', { d: 'M0,0 L0,6 L9,3 z', class: `arrow health-${h}` }));
    defs.append(m);
  }
  return defs;
}

function renderEdge(e: ModelEdge, maxCount: number): SVGGElement | undefined {
  const a = layout!.boxes.get(e.source);
  const b = layout!.boxes.get(e.target);
  if (!a || !b) return undefined;
  const geo = edgePath(a, b, layout!.backEdges.has(edgeKey(e.source, e.target)));
  const sel: MapSelection = { kind: 'edge', source: e.source, target: e.target };
  const g = svgEl('g', { class: `edge-group health-${e.health}` });
  if (sameSelection(sel, state.selection)) g.classList.add('selected');
  g.append(
    svgEl('path', {
      class: 'edge',
      d: geo.d,
      'stroke-width': edgeWidth(e.stats.count, maxCount).toFixed(2),
      'marker-end': `url(#arrow-${e.health})`,
    }),
    svgEl('path', { class: 'edge-hit', d: geo.d })
  );
  const label = svgEl('text', { class: 'edge-label', x: geo.labelX, y: geo.labelY - 4, 'text-anchor': 'middle' });
  label.textContent = edgeLabel(e.stats);
  g.append(label);
  const src = nodeById(e.source)?.label ?? e.source;
  const dst = nodeById(e.target)?.label ?? e.target;
  selectable(g, sel, `${src} to ${dst}, ${HEALTH_LABEL[e.health]}, ${edgeLabel(e.stats)}, p95 ${formatMs(e.stats.p95)}`);
  return g;
}

function renderNode(n: ModelNode): SVGGElement | undefined {
  const b = layout!.boxes.get(n.id);
  if (!b) return undefined;
  const sel: MapSelection = { kind: 'node', id: n.id };
  const g = svgEl('g', { class: `node ${n.type} health-${n.health}`, transform: `translate(${b.x},${b.y})` });
  if (sameSelection(sel, state.selection)) g.classList.add('selected');
  const w = b.width;
  const h = b.height;
  const rx = n.type === 'service' ? 4 : n.type === 'database' ? 18 : 10;
  g.append(svgEl('rect', { class: 'shape', x: -w / 2, y: -h / 2, width: w, height: h, rx }));
  const title = svgEl('title');
  title.textContent = `${n.label} (${n.type})`;
  const glyph = svgEl('text', { class: 'glyph', x: -w / 2 + 8, y: -9 });
  glyph.textContent = HEALTH_GLYPH[n.health];
  const label = svgEl('text', { class: 'label', x: -w / 2 + 22, y: -9 });
  label.textContent = truncateLabel(n.label, Math.floor((Math.min(w, MAX_NODE_WIDTH) - 30) / CHAR_WIDTH));
  const sub = svgEl('text', { class: 'sub', x: -w / 2 + 8, y: 6 });
  sub.textContent = nodeSubtitle(n.stats);
  g.append(title, glyph, label, sub);
  const spark = sparklinePath(n.stats.spark.count, SPARK_WIDTH, SPARK_HEIGHT);
  if (spark && n.stats.count) {
    g.append(svgEl('path', { class: 'spark', d: spark, transform: `translate(${-w / 2 + 8},${h / 2 - SPARK_HEIGHT - 4})` }));
  }
  selectable(g, sel, nodeAriaLabel(n));
  return g;
}

function renderGraph(): void {
  if (!model || !layout) {
    viewport.replaceChildren();
    return;
  }
  const maxCount = Math.max(0, ...model.edges.map((e) => e.stats.count));
  const edges = svgEl('g', { class: 'edges' });
  for (const e of model.edges) {
    const g = renderEdge(e, maxCount);
    if (g) edges.append(g);
  }
  const nodes = svgEl('g', { class: 'nodes' });
  for (const n of model.nodes) {
    const g = renderNode(n);
    if (g) nodes.append(g);
  }
  const focused = document.activeElement?.closest('[data-key]')?.getAttribute('data-key');
  viewport.replaceChildren(arrowDefs(), edges, nodes);
  // Keep keyboard focus across live re-renders.
  if (focused) {
    for (const t of viewport.querySelectorAll<SVGElement>('[data-key]')) {
      if (t.getAttribute('data-key') === focused) {
        t.focus();
        break;
      }
    }
  }
}

// --- Details ----------------------------------------------------------------------------

function statGrid(rows: [string, string][]): HTMLElement {
  const dl = el('dl', 'stats');
  for (const [k, v] of rows) dl.append(el('dt', undefined, k), el('dd', undefined, v));
  return dl;
}

function section(title: string, ...children: Node[]): HTMLElement {
  const s = el('section');
  s.append(el('h3', undefined, title), ...children);
  return s;
}

function statsRows(s: ModelNode['stats'] | ModelEdge['stats'], range: string): [string, string][] {
  const rows: [string, string][] = [[`Calls (${range})`, formatCalls(s.count)]];
  if (s.ratePerMin !== undefined) rows.push(['Rate', formatRate(s.ratePerMin)]);
  rows.push(
    ['Errors', s.errors ? `${s.errors} (${formatPercent(s.errorRate)})` : '0'],
    ['p50', formatMs(s.p50)],
    ['p95', formatMs(s.p95)]
  );
  return rows;
}

function linkButton(text: string, title: string, onClick: () => void, cls = 'link'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function depList(edges: ModelEdge[], end: 'source' | 'target'): HTMLElement {
  if (!edges.length) return el('div', 'muted', 'None');
  const ul = el('ul', 'list');
  for (const e of edges) {
    const id = e[end];
    const n = nodeById(id);
    const li = el('li');
    li.append(
      el('span', `glyph health-${e.health}`, HEALTH_GLYPH[e.health]),
      linkButton(n?.label ?? id, `Select ${n?.label ?? id}`, () => select({ kind: 'node', id }, true)),
      el('span', 'muted', ` ${edgeLabel(e.stats)} · p95 ${formatMs(e.stats.p95)}`)
    );
    ul.append(li);
  }
  return ul;
}

function traceList(list: TraceList, refs: TraceRef[]): HTMLElement {
  if (!refs.length) return el('div', 'muted', 'None in this window');
  const ul = el('ul', 'list');
  refs.forEach((t, index) => {
    const li = el('li');
    li.append(
      linkButton(t.name || t.spanId, `Open trace ${t.traceId}`, () =>
        post({ type: 'revealTrace', seq: renderedSeq, list, index })
      ),
      el('span', 'muted', ` ${formatMs(t.durationMs)} · ${timeOfDay(t.startMs)}${t.error ? ' · error' : ''}`)
    );
    ul.append(li);
  });
  return ul;
}

function renderDetails(): void {
  const sel = state.selection;
  const node = sel?.kind === 'node' ? nodeById(sel.id) : undefined;
  const edge =
    sel?.kind === 'edge' ? model?.edges.find((e) => e.source === sel.source && e.target === sel.target) : undefined;
  if (!model || (!node && !edge)) {
    detailsEl.hidden = true;
    detailsEl.replaceChildren();
    return;
  }
  detailsEl.hidden = false;
  const range = rangeSel.selectedOptions[0]?.textContent ?? state.range;
  const d = details && sameSelection(details.selection, sel) ? details : null;
  renderedSeq = seq;

  const head = el('header');
  const health = (node ?? edge)!.health;
  const title = node
    ? node.label
    : `${nodeById(edge!.source)?.label ?? edge!.source} → ${nodeById(edge!.target)?.label ?? edge!.target}`;
  head.append(
    el('span', `glyph health-${health}`, HEALTH_GLYPH[health]),
    el('h2', undefined, title),
    linkButton('×', 'Close details (Esc)', () => select(null), 'close')
  );
  const parts: Node[] = [head, el('div', 'muted', `${node ? node.type : 'call'} · ${HEALTH_LABEL[health]}`)];

  const s = (node ?? edge)!.stats;
  const rows = statsRows(s, range);
  if (node?.stats.lastSeenMs) rows.push(['Last call', timeOfDay(node.stats.lastSeenMs)]);
  parts.push(statGrid(rows));

  if (node?.type === 'service') {
    const actions = el('div', 'actions');
    for (const [target, text] of [
      ['traces', 'Traces'],
      ['logs', 'Logs'],
      ['metrics', 'Metrics'],
    ] as [OpenTarget, string][]) {
      actions.append(linkButton(text, `Open ${text.toLowerCase()} for ${node.label}`, () => post({ type: 'open', target }), 'secondary'));
    }
    parts.push(actions);
  }

  if (node) {
    parts.push(
      section('Called by', depList(model.edges.filter((e) => e.target === node.id), 'source')),
      section('Calls', depList(model.edges.filter((e) => e.source === node.id), 'target'))
    );
  }

  if (!d) {
    parts.push(el('div', 'muted loading', 'Loading details…'));
  } else {
    if (d.operations.length) {
      const table = el('table');
      const hr = el('tr');
      for (const h of ['Operation', 'Calls', 'Err', 'p95']) hr.append(el('th', undefined, h));
      table.append(hr);
      for (const o of d.operations) {
        const tr = el('tr');
        tr.append(
          el('td', 'op', o.name),
          el('td', 'num', formatCount(o.count)),
          el('td', 'num', o.errors ? formatPercent(o.errorRate) : '–'),
          el('td', 'num', formatMs(o.p95))
        );
        tr.firstElementChild!.setAttribute('title', o.name);
        table.append(tr);
      }
      parts.push(section('Operations', table));
    }
    parts.push(section('Recent errors', traceList('error', d.errorTraces)), section('Slowest', traceList('slow', d.slowTraces)));
    if (d.sources.length) {
      const ul = el('ul', 'list');
      d.sources.forEach((src, index) => {
        const loc = src.location;
        const li = el('li');
        li.append(
          linkButton(`${basename(loc.filepath)}${loc.line ? `:${loc.line}` : ''}`, loc.filepath, () =>
            post({ type: 'openSource', seq: renderedSeq, index })
          ),
          el('span', 'muted', ` ${loc.function ? `${loc.function} · ` : ''}${formatCount(src.count)}×`)
        );
        ul.append(li);
      });
      parts.push(section('Source', ul));
    }
  }
  detailsEl.replaceChildren(...parts);
}

// --- Messages ---------------------------------------------------------------------------

function renderEmpty(): void {
  const hasNodes = !!model && model.nodes.length > 0;
  let text = '';
  if (banner && (banner.kind === 'gone' || !hasNodes)) text = banner.text;
  else if (model && !hasNodes) text = 'No traces yet. Send distributed traces (e.g. HTTP calls) to populate the map.';
  emptyEl.hidden = !text;
  emptyEl.textContent = text;
  emptyEl.classList.toggle('error', banner?.kind === 'error');

  let note = '';
  if (banner?.kind === 'error' && hasNodes) note = `${banner.text} Showing the last good map.`;
  else if (!banner && hasNodes && model!.nodes.every((n) => n.stats.count === 0)) {
    const range = (rangeSel.selectedOptions[0]?.textContent ?? '').toLowerCase();
    note = `No calls in the ${range}. Newest data at ${timeOfDay(model!.anchorMs)}.`;
  }
  noteEl.hidden = !note;
  noteEl.textContent = note;
  noteEl.classList.toggle('error', banner?.kind === 'error');
}

function render(): void {
  renderToolbar();
  // Details first: opening the side panel narrows the map, and fit() must see the final size.
  renderDetails();
  if (model && banner?.kind !== 'gone') {
    const key = topologyKey(model.nodes, model.edges);
    if (key !== layoutKey || !layout) {
      layout = layoutGraph(model.nodes, model.edges);
      layoutKey = key;
      if (!view || autoFit) fit();
    }
  } else {
    layout = null;
    layoutKey = '';
  }
  applyView();
  renderGraph();
  renderEmpty();
}

function scheduleRender(): void {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }
}

function renderableSelection(sel: MapSelection): boolean {
  if (sel.kind === 'node') return !!nodeById(sel.id);
  return !!model?.edges.some((e) => e.source === sel.source && e.target === sel.target);
}

// State updates apply immediately; DOM work is batched into one frame.
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HostMessage;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'update': {
      const sig = JSON.stringify(msg);
      if (sig === lastSig && !banner) return;
      lastSig = sig;
      banner = null;
      model = msg.model;
      seq = msg.seq;
      details = msg.details;
      if (state.selection && !renderableSelection(state.selection)) {
        state.selection = null;
        details = null;
        persist();
      }
      break;
    }
    case 'gone':
      banner = { kind: 'gone', text: 'This session was unloaded, so its service map is no longer available.' };
      model = null;
      details = null;
      lastSig = '';
      break;
    case 'error':
      banner = { kind: 'error', text: `Could not build the service map: ${String(msg.message)}` };
      break;
    case 'timeZone':
      localTime = msg.useLocalTime;
      break;
    default:
      return;
  }
  scheduleRender();
});

// Window resizes and the details panel opening or closing both change the map's size.
new ResizeObserver(() => {
  if (autoFit) fit();
}).observe(wrap);

post({ type: 'ready', range: state.range, selection: state.selection });
