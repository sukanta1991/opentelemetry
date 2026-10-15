// SPDX-License-Identifier: Apache-2.0
// Compares a baseline snapshot with current stats (or another snapshot) per node, edge and operation. No vscode import.

import { Snapshot, SnapshotNode } from './baseline';
import { bhAdjust, mannWhitney, proportionTest } from './baselineStats';
import { CallAcc, Collected, sortedDurations } from './serviceMapModel';
import { quantileSorted } from './webview/stats';

export interface BaselineSettings {
  minSamples: number;
  minLatencyChangePct: number;
  minLatencyChangeMs: number;
  minErrorRateChangePp: number;
  minFanoutChange: number;
  coverageWarnPct: number;
}

export const DEFAULT_BASELINE_SETTINGS: Readonly<BaselineSettings> = Object.freeze({
  minSamples: 20,
  minLatencyChangePct: 20,
  minLatencyChangeMs: 5,
  minErrorRateChangePp: 2,
  minFanoutChange: 1,
  coverageWarnPct: 30,
});

const SETTING_RANGES: Record<keyof BaselineSettings, [number, number]> = {
  minSamples: [5, 1000],
  minLatencyChangePct: [0, 1000],
  minLatencyChangeMs: [0, 60_000],
  minErrorRateChangePp: [0, 100],
  minFanoutChange: [0, 1000],
  coverageWarnPct: [0, 100],
};

export const SIGNIFICANCE = 0.05;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Settings are user input: non-numbers fall back to defaults, numbers are clamped to their range.
export function sanitizeBaselineSettings(raw: unknown): BaselineSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_BASELINE_SETTINGS };
  for (const key of Object.keys(SETTING_RANGES) as (keyof BaselineSettings)[]) {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [min, max] = SETTING_RANGES[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  out.minSamples = Math.round(out.minSamples);
  return out;
}

export type Verdict = 'regressed' | 'improved' | 'unchanged' | 'insufficient' | 'new' | 'removed' | 'untracked';
export type Change = 'regressed' | 'improved' | 'unchanged';

export interface MetricDelta {
  base: number | null;
  current: number | null;
  // current - base; null when either side is missing.
  delta: number | null;
  change: Change;
  p?: number;
  q?: number;
}

export interface SideCounts {
  count: number;
  errors: number;
}

export interface KeyComparison {
  source?: string;
  target: string;
  op?: string;
  verdict: Verdict;
  base?: SideCounts;
  current?: SideCounts;
  p50: MetricDelta;
  p95: MetricDelta;
  errorRate: MetricDelta;
  // Edge calls per call into the source node; edges and edge operations only.
  fanout?: MetricDelta;
  exemplars: { base: string[]; current: string[] };
}

// Full deltas for one key; the key is implied by where it is attached.
export type KeyDelta = Omit<KeyComparison, 'source' | 'target' | 'op' | 'exemplars'>;

export type DeltaMetric = 'p50' | 'p95' | 'errorRate' | 'fanout';

// Per node and edge on the map: enough to colour and label; the selection's details carry the full KeyDelta.
export interface MapDelta {
  verdict: Verdict;
  // [baseline, current]
  p95: [number | null, number | null];
  // Metrics that regressed or improved; omitted when none did.
  changed?: DeltaMetric[];
}

export interface Coverage {
  currentNodes: number;
  missingFromBase: number;
  ratio: number;
  warn: boolean;
}

export interface ComparisonResult {
  keys: KeyComparison[];
  summary: Record<Verdict, number>;
  coverage: Coverage;
  // Union of both sides, so removed nodes can still be drawn.
  nodes: SnapshotNode[];
}

interface SideEntry {
  source?: string;
  target: string;
  op?: string;
  count: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  samples: ArrayLike<number>;
  exemplars: string[];
  opsTruncated?: boolean;
}

interface Side {
  entries: Map<string, SideEntry>;
  nodes: Map<string, SnapshotNode>;
  truncated: boolean;
}

// Per comparison (thousands of keys), not per span, so a string key is cheap enough.
const keyOf = (source: string | undefined, target: string, op?: string) => JSON.stringify([source ?? null, target, op ?? null]);

function sideFromSnapshot(s: Snapshot): Side {
  const entries = new Map<string, SideEntry>();
  for (const e of s.entries) entries.set(keyOf(e.source, e.target, e.op), e);
  return { entries, nodes: new Map(s.nodes.map((n) => [n.id, n])), truncated: s.truncated };
}

function fromAcc(acc: CallAcc, source: string | undefined, target: string, op?: string): SideEntry {
  const samples = sortedDurations(acc);
  const exemplars = [...new Set([acc.slowestTrace, acc.lastErrorTrace])].filter((t): t is string => t !== undefined);
  return { source, target, op, count: acc.count, errors: acc.errors, p50: quantileSorted(samples, 0.5), p95: quantileSorted(samples, 0.95), samples, exemplars };
}

// Current stats from collectCalls(..., { ops: true }); scopes with no calls in the window are left out.
function sideFromCollected(c: Collected): Side {
  const entries = new Map<string, SideEntry>();
  const nodes = new Map<string, SnapshotNode>();
  const add = (source: string | undefined, target: string, acc: CallAcc, ops: Map<string, CallAcc>) => {
    if (!acc.count) return;
    entries.set(keyOf(source, target), fromAcc(acc, source, target));
    for (const [op, a] of ops) if (a.count) entries.set(keyOf(source, target, op), fromAcc(a, source, target, op));
  };
  for (const [id, n] of c.nodes) {
    if (n.acc.count) nodes.set(id, { id, label: n.node.label, type: n.node.type });
    add(undefined, id, n.acc, n.ops);
  }
  for (const [source, byTarget] of c.edges) {
    for (const [target, s] of byTarget) add(source, target, s.acc, s.ops);
  }
  return { entries, nodes, truncated: false };
}

const delta = (base: number | null, current: number | null): MetricDelta => ({
  base,
  current,
  delta: base === null || current === null ? null : current - base,
  change: 'unchanged',
});

function fanoutOf(side: Side, e: SideEntry | undefined): number | null {
  if (!e || e.source === undefined) return null;
  const caller = side.entries.get(keyOf(undefined, e.source));
  return caller?.count ? e.count / caller.count : null;
}

const direction = (d: number | null) => (d === null || d === 0 ? 0 : d > 0 ? 1 : -1);
const changeFor = (dir: number): Change => (dir > 0 ? 'regressed' : dir < 0 ? 'improved' : 'unchanged');

function latencyMeetsFloor(m: MetricDelta, dir: number, s: BaselineSettings): boolean {
  if (m.delta === null || m.base === null || direction(m.delta) !== dir) return false;
  const abs = Math.abs(m.delta);
  return abs >= s.minLatencyChangeMs && (m.base <= 0 || (abs / m.base) * 100 >= s.minLatencyChangePct);
}

function verdictOf(k: KeyComparison): Verdict {
  const metrics = [k.p50, k.p95, k.errorRate, k.fanout];
  if (metrics.some((m) => m?.change === 'regressed')) return 'regressed';
  if (metrics.some((m) => m?.change === 'improved')) return 'improved';
  return 'unchanged';
}

interface TestResult {
  z: number;
  p: number;
}

// p50: rank-sum shift; p95: share of calls slower than the baseline p95; errors: error-rate test.
interface PendingTest {
  k: KeyComparison;
  p50: TestResult;
  p95: TestResult;
  errors: TestResult;
}

// Inclusive, so calls tied at the baseline p95 still count on both sides.
function countAtOrAbove(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

// k-th smallest (0-based) of two sorted arrays combined.
function kthOfBoth(a: ArrayLike<number>, b: ArrayLike<number>, k: number): number {
  let i = 0;
  let j = 0;
  for (let n = 0; n < k; n++) {
    if (j >= b.length || (i < a.length && a[i] <= b[j])) i++;
    else j++;
  }
  return j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i] : b[j];
}

// A tail-only change barely moves ranks, so p95 is tested on how often each side reaches the pooled p95
// (a quantile test). Pooling keeps it working when the baseline is flat and its own p95 ties with everything.
function tailTest(b: SideEntry, c: SideEntry): TestResult {
  const n1 = b.samples.length;
  const n2 = c.samples.length;
  if (!n1 || !n2) return { z: 0, p: 1 };
  const threshold = kthOfBoth(b.samples, c.samples, Math.floor(0.95 * (n1 + n2 - 1)));
  return proportionTest(countAtOrAbove(b.samples, threshold), n1, countAtOrAbove(c.samples, threshold), n2);
}

function compareSides(base: Side, cur: Side, s: BaselineSettings): ComparisonResult {
  const keys: KeyComparison[] = [];
  const tests: PendingTest[] = [];
  const allKeys = new Set([...base.entries.keys(), ...cur.entries.keys()]);

  for (const key of allKeys) {
    const b = base.entries.get(key);
    const c = cur.entries.get(key);
    const ref = (b ?? c)!;
    const k: KeyComparison = {
      target: ref.target,
      verdict: 'unchanged',
      p50: delta(b?.p50 ?? null, c?.p50 ?? null),
      p95: delta(b?.p95 ?? null, c?.p95 ?? null),
      errorRate: delta(b && b.count ? b.errors / b.count : null, c && c.count ? c.errors / c.count : null),
      exemplars: { base: b?.exemplars ?? [], current: c?.exemplars ?? [] },
    };
    if (ref.source !== undefined) k.source = ref.source;
    if (ref.op !== undefined) k.op = ref.op;
    if (b) k.base = { count: b.count, errors: b.errors };
    if (c) k.current = { count: c.count, errors: c.errors };
    if (ref.source !== undefined) k.fanout = delta(fanoutOf(base, b), fanoutOf(cur, c));
    keys.push(k);

    if (!b) {
      const scope = ref.op === undefined ? undefined : base.entries.get(keyOf(ref.source, ref.target));
      const hidden = ref.op === undefined ? base.truncated : scope ? scope.opsTruncated === true : base.truncated;
      k.verdict = hidden ? 'untracked' : 'new';
      continue;
    }
    if (!c) {
      k.verdict = b.count >= s.minSamples ? 'removed' : 'insufficient';
      continue;
    }
    if (b.count < s.minSamples || c.count < s.minSamples) {
      k.verdict = 'insufficient';
      continue;
    }
    tests.push({
      k,
      p50: mannWhitney(b.samples, c.samples),
      p95: tailTest(b, c),
      errors: proportionTest(b.errors, b.count, c.errors, c.count),
    });
    if (k.fanout && k.fanout.delta !== null) {
      const d = k.fanout.delta;
      if (d !== 0 && Math.abs(d) >= s.minFanoutChange) k.fanout.change = changeFor(direction(d));
    }
  }

  const q = bhAdjust(tests.flatMap((t) => [t.p50.p, t.p95.p, t.errors.p]));
  tests.forEach((t, i) => {
    const { k } = t;
    const latency: [MetricDelta, TestResult, number][] = [
      [k.p50, t.p50, q[3 * i]],
      [k.p95, t.p95, q[3 * i + 1]],
    ];
    for (const [m, test, mq] of latency) {
      m.p = test.p;
      m.q = mq;
      const dir = mq < SIGNIFICANCE ? direction(test.z) : 0;
      if (dir && latencyMeetsFloor(m, dir, s)) m.change = changeFor(dir);
    }
    const er = k.errorRate;
    er.p = t.errors.p;
    er.q = q[3 * i + 2];
    if (er.q < SIGNIFICANCE && er.delta !== null && Math.abs(er.delta) * 100 >= s.minErrorRateChangePp) {
      er.change = changeFor(direction(t.errors.z));
    }
    k.verdict = verdictOf(k);
  });

  keys.sort(
    (a, b) =>
      cmp(a.source ?? '', b.source ?? '') ||
      cmp(a.target, b.target) ||
      (a.op === undefined ? (b.op === undefined ? 0 : -1) : b.op === undefined ? 1 : cmp(a.op, b.op))
  );

  const summary: Record<Verdict, number> = { regressed: 0, improved: 0, unchanged: 0, insufficient: 0, new: 0, removed: 0, untracked: 0 };
  for (const k of keys) summary[k.verdict]++;

  const currentNodes = [...cur.nodes.keys()];
  const missingFromBase = currentNodes.filter((id) => !base.nodes.has(id)).length;
  const ratio = currentNodes.length ? missingFromBase / currentNodes.length : 0;
  const coverage: Coverage = {
    currentNodes: currentNodes.length,
    missingFromBase,
    ratio,
    warn: s.coverageWarnPct > 0 && ratio * 100 >= s.coverageWarnPct,
  };

  const nodes = new Map(base.nodes);
  for (const [id, n] of cur.nodes) nodes.set(id, n);
  return { keys, summary, coverage, nodes: [...nodes.values()].sort((a, b) => cmp(a.id, b.id)) };
}

export function compareToCurrent(baseline: Snapshot, current: Collected, settings: BaselineSettings): ComparisonResult {
  return compareSides(sideFromSnapshot(baseline), sideFromCollected(current), settings);
}

export function compareSnapshots(a: Snapshot, b: Snapshot, settings: BaselineSettings): ComparisonResult {
  return compareSides(sideFromSnapshot(a), sideFromSnapshot(b), settings);
}
