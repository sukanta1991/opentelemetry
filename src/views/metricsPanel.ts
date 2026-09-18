import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { KeyValueMap, Metric, MetricType } from '../store/model';
import { presentedType } from './webview/chartTypes';
import { getNonce, getUri, htmlShell } from './webviewUtil';

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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
      }
    );
    MetricsPanel.panels.set(instanceId, new MetricsPanel(panel, controller, instanceId));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    const scriptUri = getUri(this.panel.webview, controller.extensionUri, 'dist', 'webview', 'metricsChart.js');
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, '', STYLE, [scriptUri]);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') this.postData();
      else if (m?.type === 'openSetting' && typeof m.key === 'string') {
        void vscode.commands.executeCommand('workbench.action.openSettings', m.key);
      }
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
        presentedType: presentedType(m.type, m.monotonic),
        monotonic: m.monotonic,
        unit: m.unit ?? '',
        description: m.description ?? '',
        points: summarizePoints(m),
        line:
          m.type === 'histogram'
            ? undefined
            : lineGraph(this.controller.store.getMetricSeries(this.instanceId, m.name), m.type) ??
              undefined,
        bars: m.type === 'histogram' ? histogramBars(m) ?? undefined : undefined,
        buckets: m.type === 'histogram' ? histogramBuckets(m) ?? undefined : undefined,
      }));
    this.panel.webview.postMessage({ type: 'data', metrics });
  }

  private dispose(): void {
    MetricsPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

interface LineGraph {
  kind: 'line';
  xs: number[];
  series: { label: string; ys: (number | null)[] }[];
}
interface BarGraph {
  kind: 'bar';
  categories: string[];
  values: number[];
}
// Raw numeric bucket data for client-side percentile / mean statistics.
interface BucketData {
  bounds: number[];
  counts: number[];
  sum?: number;
  count?: number;
}

function seriesLabel(attrs: KeyValueMap, field: string, type: MetricType): string {
  const a = labels(attrs);
  if (type === 'summary') return a ? `${field} · ${a}` : field;
  if (field !== 'value') return a ? `${field} · ${a}` : field;
  return a || 'value';
}

// Merge all series of a metric onto a shared, sorted time axis (seconds) for uPlot.
function lineGraph(
  series: { attrs: KeyValueMap; field: string; data: { timeMs: number; value: number }[] }[],
  type: MetricType
): LineGraph | null {
  const nonEmpty = series.filter((s) => s.data.length > 0);
  if (!nonEmpty.length) return null;
  const times = new Set<number>();
  for (const s of nonEmpty) for (const p of s.data) times.add(p.timeMs);
  const xs = [...times].sort((a, b) => a - b);
  const index = new Map(xs.map((t, i) => [t, i]));
  const out = nonEmpty.map((s) => {
    const ys: (number | null)[] = new Array(xs.length).fill(null);
    for (const p of s.data) ys[index.get(p.timeMs)!] = p.value;
    return { label: seriesLabel(s.attrs, s.field, type), ys };
  });
  return { kind: 'line', xs: xs.map((t) => t / 1000), series: out };
}

function histogramBars(m: Metric): BarGraph | null {
  const dp = m.dataPoints.find((d) => (d.bucketCounts?.length ?? 0) > 0);
  if (!dp || !dp.bucketCounts) return null;
  const bounds = dp.bucketBounds ?? [];
  const counts = dp.bucketCounts;
  const categories = counts.map((_, i) => {
    if (counts.length === 1) return 'all';
    if (i === 0) return `≤${fmtBound(bounds[0])}`;
    if (i === counts.length - 1) return `>${fmtBound(bounds[bounds.length - 1])}`;
    return `${fmtBound(bounds[i - 1])}–${fmtBound(bounds[i])}`;
  });
  return { kind: 'bar', categories, values: counts };
}

function histogramBuckets(m: Metric): BucketData | null {
  const dp = m.dataPoints.find((d) => (d.bucketCounts?.length ?? 0) > 0);
  if (!dp || !dp.bucketCounts) return null;
  const finite = (n: number): boolean => Number.isFinite(n);
  const bounds = (dp.bucketBounds ?? []).filter(finite);
  const counts = dp.bucketCounts.map((c) => (finite(c) ? c : 0));
  return {
    bounds,
    counts,
    sum: finite(dp.sum ?? NaN) ? dp.sum : undefined,
    count: finite(dp.count ?? NaN) ? dp.count : undefined,
  };
}

function fmtBound(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return '∞';
  return String(round(n));
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
  /* uPlot (bundled) */
  .uplot, .uplot *, .uplot *::before, .uplot *::after { box-sizing: border-box; }
  .uplot { font-family: var(--vscode-font-family); line-height: 1.5; width: 100%; max-width: 100%; }
  .u-title { text-align: center; font-size: 13px; font-weight: bold; }
  .u-wrap { position: relative; user-select: none; }
  .u-over, .u-under { position: absolute; }
  .u-under { overflow: hidden; }
  .uplot canvas { display: block; position: relative; width: 100%; height: 100%; }
  .u-axis { position: absolute; }
  .u-legend { font-size: 11px; margin: auto; text-align: center; max-width: 100%; }
  .u-inline { display: block; }
  .u-inline * { display: inline-block; }
  .u-inline tr { margin-right: 16px; }
  .u-legend th { font-weight: 600; }
  .u-legend th > * { vertical-align: middle; display: inline-block; }
  .u-legend .u-marker { width: 1em; height: 1em; margin-right: 4px; background-clip: padding-box !important; }
  .u-inline.u-live th::after { content: ":"; vertical-align: middle; }
  .u-inline:not(.u-live) .u-value { display: none; }
  .u-series > * { padding: 4px; }
  .u-series th { cursor: pointer; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .u-legend .u-off > * { opacity: 0.3; }
  .u-select { background: rgba(0,0,0,0.07); position: absolute; pointer-events: none; }
  .u-cursor-x, .u-cursor-y { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; }
  .u-hz .u-cursor-x, .u-vt .u-cursor-y { height: 100%; border-right: 1px dashed #607D8B; }
  .u-hz .u-cursor-y, .u-vt .u-cursor-x { width: 100%; border-bottom: 1px dashed #607D8B; }
  .u-cursor-pt { position: absolute; top: 0; left: 0; border-radius: 50%; border: 0 solid; pointer-events: none; will-change: transform; background-clip: padding-box !important; }
  .u-axis.u-off, .u-select.u-off, .u-cursor-x.u-off, .u-cursor-y.u-off, .u-cursor-pt.u-off { display: none; }

  /* Metrics panel */
  .type-badge { font-size: 0.8em; padding: 0 5px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  td.name { font-family: var(--vscode-editor-font-family, monospace); }
  .pt { display:block; }
  .pt .lbl { color: var(--vscode-descriptionForeground); }
  .seg { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
  .seg button { border-radius: 0; }
  .seg button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .seg button:not(.active) { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 12px; padding: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; background: var(--vscode-editor-background); overflow: hidden; min-width: 0; }
  .card-head { display: flex; flex-direction: column; align-items: stretch; gap: 4px; margin-bottom: 6px; min-width: 0; }
  .card-title { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
  .bucket-hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .card-body { min-height: 180px; overflow: hidden; min-width: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 2px 2px; font-size: 11px; }
  .legend-item { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; color: var(--vscode-descriptionForeground); }
  .legend-item .swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; }
  .legend-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
  #graphWrap[data-empty="true"] .charts-grid::after { content: "No graphable series yet for the current filter."; color: var(--vscode-descriptionForeground); padding: 24px; }

  /* Per-graph dropdowns */
  .card-controls .chart-select { font-size: 0.85em; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; padding: 1px 4px; max-width: 100%; }
  .card-controls .chart-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* Graph time-range picker */
  .range-picker { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 1px 6px; border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
  .range-picker:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .range-picker .range-icon { flex: 0 0 auto; opacity: 0.8; }
  .range-picker select { border: none; background: transparent; color: inherit; font-size: 0.9em; padding: 2px 0; }
  .range-picker select:focus { outline: none; }

  /* Retention warning */
  .retention-hint { display: flex; align-items: center; gap: 8px; margin: 12px 12px 0; padding: 6px 8px; font-size: 0.9em; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); background: var(--vscode-inputValidation-warningBackground, transparent); color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); border-radius: 3px; }
  .retention-hint button { margin-left: auto; flex: 0 0 auto; }

  /* Experimental notice */
  .experimental-note { display: flex; align-items: center; gap: 8px; margin: 12px 12px 0; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
  .experimental-badge { flex: 0 0 auto; padding: 0 6px; border-radius: 10px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .experimental-note a { color: var(--vscode-textLink-foreground); }

  /* Gauge readout */
  .gauge-wrap { display: flex; flex-direction: column; gap: 6px; padding: 12px 4px; min-height: 156px; justify-content: center; }
  .gauge { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .gauge.single { justify-content: center; }
  .gauge-value { font-size: 1.6em; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--vscode-charts-blue, var(--vscode-foreground)); }
  .gauge.single .gauge-value { font-size: 2.4em; }
  .gauge-unit { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .gauge-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: auto; max-width: 60%; }

  /* Per-card mini table */
  table.mini { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  table.mini td { padding: 2px 4px; border-bottom: 1px solid var(--vscode-panel-border); overflow: hidden; text-overflow: ellipsis; }
`;

const BODY = `
<div class="toolbar">
  <input id="q" type="text" placeholder="Filter metric name…" style="min-width:200px" />
  <span class="seg" role="group" aria-label="View mode">
    <button id="viewTable" class="secondary active" title="Table view">Table</button>
    <button id="viewGraph" class="secondary" title="Graph view">Graph</button>
  </span>
  <span id="count" class="muted count" style="margin-left:auto"></span>
  <span id="rangePicker" class="range-picker" style="display:none" title="Time range shown on every graph">
    <svg class="range-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5A5.5 5.5 0 1 1 8 13.5 5.5 5.5 0 0 1 8 2.5zM7.25 4v4.31l3 1.73.75-1.3-2.25-1.3V4h-1.5z"/></svg>
    <select id="range" aria-label="Time range"></select>
  </span>
  <span id="stepPicker" class="range-picker" style="display:none" title="Bucket width used by the Over time aggregation">
    <select id="step" aria-label="Aggregation step"></select>
  </span>
</div>
<div id="tableWrap" class="rows"><table><thead>
  <tr><th style="width:32%">Metric</th><th style="width:110px">Type</th><th style="width:70px">Unit</th><th>Data points (latest)</th></tr>
</thead><tbody id="tbody"></tbody></table></div>
<div id="graphWrap" class="rows" style="display:none">
  <div class="experimental-note">
    <span class="experimental-badge">Experimental</span>
    <span>Aggregation, time range and step controls are new and still settling. <a href="https://github.com/sukanta1991/opentelemetry/issues">Feedback welcome</a>.</span>
  </div>
  <div id="retentionHint" class="retention-hint" style="display:none">
    <span id="retentionHintText"></span>
    <button id="retentionSetting" class="secondary">Increase retention…</button>
  </div>
  <div id="charts" class="charts-grid"></div>
</div>
<div id="empty" class="empty">Waiting for metrics…</div>
`;

