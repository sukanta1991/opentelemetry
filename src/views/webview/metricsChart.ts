// Bundled webview app for the Metrics panel. Built by esbuild into dist/webview/metricsChart.js
// and loaded by MetricsPanel. Owns the toolbar, table view, and uPlot graph view.
import uPlot from 'uplot';
import {
  AGG_LABEL,
  AggKind,
  aggsFor,
  bucketSecondsFor,
  CHART_OPTIONS,
  ChartKind,
  chartKindsFor,
  DEFAULT_RANGE,
  isAggKind,
  isChartKind,
  isRangeKind,
  isReduceKind,
  isStepKind,
  niceBucketSeconds,
  PresentedType,
  RANGE_LABEL,
  RANGE_OPTIONS,
  RANGE_SECONDS,
  RangeKind,
  REDUCE_LABEL,
  REDUCE_OPTIONS,
  ReduceKind,
  STEP_LABEL,
  STEP_OPTIONS,
  STEP_SECONDS,
  StepKind,
  DEFAULT_STEP,
} from './chartTypes';
import { computeRate, stack } from './transforms';
import {
  bucketAxis,
  bucketSeries,
  hasIsolatedPoints,
  medianInterval,
  reduceAcrossSeries,
  windowSeries,
} from './stats';

interface LineGraph {
  kind: 'line';
  xs: number[]; // seconds
  series: { label: string; ys: (number | null)[] }[];
}
interface BarGraph {
  kind: 'bar';
  categories: string[];
  values: number[];
}
interface BucketData {
  bounds: number[];
  counts: number[];
  sum?: number;
  count?: number;
}

interface MetricVM {
  name: string;
  type: string;
  presentedType: PresentedType;
  monotonic?: boolean;
  unit: string;
  description: string;
  points: { labels: string; value: string }[];
  line?: LineGraph;
  bars?: BarGraph;
  buckets?: BucketData;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const KIND_LABEL: Record<ChartKind, string> = {
  line: 'Line',
  area: 'Area',
  'stacked-area': 'Stacked area',
  rate: 'Rate',
  bar: 'Bar',
  gauge: 'Gauge',
  histogram: 'Histogram',
  percentile: 'Percentile',
  table: 'Table',
};

type XRange = [number, number];

let metrics: MetricVM[] = [];
let view: 'table' | 'graph' = 'table';
// One active uPlot per metric card, so a single card can re-render on its own.
// `sig` gates the setData fast path; `xRange` is a mutable box the chart's x-scale
// closure reads, so the window can slide without rebuilding the plot.
interface CardChart {
  chart: uPlot;
  sig: string;
  xRange: XRange;
}
const chartByMetric = new Map<string, CardChart>();
// Per-metric chart/aggregation/reduce choices, persisted across panel reloads.
interface Selection {
  chart?: ChartKind;
  agg?: AggKind;
  reduce?: ReduceKind;
}
interface PanelState {
  selections?: Record<string, unknown>;
  range?: unknown;
  step?: unknown;
  query?: unknown;
  view?: unknown;
}
const savedState = (vscode.getState() as PanelState | null) ?? {};
const selections = new Map<string, Selection>(loadSelections(savedState.selections));
// The trailing window every graph shares.
let range: RangeKind = isRangeKind(savedState.range) ? savedState.range : DEFAULT_RANGE;
// The bucket width every over-time aggregation shares.
let step: StepKind = isStepKind(savedState.step) ? savedState.step : DEFAULT_STEP;


const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = el<HTMLInputElement>('q');
const count = el<HTMLElement>('count');
const empty = el<HTMLElement>('empty');
const tbody = el<HTMLTableSectionElement>('tbody');
const tableWrap = el<HTMLElement>('tableWrap');
const graphWrap = el<HTMLElement>('graphWrap');
const chartsEl = el<HTMLElement>('charts');
const btnTable = el<HTMLButtonElement>('viewTable');
const btnGraph = el<HTMLButtonElement>('viewGraph');
const rangePicker = el<HTMLElement>('rangePicker');
const rangeSel = el<HTMLSelectElement>('range');
const stepPicker = el<HTMLElement>('stepPicker');
const stepSel = el<HTMLSelectElement>('step');
const retentionHint = el<HTMLElement>('retentionHint');
const retentionHintText = el<HTMLElement>('retentionHintText');
const retentionSetting = el<HTMLButtonElement>('retentionSetting');

function esc(s: unknown): string {
  return s == null
    ? ''
    : String(s).replace(
        /[&<>"']/g,
        (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
      );
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

// Palette drawn from VS Code chart theme tokens; adapts to light/dark automatically.
function palette(): string[] {
  return [
    cssVar('--vscode-charts-blue', '#4e95d9'),
    cssVar('--vscode-charts-green', '#5ba552'),
    cssVar('--vscode-charts-orange', '#d9822b'),
    cssVar('--vscode-charts-purple', '#9a72c6'),
    cssVar('--vscode-charts-red', '#d9534f'),
    cssVar('--vscode-charts-yellow', '#d9c441'),
  ];
}

function filtered(): MetricVM[] {
  const f = q.value.toLowerCase();
  return metrics.filter((m) => !f || m.name.toLowerCase().includes(f));
}

function destroyChart(name: string): void {
  const entry = chartByMetric.get(name);
  if (!entry) return;
  try {
    entry.chart.destroy();
  } catch {
    /* ignore */
  }
  chartByMetric.delete(name);
}

function destroyCharts(): void {
  for (const name of Array.from(chartByMetric.keys())) destroyChart(name);
}

function loadSelections(saved: Record<string, unknown> | undefined): [string, Selection][] {
  if (!saved) return [];
  const out: [string, Selection][] = [];
  for (const [name, raw] of Object.entries(saved)) {
    // Migrate the old chart-only shape (a bare ChartKind string).
    if (isChartKind(raw)) {
      out.push([name, { chart: raw }]);
      continue;
    }
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const sel: Selection = {};
      if (isChartKind(r.chart)) sel.chart = r.chart;
      if (isAggKind(r.agg)) sel.agg = r.agg;
      // Migrate the retired `stat` readout choice onto the over-time aggregator.
      else if (typeof r.stat === 'string') {
        const migrated = r.stat === 'none' ? 'raw' : r.stat;
        if (isAggKind(migrated)) sel.agg = migrated;
      }
      if (isReduceKind(r.reduce)) sel.reduce = r.reduce;
      out.push([name, sel]);
    }
  }
  return out;
}

function persistState(): void {
  vscode.setState({
    selections: Object.fromEntries(selections),
    range,
    step,
    query: q.value,
    view,
  });
}

function setSelection(name: string, patch: Selection): void {
  selections.set(name, { ...selections.get(name), ...patch });
  persistState();
}

// The effective chart kind: the persisted choice if still valid, else the default.
function chartFor(m: MetricVM): ChartKind {
  const allowed = chartKindsFor(m.presentedType);
  const saved = selections.get(m.name)?.chart;
  return saved && allowed.includes(saved) ? saved : CHART_OPTIONS[m.presentedType].default;
}

function aggFor(m: MetricVM): AggKind {
  const saved = selections.get(m.name)?.agg;
  return saved && aggsFor(m.presentedType).includes(saved) ? saved : 'raw';
}

// Reduce-across-series only applies to scalar multi-series metrics.
function canReduce(m: MetricVM): boolean {
  return (
    !!m.line &&
    m.line.series.length > 1 &&
    (m.presentedType === 'counter' ||
      m.presentedType === 'updowncounter' ||
      m.presentedType === 'gauge' ||
      m.presentedType === 'unknown')
  );
}

function reduceFor(m: MetricVM): ReduceKind {
  if (!canReduce(m)) return 'none';
  const saved = selections.get(m.name)?.reduce;
  return saved && REDUCE_OPTIONS.includes(saved) ? saved : 'none';
}


function renderTable(rows: MetricVM[]): void {
  const scroll = tableWrap.scrollTop;
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of rows) {
    const tr = document.createElement('tr');
    const pts = m.points
      .map(
        (p) =>
          '<span class="pt"><span class="lbl">' +
          esc(p.labels || '(no labels)') +
          '</span> → ' +
          esc(p.value) +
          '</span>'
      )
      .join('');
    tr.innerHTML =
      '<td class="name" title="' +
      esc(m.description) +
      '">' +
      esc(m.name) +
      '</td>' +
      '<td><span class="type-badge">' +
      esc(m.type) +
      '</span></td>' +
      '<td class="muted">' +
      esc(m.unit) +
      '</td>' +
      '<td>' +
      pts +
      '</td>';
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (tableWrap.scrollTop !== scroll) tableWrap.scrollTop = scroll;
}

// The badges were dropped from the header to give the name full width; their content
// lives on here so nothing is lost.
function titleTooltip(m: MetricVM): string {
  const meta = [m.type, m.unit].filter(Boolean).join(' · ');
  return [m.name, meta, m.description].filter(Boolean).join('\n');
}

function makeCard(m: MetricVM): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('data-metric', m.name);
  card.setAttribute('data-head', headSig(m));
  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(makeHead(m));
  card.appendChild(body);
  return card;
}

// Everything about the header that is derived from the metric rather than from user
// choice. When this changes the header has to be rebuilt; otherwise it is left alone so
// an open dropdown survives a data push.
function headSig(m: MetricVM): string {
  return [m.presentedType, canReduce(m) ? '1' : '0', m.type, m.unit, m.description].join('|');
}

function syncCardHead(card: HTMLElement, m: MetricVM): void {
  const sig = headSig(m);
  if (card.getAttribute('data-head') === sig) return;
  card.setAttribute('data-head', sig);
  const head = card.querySelector('.card-head');
  if (head) card.replaceChild(makeHead(m), head);
}

function makeHead(m: MetricVM): HTMLElement {
  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = m.name;
  title.title = titleTooltip(m);
  const controls = document.createElement('div');
  controls.className = 'card-controls';
  controls.appendChild(makeSelect(m));
  const aggs = aggsFor(m.presentedType);
  if (aggs.length > 1) {
    controls.appendChild(makeAggSelect(m, aggs));
    const hint = document.createElement('span');
    hint.className = 'bucket-hint';
    controls.appendChild(hint);
  }
  if (canReduce(m)) controls.appendChild(makeReduceSelect(m));
  head.appendChild(title);
  head.appendChild(controls);
  return head;
}

// Chart-kind dropdown scoped to the metric's presented type (options from the registry).
function makeSelect(m: MetricVM): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'chart-select';
  sel.setAttribute('data-metric', m.name);
  sel.setAttribute('data-role', 'chart');
  sel.setAttribute('aria-label', 'Chart type for ' + m.name);
  const current = chartFor(m);
  for (const kind of chartKindsFor(m.presentedType)) {
    const opt = document.createElement('option');
    opt.value = kind;
    opt.textContent = KIND_LABEL[kind];
    if (kind === current) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

// Reduce-over-time dropdown; the bucket width comes from the panel-wide range.
function makeAggSelect(m: MetricVM, aggs: AggKind[]): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'chart-select agg-select';
  sel.setAttribute('data-metric', m.name);
  sel.setAttribute('data-role', 'agg');
  sel.setAttribute('aria-label', 'Aggregate over time for ' + m.name);
  const current = aggFor(m);
  for (const agg of aggs) {
    const opt = document.createElement('option');
    opt.value = agg;
    opt.textContent = AGG_LABEL[agg];
    if (agg === current) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

// Reduce-across-series dropdown (only rendered for scalar multi-series metrics).
function makeReduceSelect(m: MetricVM): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'chart-select reduce-select';
  sel.setAttribute('data-metric', m.name);
  sel.setAttribute('data-role', 'reduce');
  sel.setAttribute('aria-label', 'Reduce series for ' + m.name);
  const current = reduceFor(m);
  for (const reduce of REDUCE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = reduce;
    opt.textContent = REDUCE_LABEL[reduce];
    if (reduce === current) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function containerWidth(container: HTMLElement): number {
  return Math.max(120, Math.floor(container.getBoundingClientRect().width) || 320);
}

// Abbreviate axis numbers (100000 -> "100k") so the y-axis gutter never clips labels.
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return trimZero(n / 1e9) + 'G';
  if (abs >= 1e6) return trimZero(n / 1e6) + 'M';
  if (abs >= 1e3) return trimZero(n / 1e3) + 'k';
  return String(Math.round(n * 1000) / 1000);
}
function trimZero(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

// Compact, reliably-truncating legend rendered below the chart (uPlot's table legend
// collapses long attribute labels). Full text is available on hover.
function renderLegend(container: HTMLElement, series: { label: string }[], colors: string[]): void {
  const legend = document.createElement('div');
  legend.className = 'legend';
  series.forEach((s, i) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.title = s.label;
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = colors[i % colors.length];
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = s.label;
    item.appendChild(swatch);
    item.appendChild(label);
    legend.appendChild(item);
  });
  container.appendChild(legend);
}

// Convert a solid stroke color to a translucent fill for area charts.
function toFill(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((x) => x + x)
        .join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return c;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  return c;
}

function latest(ys: (number | null)[]): number | null {
  for (let i = ys.length - 1; i >= 0; i--) if (ys[i] != null) return ys[i];
  return null;
}

type SeriesYs = (number | null)[];

// Point visibility is resolved per draw rather than baked in at construction, so a series
// that turns sparse (or stops being sparse) stays correct across an in-place setData.
const showPoints = (u: uPlot, seriesIdx: number): boolean =>
  hasIsolatedPoints(u.data[seriesIdx] as SeriesYs);

function lineData(g: LineGraph): uPlot.AlignedData {
  return [g.xs, ...g.series.map((s) => s.ys)] as uPlot.AlignedData;
}

// Largest band painted first so lower layers sit on top.
function stackedOrder(g: LineGraph): number[] {
  return g.series.map((_, i) => i).reverse();
}

function stackedData(g: LineGraph): uPlot.AlignedData {
  const bands = stack(g.series.map((s) => s.ys));
  return [g.xs, ...stackedOrder(g).map((i) => bands[i])] as uPlot.AlignedData;
}

function timeBarsData(g: LineGraph): uPlot.AlignedData {
  return [g.xs, g.xs.map((_, i) => g.series.reduce((sum, s) => sum + (s.ys[i] ?? 0), 0))];
}

function barData(g: BarGraph): uPlot.AlignedData {
  return [g.categories.map((_, i) => i), g.values];
}

function drawLine(
  container: HTMLElement,
  g: LineGraph,
  xRange: XRange,
  fillAlpha?: number
): uPlot {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const data = lineData(g);
  const opts: uPlot.Options = {
    width,
    height: 180,
    scales: { x: { time: true, range: () => xRange } },
    legend: { show: false },
    axes: [
      { stroke, grid: { stroke: grid }, ticks: { stroke: grid } },
      { stroke, size: 52, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, splits) => splits.map(fmtCompact) },
    ],
    series: [
      {},
      ...g.series.map((s, i) => ({
        label: s.label || 'value',
        stroke: colors[i % colors.length],
        ...(fillAlpha != null ? { fill: toFill(colors[i % colors.length], fillAlpha) } : {}),
        width: 1.5,
        points: { show: showPoints },
      })),
    ],
  };
  const chart = new uPlot(opts, data, container);
  if (g.series.length > 1) renderLegend(container, g.series, colors);
  return chart;
}

// Stacked cumulative bands (largest painted first so lower layers sit on top).
function drawStackedArea(container: HTMLElement, g: LineGraph, xRange: XRange): uPlot {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const data = stackedData(g);
  const opts: uPlot.Options = {
    width,
    height: 180,
    scales: { x: { time: true, range: () => xRange } },
    legend: { show: false },
    axes: [
      { stroke, grid: { stroke: grid }, ticks: { stroke: grid } },
      { stroke, size: 52, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, splits) => splits.map(fmtCompact) },
    ],
    series: [
      {},
      ...stackedOrder(g).map((i) => ({
        label: g.series[i].label || 'value',
        stroke: colors[i % colors.length],
        fill: toFill(colors[i % colors.length], 0.55),
        width: 1,
        points: { show: showPoints },
      })),
    ],
  };
  const chart = new uPlot(opts, data, container);
  if (g.series.length > 1) renderLegend(container, g.series, colors);
  return chart;
}

// Bars over the time axis. A reduced graph arrives as one series and is plotted as-is;
// otherwise label sets are summed into a single total.
function drawTimeBars(container: HTMLElement, g: LineGraph, xRange: XRange): uPlot {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const label =
    g.series.length > 1 ? `total (${g.series.length} series)` : g.series[0]?.label || 'value';
  const data = timeBarsData(g);
  const barsBuilder = (uPlot as unknown as {
    paths: { bars: (o: { size: [number, number] }) => uPlot.Series.PathBuilder };
  }).paths.bars({ size: [0.7, 60] });
  const opts: uPlot.Options = {
    width,
    height: 180,
    legend: { show: false },
    scales: { x: { time: true, range: () => xRange } },
    axes: [
      { stroke, grid: { stroke: grid }, ticks: { stroke: grid } },
      { stroke, size: 52, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, splits) => splits.map(fmtCompact) },
    ],
    series: [
      {},
      { label, stroke: colors[0], fill: toFill(colors[0], 0.6), paths: barsBuilder, points: { show: false } },
    ],
  };
  return new uPlot(opts, data, container);
}

// Numeric readout of the latest value per label set (no uPlot).
function drawGauge(container: HTMLElement, g: LineGraph, unit: string): null {
  const wrap = document.createElement('div');
  wrap.className = 'gauge-wrap';
  const single = g.series.length === 1;
  for (const s of g.series) {
    const v = latest(s.ys);
    const row = document.createElement('div');
    row.className = single ? 'gauge single' : 'gauge';
    const val = document.createElement('span');
    val.className = 'gauge-value';
    val.textContent = v == null ? '—' : String(Math.round(v * 1000) / 1000);
    row.appendChild(val);
    if (unit) {
      const u = document.createElement('span');
      u.className = 'gauge-unit';
      u.textContent = unit;
      row.appendChild(u);
    }
    if (!single) {
      const lbl = document.createElement('span');
      lbl.className = 'gauge-label';
      lbl.textContent = s.label;
      lbl.title = s.label;
      row.appendChild(lbl);
    }
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
  return null;
}

// Latest quantile values (summary) as a bar chart (p50/p95/… from q* series).
function quantileBars(g: LineGraph): BarGraph | null {
  const q = g.series
    .filter((s) => /^q[\d.]+/.test(s.label))
    .map((s) => ({ label: s.label.split(' · ')[0], value: latest(s.ys) }))
    .filter((s): s is { label: string; value: number } => s.value != null);
  if (!q.length) return null;
  return { kind: 'bar', categories: q.map((x) => x.label), values: q.map((x) => x.value) };
}

function drawPercentile(container: HTMLElement, g: LineGraph): uPlot | null {
  const bars = quantileBars(g);
  if (!bars) {
    container.innerHTML = '<div class="muted">No quantiles to plot</div>';
    return null;
  }
  return drawBar(container, bars);
}

// Per-card fallback table built from the summarized data points.
function renderMiniTable(container: HTMLElement, m: MetricVM): null {
  const rows = m.points
    .map(
      (p) =>
        '<tr><td class="muted">' +
        esc(p.labels || '(no labels)') +
        '</td><td>' +
        esc(p.value) +
        '</td></tr>'
    )
    .join('');
  container.innerHTML =
    '<table class="mini"><tbody>' +
    (rows || '<tr><td class="muted">No data points</td></tr>') +
    '</tbody></table>';
  return null;
}

function drawBar(container: HTMLElement, g: BarGraph): uPlot {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const data = barData(g);
  const barsBuilder = (uPlot as unknown as {
    paths: { bars: (o: { size: [number, number] }) => uPlot.Series.PathBuilder };
  }).paths.bars({ size: [0.7, 60] });
  const opts: uPlot.Options = {
    width,
    height: 180,
    legend: { show: false },
    scales: { x: { time: false } },
    axes: [
      {
        stroke,
        grid: { stroke: grid },
        ticks: { stroke: grid },
        values: (_u, splits) => splits.map((i) => g.categories[i] ?? ''),
      },
      { stroke, size: 52, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, splits) => splits.map(fmtCompact) },
    ],
    series: [
      {},
      { label: 'count', stroke: colors[0], fill: colors[0], paths: barsBuilder, points: { show: false } },
    ],
  };
  return new uPlot(opts, data, container);
}

// Render the selected chart kind for one metric into its card body.
function renderKind(
  kind: ChartKind,
  m: MetricVM,
  wline: LineGraph | undefined,
  body: HTMLElement,
  xRange: XRange
): uPlot | null {
  const noData = (): null => {
    body.innerHTML = '<div class="muted">No data in the selected range</div>';
    return null;
  };
  const hasData = !!wline && wline.xs.length > 0;
  switch (kind) {
    // Rate values are produced by the pipeline, so both kinds draw the same way.
    case 'line':
    case 'rate':
      return hasData ? drawLine(body, wline!, xRange) : noData();
    case 'area':
      return hasData ? drawLine(body, wline!, xRange, 0.25) : noData();
    case 'stacked-area':
      return hasData ? drawStackedArea(body, wline!, xRange) : noData();
    case 'bar':
      return hasData ? drawTimeBars(body, wline!, xRange) : noData();
    case 'gauge':
      return hasData ? drawGauge(body, wline!, m.unit) : noData();
    case 'histogram':
      return m.bars ? drawBar(body, m.bars) : noData();
    case 'percentile':
      return hasData ? drawPercentile(body, wline!) : noData();
    case 'table':
      return renderMiniTable(body, m);
    default:
      return noData();
  }
}

// The fast-path mirror of renderKind: the same data an existing uPlot for this kind was
// built from, so it can be swapped in with setData. Null means the kind draws plain DOM
// (or has nothing to draw) and must go through a full rebuild.
function kindData(
  kind: ChartKind,
  m: MetricVM,
  wline: LineGraph | undefined
): uPlot.AlignedData | null {
  const g = wline && wline.xs.length > 0 ? wline : undefined;
  switch (kind) {
    case 'line':
    case 'rate':
    case 'area':
      return g ? lineData(g) : null;
    case 'stacked-area':
      return g ? stackedData(g) : null;
    case 'bar':
      return g ? timeBarsData(g) : null;
    case 'histogram':
      return m.bars ? barData(m.bars) : null;
    case 'percentile': {
      const bars = g ? quantileBars(g) : null;
      return bars ? barData(bars) : null;
    }
    default:
      return null;
  }
}

// Everything baked into a uPlot at construction time: the kind, the pipeline that shaped
// the data, and the series/category set. While this is stable a data push only needs
// setData, which leaves the card's DOM, focus and scroll position untouched.
function renderSig(
  m: MetricVM,
  kind: ChartKind,
  agg: AggKind,
  reduce: ReduceKind,
  wline: LineGraph | undefined
): string {
  const parts: string[] = [kind, agg, reduce];
  const g = wline && wline.xs.length > 0 ? wline : undefined;
  parts.push(g ? '1' : '0');
  if (kind === 'histogram') parts.push((m.bars?.categories ?? []).join('\u0001'));
  else if (kind === 'percentile') parts.push(((g && quantileBars(g)?.categories) ?? []).join('\u0001'));
  else parts.push((g?.series ?? []).map((s) => s.label).join('\u0001'));
  return parts.join('|');
}

// Collapse a metric's label sets into one aggregate series per timestamp.
function applyReduce(line: LineGraph | undefined, reduce: ReduceKind): LineGraph | undefined {
  if (!line) return undefined;
  if (reduce === 'none' || line.series.length <= 1) return line;
  const agg = reduceAcrossSeries(line.series.map((s) => s.ys), reduce);
  const label = `${REDUCE_LABEL[reduce]} (${line.series.length})`;
  return { kind: 'line', xs: line.xs, series: [{ label, ys: agg }] };
}

// Trim to the selected window, convert to rate when that kind is selected, then roll
// the samples up into fixed-width buckets. Rate is computed before bucketing so an
// "Avg" on a counter reports an average rate rather than an average cumulative total.
// Returns the bucket width actually used, which the header hint reports.
function shapeLine(
  m: MetricVM,
  kind: ChartKind,
  agg: AggKind,
  from: number,
  to: number
): { line?: LineGraph; bucketSec: number } {
  if (!m.line) return { bucketSec: 0 };
  const w = windowSeries(m.line.xs, m.line.series.map((s) => s.ys), from, to);
  let xs = w.xs;
  let ys = w.seriesYs;
  if (!xs.length) return { line: { kind: 'line', xs: [], series: [] }, bucketSec: 0 };
  if (kind === 'rate') {
    ys = ys.map((y) => computeRate(xs, y, m.presentedType === 'counter'));
  }
  let bucketSec = 0;
  if (agg !== 'raw') {
    // Auto is floored at the metric's export interval, since a bucket finer than the data
    // leaves most buckets empty. An explicit step is honoured as asked; samples stranded
    // without a neighbour still render as points.
    const explicit = STEP_SECONDS[step];
    bucketSec = explicit
      ? explicit
      : niceBucketSeconds(Math.max(bucketSecondsFor(range), medianInterval(xs)));
    const axis = bucketAxis(xs, bucketSec);
    ys = ys.map((y) => bucketSeries(xs, y, bucketSec, agg).ys);
    xs = axis;
  }
  const line: LineGraph = {
    kind: 'line',
    xs,
    series: m.line.series.map((s, i) => ({ label: s.label, ys: ys[i] })),
  };
  return { line, bucketSec };
}

// The window is anchored to the newest sample rather than the wall clock, so exporter
// and host clock skew cannot push every series out of view.
function windowBounds(): XRange {
  let newest = -Infinity;
  for (const m of metrics) {
    const xs = m.line?.xs;
    if (xs && xs.length) newest = Math.max(newest, xs[xs.length - 1]);
  }
  const to = Number.isFinite(newest) ? newest : Date.now() / 1000;
  return [to - RANGE_SECONDS[range], to];
}

function fmtBucket(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} sec`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round((seconds / 3600) * 10) / 10} hours`;
}

// Warn when the ring buffer holds less history than the selected range asks for. Measured
// against the best-covered metric, so a single freshly-seen series does not trip it.
function updateRetentionHint(rows: MetricVM[], [from, to]: XRange): void {
  let covered = -Infinity;
  for (const m of rows) {
    const xs = m.line?.xs;
    if (xs && xs.length) covered = Math.max(covered, to - xs[0]);
  }
  const short = Number.isFinite(covered) && covered < to - from - 1;
  retentionHint.style.display = short ? '' : 'none';
  if (short) {
    retentionHintText.textContent =
      `Only ${fmtDuration(covered)} of history is retained, less than the selected ` +
      `${RANGE_LABEL[range].toLowerCase()}.`;
  }
}

function setBucketHint(body: HTMLElement, bucketSec: number): void {
  const hint = body.parentElement?.querySelector('.bucket-hint') as HTMLElement | null;
  if (hint) hint.textContent = bucketSec ? '· ' + fmtBucket(bucketSec) : '';
}

function renderCardBody(m: MetricVM, body: HTMLElement): void {
  try {
    const kind = chartFor(m);
    const agg = aggFor(m);
    const reduce = reduceFor(m);
    const bounds = windowBounds();
    const shaped = shapeLine(m, kind, agg, bounds[0], bounds[1]);
    const wline = applyReduce(shaped.line, reduce);
    const sig = renderSig(m, kind, agg, reduce, wline);
    const prev = chartByMetric.get(m.name);
    if (prev && prev.sig === sig) {
      const data = kindData(kind, m, wline);
      if (data) {
        // Mutated in place because the chart's x-scale closure holds this same array.
        prev.xRange[0] = bounds[0];
        prev.xRange[1] = bounds[1];
        prev.chart.setData(data);
        setBucketHint(body, shaped.bucketSec);
        return;
      }
    }
    destroyChart(m.name);
    body.innerHTML = '';
    const xRange: XRange = [bounds[0], bounds[1]];
    const chart = renderKind(kind, m, wline, body, xRange);
    if (chart) chartByMetric.set(m.name, { chart, sig, xRange });
    setBucketHint(body, shaped.bucketSec);
  } catch {
    destroyChart(m.name);
    body.innerHTML = '<div class="muted">Unable to render chart</div>';
  }
}

// Reconcile cards against the metric list keyed by name, reusing the existing DOM. Wiping
// and rebuilding the list collapsed the scroll container's height, which reset the scroll
// position and closed any dropdown the user had open, on every data push.
function renderGraphs(rows: MetricVM[]): void {
  const withGraphs = rows.filter((m) => m.line || m.bars);
  updateRetentionHint(withGraphs, windowBounds());
  const existing = new Map<string, HTMLElement>();
  for (const node of Array.from(chartsEl.children)) {
    const name = node.getAttribute('data-metric');
    if (name) existing.set(name, node as HTMLElement);
  }
  const wanted = new Set(withGraphs.map((m) => m.name));
  for (const [name, node] of existing) {
    if (wanted.has(name)) continue;
    destroyChart(name);
    node.remove();
    existing.delete(name);
  }
  let cursor: Element | null = chartsEl.firstElementChild;
  for (const m of withGraphs) {
    let card = existing.get(m.name);
    if (!card) {
      card = makeCard(m);
      chartsEl.insertBefore(card, cursor);
    } else {
      syncCardHead(card, m);
      if (card !== cursor) chartsEl.insertBefore(card, cursor);
    }
    cursor = card.nextElementSibling;
    renderCardBody(m, card.querySelector('.card-body') as HTMLElement);
  }
  graphWrap.setAttribute('data-empty', withGraphs.length ? 'false' : 'true');
}

function apply(): void {
  const rows = filtered();
  count.textContent = rows.length + ' of ' + metrics.length + ' metrics';
  empty.style.display = metrics.length ? 'none' : 'block';
  const isGraph = view === 'graph';
  tableWrap.style.display = isGraph ? 'none' : '';
  graphWrap.style.display = isGraph ? '' : 'none';
  rangePicker.style.display = isGraph ? '' : 'none';
  stepPicker.style.display = isGraph ? '' : 'none';
  btnTable.classList.toggle('active', !isGraph);
  btnGraph.classList.toggle('active', isGraph);
  if (isGraph) {
    scheduleGraphRender();
  } else {
    window.clearTimeout(graphTimer);
    destroyCharts();
    chartsEl.innerHTML = '';
    renderTable(rows);
  }
}

// Coalesce rapid data pushes (store fires ~every 150 ms) into at most one redraw per window.
// The row set is re-derived in the callback so a queued timer cannot render a stale list.
let graphTimer: number | undefined;
function scheduleGraphRender(): void {
  window.clearTimeout(graphTimer);
  graphTimer = window.setTimeout(() => renderGraphs(filtered()), 250);
}

function setView(next: 'table' | 'graph'): void {
  if (view === next) return;
  view = next;
  persistState();
  apply();
}

if (typeof savedState.query === 'string') q.value = savedState.query;
if (savedState.view === 'graph' || savedState.view === 'table') view = savedState.view;

for (const r of RANGE_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = r;
  opt.textContent = RANGE_LABEL[r];
  if (r === range) opt.selected = true;
  rangeSel.appendChild(opt);
}

for (const s of STEP_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = s;
  opt.textContent = STEP_LABEL[s];
  if (s === step) opt.selected = true;
  stepSel.appendChild(opt);
}

q.addEventListener('input', () => {
  persistState();
  apply();
});
btnTable.addEventListener('click', () => setView('table'));
btnGraph.addEventListener('click', () => setView('graph'));

rangeSel.addEventListener('change', () => {
  if (!isRangeKind(rangeSel.value)) return;
  range = rangeSel.value;
  persistState();
  apply();
});

stepSel.addEventListener('change', () => {
  if (!isStepKind(stepSel.value)) return;
  step = stepSel.value;
  persistState();
  apply();
});

retentionSetting.addEventListener('click', () => {
  vscode.postMessage({ type: 'openSetting', key: 'otel.retention.maxMetricPointsPerSeries' });
});

// Delegate dropdown changes: persist the choice and re-render only that card.
chartsEl.addEventListener('change', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target || !(target instanceof HTMLSelectElement) || !target.classList.contains('chart-select')) return;
  const name = target.getAttribute('data-metric');
  const role = target.getAttribute('data-role');
  if (!name) return;
  const value = target.value;
  if (role === 'chart' && isChartKind(value)) setSelection(name, { chart: value });
  else if (role === 'agg' && isAggKind(value)) setSelection(name, { agg: value });
  else if (role === 'reduce' && isReduceKind(value)) setSelection(name, { reduce: value });
  const m = metrics.find((x) => x.name === name);
  const body = target.closest('.card')?.querySelector('.card-body') as HTMLElement | null;
  if (m && body) renderCardBody(m, body);
});

// Resize in place; rebuilding every card here would throw away scroll and focus too.
function resizeCharts(): void {
  for (const entry of chartByMetric.values()) {
    const body = entry.chart.root.parentElement;
    if (!body) continue;
    try {
      entry.chart.setSize({ width: containerWidth(body), height: 180 });
    } catch {
      /* ignore */
    }
  }
}

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  if (view !== 'graph') return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resizeCharts, 150);
});

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data;
  if (m && m.type === 'data') {
    metrics = m.metrics || [];
    apply();
  }
});

vscode.postMessage({ type: 'ready' });
