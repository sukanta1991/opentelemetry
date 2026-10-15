// SPDX-License-Identifier: Apache-2.0
// Service map webview app. Telemetry strings reach the DOM only through textContent/attributes.

import type { MetricDelta } from '../baselineCompare';
import type { BaselineInfo, ColorMode } from '../baselineMap';
import type { Health, MapSelection, ModelEdge, ModelNode, NodeDetails, ServiceMapModel, TraceRef } from '../serviceMapModel';
import { formatTimestamp } from '../format';
import { Layout, MAX_NODE_WIDTH, edgeKey, layoutGraph, topologyKey } from './serviceMapLayout';
import {
  HEALTH_GLYPH,
  HEALTH_LABEL,
  HostMessage,
  LABEL_MIN_SCALE,
  OpenTarget,
  TraceList,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  ViewMessage,
  ViewTransform,
  baselineBadge,
  basename,
  bucketEndMs,
  centerOn,
  coverageNote,
  deltaAriaLabel,
  deltaLabel,
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
  metricDeltaText,
  nodeAriaLabel,
  nodeDeltaSubtitle,
  nodeSubtitle,
  sameSelection,
  signedPercent,
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
const SUB_CHAR_WIDTH = 6.3;
const SPARK_WIDTH = 64;
const SPARK_HEIGHT = 10;
const ACTIVITY_WIDTH = 300;
const ACTIVITY_HEIGHT = 36;
const DRAG_THRESHOLD_PX = 3;
const PERSIST_DELAY_MS = 300;
const HEALTHS: Health[] = ['ok', 'warn', 'critical', 'idle'];
const LEGEND_VERDICTS = ['regressed', 'improved', 'unchanged', 'new', 'removed', 'insufficient'] as const;

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
// The host owns the effective mode; the webview only remembers what the user picked.
let colorMode: ColorMode = state.colorMode ?? 'absolute';
let baseline: BaselineInfo | null = null;
let hasBaseline = false;
let readOnly = false;

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
const rangePicker = byId<HTMLSpanElement>('rangePicker');
const asOfEl = byId<HTMLSpanElement>('asOf');
const partialEl = byId<HTMLSpanElement>('partial');
const hiddenEl = byId<HTMLSpanElement>('hiddenNodes');
const modeBtn = byId<HTMLButtonElement>('mode');
const baselineBadgeEl = byId<HTMLSpanElement>('baselineBadge');
const coverageEl = byId<HTMLSpanElement>('coverage');
const legendEl = byId<HTMLSpanElement>('legend');

function post(msg: ViewMessage): void {
  vscode.postMessage(msg);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(
    () =>
      vscode.setState({ range: state.range, selection: state.selection, view: autoFit ? null : view, colorMode: state.colorMode }),
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

// Verdict colours only once there is something to compare; while waiting the map keeps health colours.
function comparing(): boolean {
  return colorMode === 'baseline' && !!baseline && !baseline.waiting;
}

function colourClass(health: Health, item: { cmp?: { verdict: string } }): string {
  if (!comparing()) return `health-${health}`;
  return item.cmp ? `verdict-${item.cmp.verdict}` : 'verdict-none';
}

function colourGlyph(health: Health, item: { cmp?: { verdict: keyof typeof VERDICT_GLYPH } }): string {
  if (!comparing()) return HEALTH_GLYPH[health];
  return item.cmp ? VERDICT_GLYPH[item.cmp.verdict] : '○';
}

function colourLabel(health: Health, item: { cmp?: { verdict: keyof typeof VERDICT_LABEL } }): string {
  if (!comparing()) return HEALTH_LABEL[health];
  return item.cmp ? VERDICT_LABEL[item.cmp.verdict] : 'Not compared';
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
modeBtn.addEventListener('click', () => {
  colorMode = colorMode === 'baseline' ? 'absolute' : 'baseline';
  state.colorMode = colorMode;
  persist();
  post({ type: 'setColorMode', colorMode });
  scheduleRender();
});
byId<HTMLButtonElement>('baselineMenu').addEventListener('click', () => post({ type: 'baselineMenu' }));

function legendItem(cls: string, glyph: string, text: string): HTMLElement {
  const s = el('span', cls);
  s.append(el('span', 'glyph', glyph), document.createTextNode(` ${text}`));
  return s;
}

function renderToolbar(): void {
  asOfEl.textContent = model && model.nodes.length ? `as of ${timeOfDay(model.anchorMs)}` : '';
  partialEl.hidden = !model?.partial;
  if (model?.partial) {
    partialEl.title = `Only ${formatMs(model.effectiveWindowMs)} of data is retained or received for this window; rates use that span.`;
  }
  hiddenEl.hidden = !model?.hiddenNodes;
  hiddenEl.textContent = model?.hiddenNodes ? `${model.hiddenNodes} hidden` : '';
  hiddenEl.title = 'Least-called dependencies hidden to keep the map readable.';

  rangePicker.hidden = readOnly;
  modeBtn.hidden = !hasBaseline;
  modeBtn.setAttribute('aria-pressed', String(colorMode === 'baseline'));
  const shown = colorMode === 'baseline' && baseline ? baseline : null;
  baselineBadgeEl.hidden = !shown;
  if (shown) {
    const b = baselineBadge(shown, timeOfDay);
    baselineBadgeEl.textContent = b.text;
    baselineBadgeEl.title = b.title;
  }
  const coverage = shown && coverageNote(shown);
  coverageEl.hidden = !coverage;
  if (coverage) {
    coverageEl.textContent = coverage.text;
    coverageEl.title = coverage.title;
  }
  legendEl.replaceChildren(
    ...(comparing()
      ? LEGEND_VERDICTS.map((v) => legendItem(`verdict-${v}`, VERDICT_GLYPH[v], VERDICT_LABEL[v]))
      : HEALTHS.map((h) => legendItem(`health-${h}`, HEALTH_GLYPH[h], HEALTH_LABEL[h])))
  );
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
  const classes = [...HEALTHS.map((h) => `health-${h}`), ...Object.keys(VERDICT_GLYPH).map((v) => `verdict-${v}`), 'verdict-none'];
  for (const cls of classes) {
    const m = svgEl('marker', {
      id: `arrow-${cls}`,
      markerWidth: 10,
      markerHeight: 10,
      refX: 9,
      refY: 3,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    });
    m.append(svgEl('path', { d: 'M0,0 L0,6 L9,3 z', class: `arrow ${cls}` }));
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
  const cls = colourClass(e.health, e);
  const g = svgEl('g', { class: `edge-group ${cls}` });
  if (e.ghost) g.classList.add('ghost');
  if (sameSelection(sel, state.selection)) g.classList.add('selected');
  g.append(
    svgEl('path', {
      class: 'edge',
      d: geo.d,
      'stroke-width': edgeWidth(e.stats.count, maxCount).toFixed(2),
      'marker-end': `url(#arrow-${cls})`,
    }),
    svgEl('path', { class: 'edge-hit', d: geo.d })
  );
  const delta = comparing() && e.cmp;
  const label = svgEl('text', { class: 'edge-label', x: geo.labelX, y: geo.labelY - 4, 'text-anchor': 'middle' });
  label.textContent = delta ? deltaLabel(delta) : edgeLabel(e.stats);
  g.append(label);
  const src = nodeById(e.source)?.label ?? e.source;
  const dst = nodeById(e.target)?.label ?? e.target;
  selectable(
    g,
    sel,
    delta
      ? deltaAriaLabel(`${src} to ${dst}`, 'call', delta, e.opChanges)
      : `${src} to ${dst}, ${HEALTH_LABEL[e.health]}, ${edgeLabel(e.stats)}, p95 ${formatMs(e.stats.p95)}`
  );
  return g;
}

function renderNode(n: ModelNode): SVGGElement | undefined {
  const b = layout!.boxes.get(n.id);
  if (!b) return undefined;
  const sel: MapSelection = { kind: 'node', id: n.id };
  const g = svgEl('g', { class: `node ${n.type} ${colourClass(n.health, n)}`, transform: `translate(${b.x},${b.y})` });
  if (n.ghost) g.classList.add('ghost');
  if (sameSelection(sel, state.selection)) g.classList.add('selected');
  const w = b.width;
  const h = b.height;
  const rx = n.type === 'service' ? 4 : n.type === 'database' ? 18 : 10;
  g.append(svgEl('rect', { class: 'shape', x: -w / 2, y: -h / 2, width: w, height: h, rx }));
  const title = svgEl('title');
  title.textContent = comparing() && n.cmp ? `${n.label} (${n.type}): ${nodeDeltaSubtitle(n)}` : `${n.label} (${n.type})`;
  const glyph = svgEl('text', { class: 'glyph', x: -w / 2 + 8, y: -9 });
  glyph.textContent = colourGlyph(n.health, n);
  const label = svgEl('text', { class: 'label', x: -w / 2 + 22, y: -9 });
  label.textContent = truncateLabel(n.label, Math.floor((Math.min(w, MAX_NODE_WIDTH) - 30) / CHAR_WIDTH));
  const sub = svgEl('text', { class: 'sub', x: -w / 2 + 8, y: 6 });
  sub.textContent = truncateLabel(comparing() ? nodeDeltaSubtitle(n) : nodeSubtitle(n.stats), Math.floor((w - 16) / SUB_CHAR_WIDTH));
  g.append(title, glyph, label, sub);
  const spark = sparklinePath(n.stats.spark.count, SPARK_WIDTH, SPARK_HEIGHT);
  if (spark && n.stats.count) {
    g.append(svgEl('path', { class: 'spark', d: spark, transform: `translate(${-w / 2 + 8},${h / 2 - SPARK_HEIGHT - 4})` }));
  }
  selectable(g, sel, comparing() && n.cmp ? deltaAriaLabel(n.label, n.type, n.cmp, n.opChanges) : nodeAriaLabel(n));
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

function statGrid(rows: [string, string, string?][]): HTMLElement {
  const dl = el('dl', 'stats');
  for (const [k, v, title] of rows) {
    const dd = el('dd', undefined, v);
    if (title) dd.title = title;
    dl.append(el('dt', undefined, k), dd);
  }
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
      el('span', `glyph ${colourClass(e.health, e)}`, colourGlyph(e.health, e)),
      linkButton(n?.label ?? id, `Select ${n?.label ?? id}`, () => select({ kind: 'node', id }, true)),
      el('span', 'muted', ` ${comparing() && e.cmp ? deltaLabel(e.cmp) : `${edgeLabel(e.stats)} · p95 ${formatMs(e.stats.p95)}`}`)
    );
    ul.append(li);
  }
  return ul;
}

function changeRow(label: string, m: MetricDelta | undefined, kind: 'ms' | 'rate' | 'ratio'): [string, string, string?] | undefined {
  if (!m || (m.base === null && m.current === null)) return undefined;
  const mark = m.change === 'regressed' ? ` ${VERDICT_GLYPH.regressed}` : m.change === 'improved' ? ` ${VERDICT_GLYPH.improved}` : '';
  const title = m.q !== undefined ? `Adjusted p-value (q) ${m.q.toPrecision(2)}; changes count when q < 0.05 and the change passes the minimums.` : undefined;
  return [label, `${metricDeltaText(m, kind)}${mark}`, title];
}

function baselineSection(d: NodeDetails): HTMLElement[] {
  const c = d.cmp;
  if (!c || !comparing()) return [];
  const rows: [string, string, string?][] = [
    ['Verdict', `${VERDICT_GLYPH[c.verdict]} ${VERDICT_LABEL[c.verdict]}`],
    ['Calls', `${formatCount(c.base?.count ?? 0)} → ${formatCount(c.current?.count ?? 0)}`],
  ];
  for (const r of [
    changeRow('p50', c.p50, 'ms'),
    changeRow('p95', c.p95, 'ms'),
    changeRow('Errors', c.errorRate, 'rate'),
    changeRow('Calls per request', c.fanout, 'ratio'),
  ]) {
    if (r) rows.push(r);
  }
  const parts: HTMLElement[] = [statGrid(rows)];
  if (c.verdict === 'insufficient') {
    parts.push(el('div', 'muted', 'Too few calls on one side for a reliable comparison. Exercise this path more, or lower otel.serviceMap.baseline.minSamples.'));
  }
  const out = [section(baseline?.against ? `Before → after (${baseline.name} → ${baseline.against})` : `Compared with “${baseline?.name ?? ''}”`, ...parts)];
  const traces = d.baselineTraces ?? [];
  if (traces.length) {
    const ul = el('ul', 'list');
    traces.forEach((id, index) => {
      const li = el('li');
      li.append(linkButton(id.slice(0, 16), `Open baseline trace ${id}`, () => post({ type: 'revealTrace', seq: renderedSeq, list: 'baseline', index })));
      ul.append(li);
    });
    out.push(section('Baseline examples', ul));
  }
  return out;
}

function operationsTable(d: NodeDetails): HTMLElement {
  const compared = comparing() && d.operations.some((o) => o.cmp);
  const table = el('table');
  const hr = el('tr');
  for (const h of compared ? ['', 'Operation', 'Calls', 'p95', 'Δ p95'] : ['Operation', 'Calls', 'Err', 'p95']) hr.append(el('th', undefined, h));
  table.append(hr);
  for (const o of d.operations) {
    const tr = el('tr');
    if (compared && o.cmp) {
      const v = o.cmp.verdict;
      const glyph = el('td', `glyph verdict-${v}`, VERDICT_GLYPH[v]);
      glyph.title = VERDICT_LABEL[v];
      glyph.setAttribute('aria-label', VERDICT_LABEL[v]);
      tr.append(
        glyph,
        el('td', 'op', o.name),
        el('td', 'num', o.count ? formatCount(o.count) : '–'),
        el('td', 'num', formatMs(o.p95)),
        el('td', 'num', signedPercent(o.cmp.p95.base, o.cmp.p95.current) || '–')
      );
      tr.title = `${o.name}: ${VERDICT_LABEL[v]}; p95 ${metricDeltaText(o.cmp.p95, 'ms')}; errors ${metricDeltaText(o.cmp.errorRate, 'rate')}`;
    } else {
      tr.append(
        el('td', 'op', o.name),
        el('td', 'num', formatCount(o.count)),
        el('td', 'num', o.errors ? formatPercent(o.errorRate) : '–'),
        el('td', 'num', formatMs(o.p95))
      );
      tr.querySelector('.op')!.setAttribute('title', o.name);
    }
    table.append(tr);
  }
  return table;
}

// Bars per sparkline bucket; clicking one captures a baseline up to the end of that bucket.
function activitySection(node: ModelNode): HTMLElement | undefined {
  const counts = node.stats.spark.count;
  if (readOnly || !model || !node.stats.count || !counts.length) return undefined;
  const max = Math.max(...counts, 1);
  const w = ACTIVITY_WIDTH / counts.length;
  const chart = svgEl('svg', { class: 'activity', width: ACTIVITY_WIDTH, height: ACTIVITY_HEIGHT, role: 'img' });
  chart.setAttribute('aria-label', `Calls over the window for ${node.label}`);
  counts.forEach((c, index) => {
    const h = Math.max(1, (c / max) * (ACTIVITY_HEIGHT - 2));
    const bar = svgEl('rect', { class: 'bar', x: index * w + 0.5, y: ACTIVITY_HEIGHT - h, width: Math.max(1, w - 1), height: h });
    const t = svgEl('title');
    t.textContent = `Up to ${timeOfDay(bucketEndMs(model!, index))}: ${formatCalls(c)}. Click to capture a baseline up to here.`;
    bar.append(t);
    bar.addEventListener('click', () => post({ type: 'captureAtBucket', seq: renderedSeq, index }));
    chart.append(bar);
  });
  return section('Activity', chart, el('div', 'muted', 'Click a bar to capture a baseline up to that time (or use Baseline ▸ Capture up to a time).'));
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
  const item = (node ?? edge)!;
  const title = node
    ? node.label
    : `${nodeById(edge!.source)?.label ?? edge!.source} → ${nodeById(edge!.target)?.label ?? edge!.target}`;
  head.append(
    el('span', `glyph ${colourClass(item.health, item)}`, colourGlyph(item.health, item)),
    el('h2', undefined, title),
    linkButton('×', 'Close details (Esc)', () => select(null), 'close')
  );
  const parts: Node[] = [head, el('div', 'muted', `${node ? node.type : 'call'} · ${colourLabel(item.health, item)}`)];

  const s = item.stats;
  const rows = statsRows(s, readOnly ? `“${baseline?.against ?? 'after'}”` : range);
  if (node?.stats.lastSeenMs) rows.push(['Last call', timeOfDay(node.stats.lastSeenMs)]);
  parts.push(statGrid(rows));

  if (node?.type === 'service' && !readOnly && !node.ghost) {
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
  if (d) parts.push(...baselineSection(d));

  if (node) {
    parts.push(
      section('Called by', depList(model.edges.filter((e) => e.target === node.id), 'source')),
      section('Calls', depList(model.edges.filter((e) => e.source === node.id), 'target'))
    );
    const activity = activitySection(node);
    if (activity) parts.push(activity);
  }

  if (!d) {
    parts.push(el('div', 'muted loading', 'Loading details…'));
  } else {
    if (d.operations.length) parts.push(section('Operations', operationsTable(d)));
    if (!readOnly) {
      parts.push(section('Recent errors', traceList('error', d.errorTraces)), section('Slowest', traceList('slow', d.slowTraces)));
    }
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
  else if (!banner && hasNodes && colorMode === 'baseline' && baseline?.waiting) {
    note = `Waiting for calls after ${timeOfDay(baseline.cutoffMs ?? model!.anchorMs)} to compare with “${baseline.name}”.`;
  } else if (!banner && hasNodes && model!.nodes.every((n) => n.stats.count === 0)) {
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
  // The VS Code host frame posts with targetOrigin = its own origin, which is ours.
  if (e.origin !== window.origin) return;
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
      colorMode = msg.colorMode;
      baseline = msg.baseline;
      hasBaseline = msg.hasBaseline;
      readOnly = msg.readOnly;
      if (state.selection && !renderableSelection(state.selection)) {
        state.selection = null;
        details = null;
        persist();
      }
      break;
    }
    case 'gone':
      banner = {
        kind: 'gone',
        text: readOnly
          ? 'One of the compared baselines was deleted, so this comparison is no longer available.'
          : 'This session was unloaded, so its service map is no longer available.',
      };
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

post(
  state.colorMode
    ? { type: 'ready', range: state.range, selection: state.selection, colorMode: state.colorMode }
    : { type: 'ready', range: state.range, selection: state.selection }
);
