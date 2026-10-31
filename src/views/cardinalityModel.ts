// SPDX-License-Identifier: Apache-2.0
// Aggregates usage trackers for a scope (realm, service, instance) into per-service facts, findings,
// rates, cost inputs and capped table rows for the panel and AI tool. No vscode import.

import { byCodeUnit } from '../compare';
import { DEFAULT_CARDINALITY_CAPS } from '../store/cardinality/budget';
import { DistinctCounter } from '../store/cardinality/distinct';
import { Signal, Volume } from '../store/cardinality/sizes';
import { BUCKETS, KeyStats, MetricStats, UsageTracker, defaultRedact } from '../store/cardinality/tracker';
import { ValueClass } from '../store/cardinality/valueClass';
import { MetricType } from '../store/model';
import { Instance } from '../store/store';
import { DailyUsage } from './cardinalityCost';
import {
  CardinalitySettings,
  Finding,
  Growth,
  KeyFacts,
  KeyScope,
  MetricFacts,
  ServiceFacts,
  Severity,
  dominantClass,
  evaluateFindings,
  growthOf,
  hintFor,
} from './cardinalityRules';

export interface CardinalityScope {
  realm: string;
  service?: string;
  instanceId?: string;
}

/** Rows per table sent to the panel or AI tool. */
export const MAX_ROWS = 500;
/** Labels listed per metric row. */
export const MAX_LABELS_PER_METRIC = 20;
/** Rates use at most the last 15 minutes of data. */
export const RATE_WINDOW_MS = 15 * 60_000;

const SIGNALS: readonly Signal[] = ['traces', 'logs', 'metrics'];
const SAMPLES = DEFAULT_CARDINALITY_CAPS.samplesPerKey;
const KEY_SCOPES: readonly [KeyScope, 'spanKeys' | 'spanEventKeys' | 'logKeys'][] = [
  ['span', 'spanKeys'],
  ['span.event', 'spanEventKeys'],
  ['log', 'logKeys'],
];

export interface SignalSeries {
  count: number[];
  proto: number[];
  json: number[];
}

export interface ServiceRow {
  service: string;
  instances: number;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  findings: Record<Severity, number>;
  trackedKeys: number;
  droppedKeyOccurrences: number;
}

export interface KeyRow extends Omit<KeyFacts, 'history' | 'classes' | 'growth'> {
  service: string;
  ratio: number;
  bytesShare: number;
  classes: readonly [ValueClass, number][];
  growth: Growth;
  /** Unique-value estimate per bucket, oldest first, aligned with the model's buckets. */
  history: number[];
  hint?: string;
  prefer?: readonly string[];
  /** Highest severity among this row's findings. */
  severity?: Severity;
}

export interface MetricRow {
  service: string;
  name: string;
  type: MetricType;
  series: number;
  approx: boolean;
  points: number;
  proto: number;
  json: number;
  growth: Growth;
  history: number[];
  labels: { key: string; distinct: number; approx: boolean; valueClass?: ValueClass }[];
  severity?: Severity;
}

export interface OperationRow {
  service: string;
  name: string;
  count: number;
  errors: number;
  proto: number;
  json: number;
  /** "(other)": operations beyond the per-instance cap. */
  other: boolean;
}

export interface TemplateRow {
  service: string;
  text: string;
  count: number;
  /** Share of the service's logs. */
  share: number;
  proto: number;
  sample: string;
  other: boolean;
  severity?: Severity;
}

export interface SpanNameRow {
  service: string;
  distinct: number;
  approx: boolean;
  classified: number;
  withIds: number;
  samples: readonly string[];
  severity?: Severity;
}

export interface CardinalityModel {
  scope: CardinalityScope;
  bucketMs: number;
  /** Newest bucket number; series index i covers bucket head - (BUCKETS - 1) + i. -Infinity with no data. */
  head: number;
  firstMs: number;
  lastMs: number;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  windowMinutes: number;
  buckets: Record<Signal, SignalSeries>;
  activeSeries: number;
  services: ServiceRow[];
  keys: KeyRow[];
  metrics: MetricRow[];
  operations: OperationRow[];
  templates: TemplateRow[];
  spanNames: SpanNameRow[];
  /** The first MAX_ROWS findings; `findingsTotal` counts all of them. */
  findings: Finding[];
  findingsTotal: number;
  /** All findings counted by signal and severity. */
  findingCounts: Record<Signal, Record<Severity, number>>;
  /** Whether any table or the findings list was cut to MAX_ROWS. */
  rowsTruncated: boolean;
}

export interface ModelOptions {
  /** Applied to every sample on output (samples were already redacted at capture). */
  redact?: (key: string, text: string) => string;
}

const volume = (): Volume => ({ count: 0, proto: 0, json: 0 });
const volumes = (): Record<Signal, Volume> => ({ traces: volume(), logs: volume(), metrics: volume() });

/** Instances in the scope that have usage counters. */
export function scopeInstances(instances: readonly Instance[], scope: CardinalityScope): Instance[] {
  return instances.filter(
    (i) =>
      i.usage !== undefined &&
      i.realm === scope.realm &&
      (scope.service === undefined || i.serviceName === scope.service) &&
      (scope.instanceId === undefined || i.id === scope.instanceId)
  );
}

interface BucketWindow {
  head: number;
  bucketMs: number;
}

function windowOf(trackers: readonly UsageTracker[]): BucketWindow {
  let head = -Infinity;
  for (const t of trackers) if (t.head > head) head = t.head;
  return { head, bucketMs: trackers[0]?.bucketMs ?? 60_000 };
}

const ringIndex = (b: number) => ((b % BUCKETS) + BUCKETS) % BUCKETS;

/** Volume per bucket for buckets head-59..head; buckets the tracker no longer holds count as 0. */
function alignedVolume(t: UsageTracker, ring: Float64Array, head: number, out: number[]): void {
  if (t.head === -Infinity) return;
  const first = head - (BUCKETS - 1);
  let idx = ringIndex(first);
  for (let i = 0; i < BUCKETS; i++) {
    const b = first + i;
    if (b <= t.head && b > t.head - BUCKETS) out[i] += ring[idx];
    idx = idx === BUCKETS - 1 ? 0 : idx + 1;
  }
}

/**
 * Feeds one tracker's closing estimates for buckets head-59..head-1 to `visit` in time order (index 0 = oldest);
 * buckets after the tracker's newest one carry its current estimate, the model's newest bucket is still open.
 */
function eachClosing(t: UsageTracker, ring: Float32Array, estimate: number, head: number, visit: (i: number, v: number) => void): void {
  if (t.head === -Infinity) return;
  const first = head - (BUCKETS - 1);
  const own = t.head - first;
  const from = Math.max(0, own - (BUCKETS - 1));
  const to = Math.min(BUCKETS - 1, own);
  let idx = ringIndex(first + from);
  for (let i = from; i < to; i++) {
    visit(i, ring[idx]);
    idx = idx === BUCKETS - 1 ? 0 : idx + 1;
  }
  for (let i = Math.max(0, own); i < BUCKETS - 1; i++) visit(i, estimate);
}

function alignedHistory(t: UsageTracker, ring: Float32Array, estimate: number, head: number, out: Float64Array): void {
  eachClosing(t, ring, estimate, head, (i, v) => {
    if (!Number.isNaN(v)) out[i] = Number.isNaN(out[i]) ? v : out[i] + v;
  });
}

/** growthOf for one tracker's closing estimates, read straight from its ring (equivalent to the aligned history). */
function ringGrowth(t: UsageTracker, ring: Float32Array, estimate: number, head: number): Growth {
  if (t.head === -Infinity) return 'insufficient';
  const first = head - (BUCKETS - 1);
  const own = t.head - first;
  const from = Math.max(0, own - (BUCKETS - 1));
  const to = Math.min(BUCKETS - 1, own);
  const tail = Number.isFinite(estimate) ? BUCKETS - 1 - Math.max(0, own) : 0;
  const start = ringIndex(first + from);
  let n = tail;
  for (let i = from, idx = start; i < to; i++, idx = idx === BUCKETS - 1 ? 0 : idx + 1) if (Number.isFinite(ring[idx])) n++;
  if (n < 4) return 'insufficient';
  const diffs = n - 1;
  const third = Math.max(1, Math.floor(diffs / 3));
  let prev = Number.NaN;
  let d = 0;
  let early = 0;
  let late = 0;
  const add = (v: number): void => {
    if (!Number.isNaN(prev)) {
      const diff = Math.max(0, v - prev);
      if (d < third) early += diff;
      if (d >= diffs - third) late += diff;
      d++;
    }
    prev = v;
  };
  for (let i = from, idx = start; i < to; i++, idx = idx === BUCKETS - 1 ? 0 : idx + 1) if (Number.isFinite(ring[idx])) add(ring[idx]);
  for (let i = 0; i < tail; i++) add(estimate);
  return late > 0 && late >= 0.5 * early ? 'growing' : 'saturated';
}

function mergeClasses(lists: readonly (readonly [ValueClass, number][])[]): [ValueClass, number][] {
  if (lists.length === 1) return [...lists[0]];
  const counts = new Map<ValueClass, number>();
  for (const l of lists) for (const [cls, n] of l) counts.set(cls, (counts.get(cls) ?? 0) + n);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]));
}

function mergeSamples(lists: readonly (readonly string[])[], limit: number): string[] {
  const out: string[] = [];
  for (const l of lists) for (const s of l) if (out.length < limit && !out.includes(s)) out.push(s);
  return out;
}

function estimateOf(counters: readonly DistinctCounter[]): { distinct: number; approx: boolean } {
  if (counters.length === 1) return { distinct: Math.round(counters[0].estimate()), approx: counters[0].approx };
  const merged = new DistinctCounter();
  for (const c of counters) merged.mergeFrom(c);
  return { distinct: Math.round(merged.estimate()), approx: merged.approx };
}

const nanSeries = () => new Float64Array(BUCKETS).fill(Number.NaN);
// Reused for growth checks, so flagging thousands of keys allocates no histories.
const scratch = new Float64Array(BUCKETS);

interface Parts {
  stats: KeyStats[];
  trackers: UsageTracker[];
}

/** Memoized, so a history is only aligned when a rule or a kept row asks for it. */
function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

// Most keys live on one instance: their values are read straight from it, and the lazy parts are prototype
// methods, so flagging thousands of keys allocates no closures.
class SingleKeyFacts implements KeyFacts {
  readonly distinct: number;
  readonly approx: boolean;
  readonly occurrences: number;
  readonly proto: number;
  readonly json: number;
  readonly valueClass: ValueClass | undefined;
  readonly samples: readonly string[];
  private cachedHistory: Float64Array | undefined;
  private cachedGrowth: Growth | undefined;

  constructor(
    readonly scope: KeyScope,
    readonly key: string,
    private readonly stats: KeyStats,
    private readonly tracker: UsageTracker,
    private readonly head: number
  ) {
    this.distinct = Math.round(stats.distinct.estimate());
    this.approx = stats.distinct.approx;
    this.occurrences = stats.occurrences;
    this.proto = stats.proto;
    this.json = stats.json;
    this.valueClass = stats.classes.dominant();
    this.samples = stats.samples;
  }

  classes(): readonly [ValueClass, number][] {
    return this.stats.classes.entries();
  }

  history(): Float64Array {
    if (!this.cachedHistory) {
      this.cachedHistory = nanSeries();
      alignedHistory(this.tracker, this.stats.history, this.stats.distinct.estimate(), this.head, this.cachedHistory);
    }
    return this.cachedHistory;
  }

  growth(): Growth {
    return (this.cachedGrowth ??= ringGrowth(this.tracker, this.stats.history, this.stats.distinct.estimate(), this.head));
  }
}

function keyFacts(scope: KeyScope, key: string, parts: Parts, win: BucketWindow): KeyFacts {
  if (parts.stats.length === 1) return new SingleKeyFacts(scope, key, parts.stats[0], parts.trackers[0], win.head);
  const fill = (out: Float64Array): Float64Array => {
    out.fill(Number.NaN);
    for (let i = 0; i < parts.stats.length; i++) {
      const k = parts.stats[i];
      alignedHistory(parts.trackers[i], k.history, k.distinct.estimate(), win.head, out);
    }
    return out;
  };
  const history = lazy(() => fill(nanSeries()));
  const growth = lazy(() => growthOf(fill(scratch)));
  let occurrences = 0;
  let proto = 0;
  let json = 0;
  for (const k of parts.stats) {
    occurrences += k.occurrences;
    proto += k.proto;
    json += k.json;
  }
  const classes = mergeClasses(parts.stats.map((k) => k.classes.entries()));
  return {
    scope,
    key,
    ...estimateOf(parts.stats.map((k) => k.distinct)),
    occurrences,
    proto,
    json,
    valueClass: dominantClass(classes),
    classes: () => classes,
    samples: mergeSamples(parts.stats.map((k) => k.samples), SAMPLES),
    history,
    growth,
  };
}

function addPart(map: Map<string, Parts>, key: string, stats: KeyStats, t: UsageTracker): void {
  let p = map.get(key);
  if (!p) map.set(key, (p = { stats: [], trackers: [] }));
  p.stats.push(stats);
  p.trackers.push(t);
}

interface ServiceAgg {
  facts: ServiceFacts;
  row: ServiceRow;
  operations: OperationRow[];
  templates: TemplateRow[];
  spanNames: SpanNameRow;
}

// Samples here are as captured (already redacted once); the model redacts again only what it outputs.
function aggregateService(service: string, instances: readonly Instance[], win: BucketWindow): ServiceAgg {
  const trackers = instances.map((i) => i.usage!);
  const totals = volumes();
  let trackedKeys = 0;
  let dropped = 0;
  for (const t of trackers) {
    for (const s of SIGNALS) {
      totals[s].count += t.totals[s].count;
      totals[s].proto += t.totals[s].proto;
      totals[s].json += t.totals[s].json;
    }
    trackedKeys += t.trackedKeys;
    dropped += t.droppedKeyOccurrences;
  }

  const keys: KeyFacts[] = [];
  for (const [scope, field] of KEY_SCOPES) {
    if (trackers.length === 1) {
      const t = trackers[0];
      for (const [k, stats] of t[field]) keys.push(keyFacts(scope, k, { stats: [stats], trackers: [t] }, win));
      continue;
    }
    const byKey = new Map<string, Parts>();
    for (const t of trackers) for (const [k, stats] of t[field]) addPart(byKey, k, stats, t);
    for (const [k, parts] of byKey) keys.push(keyFacts(scope, k, parts, win));
  }

  const metrics: MetricFacts[] = [];
  const byMetric = new Map<string, { stats: MetricStats[]; trackers: UsageTracker[] }>();
  for (const t of trackers) {
    for (const [name, m] of t.metrics) {
      let p = byMetric.get(name);
      if (!p) byMetric.set(name, (p = { stats: [], trackers: [] }));
      p.stats.push(m);
      p.trackers.push(t);
    }
  }
  for (const [name, p] of byMetric) {
    let points = 0;
    let proto = 0;
    let json = 0;
    const labelParts = new Map<string, Parts>();
    p.stats.forEach((m, i) => {
      points += m.points;
      proto += m.proto;
      json += m.json;
      for (const [label, stats] of m.labels) addPart(labelParts, label, stats, p.trackers[i]);
    });
    const series = estimateOf(p.stats.map((m) => m.series));
    const fill = (out: Float64Array): Float64Array => {
      out.fill(Number.NaN);
      p.stats.forEach((m, i) => alignedHistory(p.trackers[i], m.history, m.series.estimate(), win.head, out));
      return out;
    };
    metrics.push({
      name,
      type: p.stats[p.stats.length - 1].type,
      series: series.distinct,
      approx: series.approx,
      points,
      proto,
      json,
      history: lazy(() => fill(nanSeries())),
      growth: lazy(() =>
        p.stats.length === 1
          ? ringGrowth(p.trackers[0], p.stats[0].history, p.stats[0].series.estimate(), win.head)
          : growthOf(fill(scratch))
      ),
      labels: [...labelParts].map(([label, parts]) => keyFacts('metric', label, parts, win)),
    });
  }

  const ops = new Map<string, OperationRow>();
  const other: OperationRow = { service, name: '(other)', count: 0, errors: 0, proto: 0, json: 0, other: true };
  for (const t of trackers) {
    for (const [name, op] of t.operations) {
      let row = ops.get(name);
      if (!row) ops.set(name, (row = { service, name, count: 0, errors: 0, proto: 0, json: 0, other: false }));
      row.count += op.count;
      row.errors += op.errors;
      row.proto += op.proto;
      row.json += op.json;
    }
    other.count += t.otherOperations.count;
    other.errors += t.otherOperations.errors;
    other.proto += t.otherOperations.proto;
    other.json += t.otherOperations.json;
  }
  const operations = [...ops.values()];
  if (other.count) operations.push(other);

  const tpl = new Map<string, { count: number; proto: number; sample: string }>();
  let otherLogs = 0;
  let otherLogBytes = 0;
  for (const t of trackers) {
    for (const x of t.templates.templates()) {
      const e = tpl.get(x.text);
      if (e) {
        e.count += x.count;
        e.proto += x.bytes;
      } else {
        tpl.set(x.text, { count: x.count, proto: x.bytes, sample: x.sample });
      }
    }
    otherLogs += t.templates.other.count;
    otherLogBytes += t.templates.other.bytes;
  }
  const logs = totals.logs.count;
  const templates: TemplateRow[] = [...tpl].map(([text, e]) => ({ service, text, count: e.count, share: logs ? e.count / logs : 0, proto: e.proto, sample: e.sample, other: false }));
  if (otherLogs) templates.push({ service, text: '(other)', count: otherLogs, share: logs ? otherLogs / logs : 0, proto: otherLogBytes, sample: '', other: true });

  const names = estimateOf(trackers.map((t) => t.spanNames));
  let classified = 0;
  let withIds = 0;
  for (const t of trackers) {
    classified += t.spanNamesClassified;
    withIds += t.spanNamesWithIds;
  }
  const nameSamples = mergeSamples(trackers.map((t) => t.idNameSamples), SAMPLES);
  const spanNames: SpanNameRow = { service, ...names, classified, withIds, samples: nameSamples };

  const facts: ServiceFacts = {
    service,
    bytes: { traces: totals.traces.proto, logs: totals.logs.proto, metrics: totals.metrics.proto },
    logs,
    keys,
    metrics,
    spanNames,
    templates: templates.filter((t) => !t.other).map((t) => ({ text: t.text, count: t.count, proto: t.proto, sample: t.sample })),
  };
  return {
    facts,
    row: {
      service,
      instances: instances.length,
      totals,
      perMinute: volumes(),
      findings: { critical: 0, warning: 0, info: 0 },
      trackedKeys,
      droppedKeyOccurrences: dropped,
    },
    operations,
    templates,
    spanNames,
  };
}

function byService(instances: readonly Instance[]): Map<string, Instance[]> {
  const out = new Map<string, Instance[]>();
  for (const i of instances) {
    const list = out.get(i.serviceName);
    if (list) list.push(i);
    else out.set(i.serviceName, [i]);
  }
  return out;
}

/** Findings only, unordered (for badges and the status bar): no rows, rates, sorting or redaction pass. */
export function findingsFor(instances: readonly Instance[], settings: CardinalitySettings): Finding[] {
  const tracked = instances.filter((i) => i.usage);
  const win = windowOf(tracked.map((i) => i.usage!));
  const facts = [...byService(tracked)].map(([svc, list]) => aggregateService(svc, list, win).facts);
  return evaluateFindings(facts, settings, false);
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
const severityCounts = (): Record<Severity, number> => ({ critical: 0, warning: 0, info: 0 });

/** Highest severity per row identity: attribute, metric, span names or template. */
function severityIndex(findings: readonly Finding[]): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const f of findings) {
    let parts: string[];
    if (f.kind === 'attribute') parts = ['a', f.service, f.scope ?? '', f.key];
    else if (f.kind === 'metricSeries') parts = ['m', f.service, f.key];
    else if (f.kind === 'metricLabel') parts = ['m', f.service, f.metric ?? ''];
    else if (f.kind === 'spanNames') parts = ['s', f.service];
    else parts = ['t', f.service, f.key];
    const id = parts.join('\u0000');
    const prev = out.get(id);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev]) out.set(id, f.severity);
  }
  return out;
}

const withSeverity = (severity: Severity | undefined): { severity?: Severity } => (severity ? { severity } : {});

function capRows<T>(rows: T[], compare: (a: T, b: T) => number): { rows: T[]; cut: boolean } {
  rows.sort(compare);
  return rows.length > MAX_ROWS ? { rows: rows.slice(0, MAX_ROWS), cut: true } : { rows, cut: false };
}

function emptySeries(): SignalSeries {
  return { count: new Array<number>(BUCKETS).fill(0), proto: new Array<number>(BUCKETS).fill(0), json: new Array<number>(BUCKETS).fill(0) };
}

function bucketSeries(trackers: readonly UsageTracker[], head: number): Record<Signal, SignalSeries> {
  const out = { traces: emptySeries(), logs: emptySeries(), metrics: emptySeries() };
  if (head === -Infinity) return out;
  for (const s of SIGNALS) {
    for (const t of trackers) {
      alignedVolume(t, t.buckets[s].count, head, out[s].count);
      alignedVolume(t, t.buckets[s].proto, head, out[s].proto);
      alignedVolume(t, t.buckets[s].json, head, out[s].json);
    }
  }
  return out;
}

const totalBytes = (v: Record<Signal, Volume>) => v.traces.proto + v.logs.proto + v.metrics.proto;

export interface ServiceAggregate {
  facts: ServiceFacts;
  row: ServiceRow;
  operations: OperationRow[];
  templates: TemplateRow[];
  spanNames: SpanNameRow;
  firstMs: number;
  lastMs: number;
}

/** Per-service facts and rows for a scope, with bucket series and rates; no findings, sorting or redaction. */
export interface ScopeAggregate {
  bucketMs: number;
  head: number;
  firstMs: number;
  lastMs: number;
  windowMinutes: number;
  buckets: Record<Signal, SignalSeries>;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  activeSeries: number;
  services: ServiceAggregate[];
}

function timeSpan(trackers: readonly UsageTracker[]): { firstMs: number; lastMs: number } {
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const t of trackers) {
    if (t.firstMs < firstMs) firstMs = t.firstMs;
    if (t.lastMs > lastMs) lastMs = t.lastMs;
  }
  return { firstMs, lastMs };
}

export function aggregateScope(instances: readonly Instance[], scope: CardinalityScope): ScopeAggregate {
  const inScope = scopeInstances(instances, scope);
  const trackers = inScope.map((i) => i.usage!);
  const win = windowOf(trackers);
  const buckets = bucketSeries(trackers, win.head);
  const { firstMs, lastMs } = timeSpan(trackers);
  // Rates over the last min(15 minutes, observed span); the newest bucket is partial, so time runs to lastMs.
  const k = Math.max(1, Math.min(BUCKETS, Math.ceil(RATE_WINDOW_MS / win.bucketMs)));
  const windowStart = Math.max(firstMs, (win.head - k + 1) * win.bucketMs);
  const windowMinutes = win.head === -Infinity ? 0 : Math.max(1, (lastMs - windowStart) / 60_000);
  const rateOf = (series: Record<Signal, SignalSeries>): Record<Signal, Volume> => {
    const out = volumes();
    if (!windowMinutes) return out;
    for (const s of SIGNALS) {
      for (let i = BUCKETS - k; i < BUCKETS; i++) {
        out[s].count += series[s].count[i];
        out[s].proto += series[s].proto[i];
        out[s].json += series[s].json[i];
      }
      out[s].count /= windowMinutes;
      out[s].proto /= windowMinutes;
      out[s].json /= windowMinutes;
    }
    return out;
  };

  const totals = volumes();
  let activeSeries = 0;
  const services = [...byService(inScope)].map(([svc, list]): ServiceAggregate => {
    const own = list.map((i) => i.usage!);
    const a = aggregateService(svc, list, win);
    a.row.perMinute = rateOf(bucketSeries(own, win.head));
    for (const s of SIGNALS) {
      totals[s].count += a.row.totals[s].count;
      totals[s].proto += a.row.totals[s].proto;
      totals[s].json += a.row.totals[s].json;
    }
    for (const m of a.facts.metrics) activeSeries += m.series;
    return { ...a, ...timeSpan(own) };
  });
  return {
    bucketMs: win.bucketMs,
    head: win.head,
    firstMs,
    lastMs,
    windowMinutes,
    buckets,
    totals,
    perMinute: rateOf(buckets),
    activeSeries,
    services,
  };
}

export function buildCardinalityModel(
  instances: readonly Instance[],
  scope: CardinalityScope,
  settings: CardinalitySettings,
  opts: ModelOptions = {}
): CardinalityModel {
  const redact = opts.redact ?? defaultRedact;
  const agg = aggregateScope(instances, scope);
  const aggs = agg.services;
  const allFindings = evaluateFindings(
    aggs.map((a) => a.facts),
    settings
  );
  const rows = new Map(aggs.map((a) => [a.row.service, a.row]));
  for (const f of allFindings) rows.get(f.service)!.findings[f.severity]++;
  const findingCounts = { traces: severityCounts(), logs: severityCounts(), metrics: severityCounts() };
  for (const f of allFindings) findingCounts[f.signal][f.severity]++;
  const severities = severityIndex(allFindings);
  const severityOf = (kind: string, service: string, ...parts: string[]) => severities.get([kind, service, ...parts].join('\u0000'));

  const byBytes =
    <T extends { proto: number; service: string }>(name: (x: T) => string) =>
    (a: T, b: T) =>
      b.proto - a.proto || byCodeUnit(a.service, b.service) || byCodeUnit(name(a), name(b));
  type Owned<T> = { service: string; proto: number; facts: T; svc: ServiceFacts };
  const keyFactsRows = capRows(
    aggs.flatMap((a) => a.facts.keys.map((k): Owned<KeyFacts> => ({ service: a.row.service, proto: k.proto, facts: k, svc: a.facts }))),
    byBytes<Owned<KeyFacts>>((x) => `${x.facts.scope}\u0000${x.facts.key}`)
  );
  const metricFactsRows = capRows(
    aggs.flatMap((a) => a.facts.metrics.map((m): Owned<MetricFacts> => ({ service: a.row.service, proto: m.proto, facts: m, svc: a.facts }))),
    byBytes<Owned<MetricFacts>>((x) => x.facts.name)
  );
  const operations = capRows(aggs.flatMap((a) => a.operations), byBytes<OperationRow>((x) => x.name));
  const templates = capRows(
    aggs.flatMap((a) => a.templates),
    (a, b) => b.count - a.count || byCodeUnit(a.service, b.service) || byCodeUnit(a.text, b.text)
  );
  const findings = allFindings.length > MAX_ROWS ? allFindings.slice(0, MAX_ROWS) : allFindings;
  const services = aggs
    .map((a) => a.row)
    .sort((a, b) => totalBytes(b.totals) - totalBytes(a.totals) || byCodeUnit(a.service, b.service));

  const keys = keyFactsRows.rows.map(({ service, facts: k, svc }): KeyRow => {
    const cls = k.valueClass;
    const signalBytes = svc.bytes[k.scope === 'log' ? 'logs' : 'traces'];
    const history = Array.from(k.history());
    return {
      scope: k.scope,
      key: k.key,
      distinct: k.distinct,
      approx: k.approx,
      occurrences: k.occurrences,
      proto: k.proto,
      json: k.json,
      classes: k.classes(),
      samples: k.samples.map((s) => redact(k.key, s)),
      service,
      history,
      // A sketch estimate can slightly exceed the occurrences.
      ratio: k.occurrences ? Math.min(1, k.distinct / k.occurrences) : 0,
      bytesShare: signalBytes ? k.proto / signalBytes : 0,
      valueClass: cls,
      growth: growthOf(history),
      ...hintFor(k.key, cls),
      ...withSeverity(severityOf('a', service, k.scope, k.key)),
    };
  });
  const metrics = metricFactsRows.rows.map(({ service, facts: m }): MetricRow => {
    const history = Array.from(m.history());
    return {
      service,
      name: m.name,
      type: m.type,
      series: m.series,
      approx: m.approx,
      points: m.points,
      proto: m.proto,
      json: m.json,
      growth: growthOf(history),
      history,
      labels: [...m.labels]
        .sort((a, b) => b.distinct - a.distinct || byCodeUnit(a.key, b.key))
        .slice(0, MAX_LABELS_PER_METRIC)
        .map((l) => ({ key: l.key, distinct: l.distinct, approx: l.approx, valueClass: l.valueClass })),
      ...withSeverity(severityOf('m', service, m.name)),
    };
  });

  return {
    scope,
    bucketMs: agg.bucketMs,
    head: agg.head,
    firstMs: agg.firstMs,
    lastMs: agg.lastMs,
    totals: agg.totals,
    perMinute: agg.perMinute,
    windowMinutes: agg.windowMinutes,
    buckets: agg.buckets,
    activeSeries: agg.activeSeries,
    services,
    keys,
    metrics,
    operations: operations.rows,
    templates: templates.rows.map((t) => ({
      ...t,
      // Templates keep body text that masking did not catch, so they are redacted like samples.
      text: t.other ? t.text : redact('', t.text),
      sample: t.sample && redact('', t.sample),
      ...withSeverity(t.other ? undefined : severityOf('t', t.service, t.text)),
    })),
    spanNames: aggs
      .map((a) => ({
        ...a.spanNames,
        samples: a.spanNames.samples.map((s) => redact('', s)),
        ...withSeverity(severityOf('s', a.spanNames.service)),
      }))
      .sort((a, b) => b.distinct - a.distinct || byCodeUnit(a.service, b.service)),
    findings: findings.map((f) => ({
      ...f,
      key: f.kind === 'logTemplate' ? redact('', f.key) : f.key,
      samples: f.samples.map((s) => redact(f.kind === 'attribute' || f.kind === 'metricLabel' ? f.key : '', s)),
    })),
    findingsTotal: allFindings.length,
    findingCounts,
    rowsTruncated: keyFactsRows.cut || metricFactsRows.cut || operations.cut || templates.cut || findings !== allFindings,
  };
}

/** Observed usage per day for the cost estimate. */
export function dailyUsage(model: CardinalityModel): DailyUsage {
  const perMin = model.perMinute;
  const bytes = (field: 'proto' | 'json') => (perMin.traces[field] + perMin.logs[field] + perMin.metrics[field]) * 1440;
  return {
    bytes: { protobuf: bytes('proto'), json: bytes('json') },
    spans: perMin.traces.count * 1440,
    logs: perMin.logs.count * 1440,
    activeSeries: model.activeSeries,
    windowMinutes: model.windowMinutes,
  };
}
