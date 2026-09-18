// Pure statistics helpers for the metrics graph (reduce-over-time, time bucketing,
// reduce-across-series, and histogram percentile/mean). Must not import vscode, uplot, or DOM.
import { AggKind, ReduceKind } from './chartTypes';

function nonNull(ys: (number | null)[]): number[] {
  return ys.filter((v): v is number => v != null && Number.isFinite(v));
}

// Linear-interpolated quantile of a numeric sample (p in [0,1]).
export function quantile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const clamped = Math.min(1, Math.max(0, p));
  if (xs.length === 1) return xs[0];
  const pos = clamped * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number | null {
  if (!values.length) return null;
  const m = mean(values)!;
  const variance = values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
  return Math.sqrt(variance);
}

// Reduce a single series' values over one time bucket to a single point.
export function reduceOverTime(ys: (number | null)[], agg: AggKind): number | null {
  const xs = nonNull(ys);
  if (!xs.length) return null;
  switch (agg) {
    case 'last':
      return xs[xs.length - 1];
    case 'avg':
      return mean(xs);
    case 'min':
      return Math.min(...xs);
    case 'max':
      return Math.max(...xs);
    case 'sum':
      return xs.reduce((a, b) => a + b, 0);
    case 'count':
      return xs.length;
    case 'stddev':
      return stddev(xs);
    case 'p50':
      return quantile(xs, 0.5);
    case 'p90':
      return quantile(xs, 0.9);
    case 'p95':
      return quantile(xs, 0.95);
    case 'p99':
      return quantile(xs, 0.99);
    default:
      return null;
  }
}

// Trim aligned series to [fromSec, toSec], retaining one sample before the window so
// rate/delta transforms still have a predecessor. The pinned x-axis clips it visually.
export function windowSeries(
  xs: number[],
  seriesYs: (number | null)[][],
  fromSec: number,
  toSec: number
): { xs: number[]; seriesYs: (number | null)[][] } {
  let start = xs.findIndex((x) => x >= fromSec);
  if (start === -1) return { xs: [], seriesYs: seriesYs.map(() => []) };
  let end = xs.length;
  while (end > start && xs[end - 1] > toSec) end--;
  if (start >= end) return { xs: [], seriesYs: seriesYs.map(() => []) };
  if (start > 0) start--;
  return { xs: xs.slice(start, end), seriesYs: seriesYs.map((ys) => ys.slice(start, end)) };
}

// True when some value has no adjacent non-null neighbour. A line segment needs two
// adjacent points, so such values are invisible unless the series also draws points.
export function hasIsolatedPoints(ys: (number | null)[]): boolean {
  for (let i = 0; i < ys.length; i++) {
    if (ys[i] == null || !Number.isFinite(ys[i] as number)) continue;
    const prev = i > 0 ? ys[i - 1] : null;
    const next = i + 1 < ys.length ? ys[i + 1] : null;
    if (prev == null && next == null) return true;
  }
  return false;
}

// Guards against a pathological bucket count if a stale timestamp widens the span.
const MAX_BUCKETS = 5000;

// Typical spacing between samples. Bucketing finer than this would leave most buckets
// empty, and a line needs two adjacent non-null points to draw anything.
export function medianInterval(xs: number[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

// The dense, floor-aligned bucket boundaries spanning `xs`. Shared by every series of a
// metric so uPlot's single x-axis stays valid.
export function bucketAxis(xs: number[], bucketSec: number): number[] {
  if (!xs.length || !(bucketSec > 0)) return xs;
  const first = Math.floor(xs[0] / bucketSec) * bucketSec;
  const last = Math.floor(xs[xs.length - 1] / bucketSec) * bucketSec;
  const n = Math.floor((last - first) / bucketSec) + 1;
  if (n > MAX_BUCKETS) return xs;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = first + i * bucketSec;
  return out;
}

// Roll one series up into fixed-width time buckets. Empty buckets stay null so gaps
// render as gaps rather than zeros.
export function bucketSeries(
  xs: number[],
  ys: (number | null)[],
  bucketSec: number,
  agg: AggKind
): { xs: number[]; ys: (number | null)[] } {
  if (agg === 'raw' || !xs.length || !(bucketSec > 0)) return { xs, ys };
  const axis = bucketAxis(xs, bucketSec);
  if (axis === xs) return { xs, ys };
  const first = axis[0];
  const groups: (number | null)[][] = Array.from({ length: axis.length }, () => []);
  for (let i = 0; i < xs.length; i++) {
    const b = Math.floor((Math.floor(xs[i] / bucketSec) * bucketSec - first) / bucketSec);
    if (b >= 0 && b < groups.length) groups[b].push(ys[i] ?? null);
  }
  return { xs: axis, ys: groups.map((g) => reduceOverTime(g, agg)) };
}

// Interpolated percentile from explicit-bounds histogram buckets (Prometheus-style).
// `bounds` has N entries; `counts` has N+1 (last is the +Inf overflow bucket).
export function histogramQuantile(
  bounds: number[],
  counts: number[],
  p: number
): number | null {
  if (!counts.length) return null;
  const total = counts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (total <= 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = clamped * total;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i];
    if (cumulative >= rank) {
      const lower = i === 0 ? 0 : bounds[i - 1];
      const upper = i < bounds.length ? bounds[i] : lower;
      if (!Number.isFinite(upper) || upper === lower) return lower;
      const inBucket = counts[i];
      if (inBucket <= 0) return lower;
      const prevCumulative = cumulative - inBucket;
      const frac = (rank - prevCumulative) / inBucket;
      return lower + (upper - lower) * frac;
    }
  }
  return bounds.length ? bounds[bounds.length - 1] : null;
}

export function histogramMean(sum?: number, count?: number): number | null {
  if (sum == null || count == null || count <= 0 || !Number.isFinite(sum)) return null;
  return sum / count;
}

// Collapse many aligned series into one aggregate series (per timestamp).
export function reduceAcrossSeries(
  seriesYs: (number | null)[][],
  reduce: ReduceKind
): (number | null)[] {
  if (reduce === 'none' || !seriesYs.length) return seriesYs[0] ?? [];
  const len = seriesYs.reduce((m, s) => Math.max(m, s.length), 0);
  const out: (number | null)[] = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const col = nonNull(seriesYs.map((s) => s[i]));
    if (!col.length) {
      out[i] = null;
      continue;
    }
    switch (reduce) {
      case 'sum':
        out[i] = col.reduce((a, b) => a + b, 0);
        break;
      case 'avg':
        out[i] = mean(col);
        break;
      case 'min':
        out[i] = Math.min(...col);
        break;
      case 'max':
        out[i] = Math.max(...col);
        break;
      case 'p95':
        out[i] = quantile(col, 0.95);
        break;
      default:
        out[i] = null;
    }
  }
  return out;
}
