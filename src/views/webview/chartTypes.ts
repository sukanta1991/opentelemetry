// Pure, framework-agnostic chart-type registry shared by the extension host,
// the webview bundle, and unit tests. Must not import vscode, uplot, or DOM.
import { MetricType } from '../../store/model';

// How a metric is presented in the UI (derived from OTLP type + monotonicity).
export type PresentedType =
  | 'counter'
  | 'updowncounter'
  | 'gauge'
  | 'histogram'
  | 'exponentialHistogram'
  | 'summary'
  | 'unknown';

// A concrete chart rendering the user can select per graph.
export type ChartKind =
  | 'line'
  | 'area'
  | 'stacked-area'
  | 'rate'
  | 'bar'
  | 'gauge'
  | 'histogram'
  | 'percentile'
  | 'table';

export interface ChartOptions {
  default: ChartKind;
  alternatives: ChartKind[];
}

// Data-ready views only. Histogram heatmap/percentile and exponential-histogram
// bucket views are intentionally deferred (need new backend data).
export const CHART_OPTIONS: Record<PresentedType, ChartOptions> = {
  counter: { default: 'line', alternatives: ['rate', 'stacked-area', 'area', 'bar', 'table'] },
  updowncounter: { default: 'line', alternatives: ['rate', 'stacked-area', 'area', 'bar', 'table'] },
  gauge: { default: 'line', alternatives: ['area', 'gauge', 'table'] },
  histogram: { default: 'histogram', alternatives: ['table'] },
  exponentialHistogram: { default: 'line', alternatives: ['table'] },
  summary: { default: 'line', alternatives: ['percentile', 'table'] },
  unknown: { default: 'line', alternatives: ['table'] },
};

export function presentedType(type: MetricType, monotonic?: boolean): PresentedType {
  switch (type) {
    case 'sum':
      return monotonic === true ? 'counter' : 'updowncounter';
    case 'gauge':
      return 'gauge';
    case 'histogram':
      return 'histogram';
    case 'exponentialHistogram':
      return 'exponentialHistogram';
    case 'summary':
      return 'summary';
    default:
      return 'unknown';
  }
}

// The full, de-duplicated option list (default first) for a presented type.
export function chartKindsFor(pt: PresentedType): ChartKind[] {
  const o = CHART_OPTIONS[pt] ?? CHART_OPTIONS.unknown;
  return [o.default, ...o.alternatives.filter((k) => k !== o.default)];
}

export function isChartKind(v: unknown): v is ChartKind {
  return (
    v === 'line' ||
    v === 'area' ||
    v === 'stacked-area' ||
    v === 'rate' ||
    v === 'bar' ||
    v === 'gauge' ||
    v === 'histogram' ||
    v === 'percentile' ||
    v === 'table'
  );
}

// A reduce-over-time aggregation applied to fixed-width time buckets. 'raw' plots
// every sample untouched.
export type AggKind =
  | 'raw'
  | 'last'
  | 'avg'
  | 'min'
  | 'max'
  | 'sum'
  | 'count'
  | 'stddev'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99';

// A reduce-across-series aggregation applied per timestamp.
export type ReduceKind = 'none' | 'sum' | 'avg' | 'min' | 'max' | 'p95';

const ALL_AGGS: AggKind[] = [
  'raw',
  'avg',
  'min',
  'max',
  'sum',
  'last',
  'count',
  'stddev',
  'p50',
  'p90',
  'p95',
  'p99',
];

// Histograms arrive as a single latest bucket snapshot with no time series, so there
// is nothing to roll up over time.
export const AGG_OPTIONS: Record<PresentedType, AggKind[]> = {
  counter: ALL_AGGS,
  updowncounter: ALL_AGGS,
  gauge: ALL_AGGS,
  histogram: ['raw'],
  exponentialHistogram: ALL_AGGS,
  summary: ALL_AGGS,
  unknown: ALL_AGGS,
};

export const REDUCE_OPTIONS: ReduceKind[] = ['none', 'sum', 'avg', 'min', 'max', 'p95'];

export const AGG_LABEL: Record<AggKind, string> = {
  raw: 'Over time: Raw',
  last: 'Over time: Last',
  avg: 'Over time: Avg',
  min: 'Over time: Min',
  max: 'Over time: Max',
  sum: 'Over time: Sum',
  count: 'Over time: Count',
  stddev: 'Over time: Std dev',
  p50: 'Over time: P50',
  p90: 'Over time: P90',
  p95: 'Over time: P95',
  p99: 'Over time: P99',
};

export const REDUCE_LABEL: Record<ReduceKind, string> = {
  none: 'Series: All',
  sum: 'Series: Sum',
  avg: 'Series: Avg',
  min: 'Series: Min',
  max: 'Series: Max',
  p95: 'Series: P95',
};

export function aggsFor(pt: PresentedType): AggKind[] {
  return AGG_OPTIONS[pt] ?? AGG_OPTIONS.unknown;
}

export function isAggKind(v: unknown): v is AggKind {
  return typeof v === 'string' && v in AGG_LABEL;
}

export function isReduceKind(v: unknown): v is ReduceKind {
  return typeof v === 'string' && v in REDUCE_LABEL;
}

// The trailing time window the graph view displays, shared by every card.
export type RangeKind = '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '2h';

export const RANGE_OPTIONS: RangeKind[] = ['1m', '2m', '5m', '15m', '30m', '1h', '2h'];

export const DEFAULT_RANGE: RangeKind = '5m';

export const RANGE_SECONDS: Record<RangeKind, number> = {
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
};

export const RANGE_LABEL: Record<RangeKind, string> = {
  '1m': 'Last 1 min',
  '2m': 'Last 2 min',
  '5m': 'Last 5 min',
  '15m': 'Last 15 min',
  '30m': 'Last 30 min',
  '1h': 'Last 1 hour',
  '2h': 'Last 2 hour',
};

// Bucket width derived from the range so a rolled-up graph lands at ~60 points. Targeting
// far more than that would put one sample per bucket for typical 10-60s exporters, which
// makes every aggregation collapse to the raw value.
const RANGE_BUCKET_SECONDS: Record<RangeKind, number> = {
  '1m': 1,
  '2m': 2,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
};

export function bucketSecondsFor(range: RangeKind): number {
  return RANGE_BUCKET_SECONDS[range] ?? RANGE_BUCKET_SECONDS[DEFAULT_RANGE];
}

const NICE_BUCKET_SECONDS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];

// Snap a bucket width derived from observed sample spacing onto a readable step. Export
// intervals arrive as floats (e.g. 59.999058961868286s), so the tolerance absorbs that
// jitter while otherwise rounding up, since a bucket narrower than the sample spacing
// would leave empty buckets between samples.
export function niceBucketSeconds(seconds: number): number {
  if (!(seconds > 0)) return 0;
  const tolerated = seconds * 0.98;
  for (const step of NICE_BUCKET_SECONDS) if (step >= tolerated) return step;
  return Math.ceil(seconds / 3600) * 3600;
}

export function isRangeKind(v: unknown): v is RangeKind {
  return typeof v === 'string' && v in RANGE_SECONDS;
}

// The bucket width used for over-time aggregation. 'auto' follows the range; an explicit
// step lets a coarser rollup gather several samples per bucket, which is the only way the
// aggregators differ from each other when the exporter is slower than the auto width.
export type StepKind = 'auto' | '10s' | '30s' | '1m' | '2m' | '5m' | '15m' | '30m';

export const STEP_OPTIONS: StepKind[] = ['auto', '10s', '30s', '1m', '2m', '5m', '15m', '30m'];

export const DEFAULT_STEP: StepKind = 'auto';

export const STEP_SECONDS: Record<StepKind, number> = {
  auto: 0,
  '10s': 10,
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
};

export const STEP_LABEL: Record<StepKind, string> = {
  auto: 'Step: Auto',
  '10s': 'Step: 10s',
  '30s': 'Step: 30s',
  '1m': 'Step: 1 min',
  '2m': 'Step: 2 min',
  '5m': 'Step: 5 min',
  '15m': 'Step: 15 min',
  '30m': 'Step: 30 min',
};

export function isStepKind(v: unknown): v is StepKind {
  return typeof v === 'string' && v in STEP_SECONDS;
}
