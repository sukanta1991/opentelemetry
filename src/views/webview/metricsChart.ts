// Bundled webview app for the Metrics panel. Built by esbuild into dist/webview/metricsChart.js
// and loaded by MetricsPanel. Owns the toolbar, table view, and uPlot graph view.
import uPlot from 'uplot';

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
type Graph = LineGraph | BarGraph | null;

interface MetricVM {
  name: string;
  type: string;
  unit: string;
  description: string;
  points: { labels: string; value: string }[];
  graph: Graph;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

let metrics: MetricVM[] = [];
let view: 'table' | 'graph' = 'table';
const charts: uPlot[] = [];

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

function esc(s: unknown): string {
  return s == null
    ? ''
    : String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
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

function destroyCharts(): void {
  for (const c of charts.splice(0)) {
    try {
      c.destroy();
    } catch {
      /* ignore */
    }
  }
}

function renderTable(rows: MetricVM[]): void {
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
}

function makeCard(m: MetricVM): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML =
    '<span class="card-title" title="' +
    esc(m.description) +
    '">' +
    esc(m.name) +
    '</span>' +
    '<span class="type-badge">' +
    esc(m.type) +
    '</span>' +
    (m.unit ? '<span class="muted card-unit">' + esc(m.unit) + '</span>' : '');
  const body = document.createElement('div');
  body.className = 'card-body';
  card.appendChild(head);
  card.appendChild(body);
  return card;
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

function drawLine(container: HTMLElement, g: LineGraph): void {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const data: uPlot.AlignedData = [g.xs, ...g.series.map((s) => s.ys)] as uPlot.AlignedData;
  const opts: uPlot.Options = {
    width,
    height: 180,
    scales: { x: { time: true } },
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
        width: 1.5,
        points: { show: false },
      })),
    ],
  };
  charts.push(new uPlot(opts, data, container));
  if (g.series.length > 1) renderLegend(container, g.series, colors);
}

function drawBar(container: HTMLElement, g: BarGraph): void {
  const colors = palette();
  const stroke = cssVar('--vscode-foreground', '#ccc');
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)');
  const width = containerWidth(container);
  const xs = g.categories.map((_, i) => i);
  const data: uPlot.AlignedData = [xs, g.values];
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
  charts.push(new uPlot(opts, data, container));
}

function renderGraphs(rows: MetricVM[]): void {
  destroyCharts();
  chartsEl.innerHTML = '';
  const withGraphs = rows.filter((m) => m.graph);
  for (const m of withGraphs) {
    const card = makeCard(m);
    chartsEl.appendChild(card);
    const body = card.querySelector('.card-body') as HTMLElement;
    try {
      if (m.graph?.kind === 'line') drawLine(body, m.graph);
      else if (m.graph?.kind === 'bar') drawBar(body, m.graph);
    } catch (e) {
      body.innerHTML = '<div class="muted">Unable to render chart</div>';
    }
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
  btnTable.classList.toggle('active', !isGraph);
  btnGraph.classList.toggle('active', isGraph);
  if (isGraph) {
    scheduleGraphRender(rows);
  } else {
    window.clearTimeout(graphTimer);
    destroyCharts();
    renderTable(rows);
  }
}

// Coalesce rapid data pushes (store fires ~every 150 ms) into at most one redraw per window.
let graphTimer: number | undefined;
function scheduleGraphRender(rows: MetricVM[]): void {
  window.clearTimeout(graphTimer);
  graphTimer = window.setTimeout(() => renderGraphs(rows), 250);
}

function setView(next: 'table' | 'graph'): void {
  if (view === next) return;
  view = next;
  apply();
}

q.addEventListener('input', apply);
btnTable.addEventListener('click', () => setView('table'));
btnGraph.addEventListener('click', () => setView('graph'));

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  if (view !== 'graph') return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => apply(), 150);
});

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data;
  if (m && m.type === 'data') {
    metrics = m.metrics || [];
    apply();
  }
});

vscode.postMessage({ type: 'ready' });
