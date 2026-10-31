// SPDX-License-Identifier: Apache-2.0
// Per-instance usage tracking at ingest: volume and bytes per signal, unique values per attribute key,
// metric series, span names, operations, log templates and time buckets. Counts survive ring-buffer
// eviction; every structure is capped. Pure; no vscode import.

import { createRedactor } from '../../ai/redact';
import { AttributeValue, LogRecord, Metric, MetricType, ResourceInfo, Span } from '../model';
import { CardinalityBudget, CardinalityCaps, DEFAULT_CARDINALITY_CAPS, MAX_KEY_CHARS } from './budget';
import { ClassTally, classifyValue, hasIdPart } from './classify';
import { DistinctCounter } from './distinct';
import { DrainTemplater, SAMPLE_REDACT_CHARS } from './drain';
import { PROCESS_SEED, hashString, hashValue } from './hash';
import { AttrSink, ScopeGroup, Signal, Size, Volume, logSize, metricSize, pointSize, requestSize, spanSize } from './sizes';

export const BUCKETS = 60;
export const LIVE_BUCKET_MS = 60_000;
const MAX_FUTURE_MS = 86_400_000;
const MAX_OPERATION_CHARS = 200;
/** Unique span names checked for embedded ids. */
const CLASSIFIED_NAMES = 64;

export interface SignalBuckets {
  count: Float64Array;
  proto: Float64Array;
  json: Float64Array;
}

export interface KeyStats {
  readonly key: string;
  readonly distinct: DistinctCounter;
  readonly classes: ClassTally;
  /** First unique values, redacted and truncated. */
  readonly samples: string[];
  /** Unique-value estimate at the end of each bucket (NaN = no data), indexed like the volume buckets. */
  readonly history: Float32Array;
  occurrences: number;
  proto: number;
  json: number;
}

export interface OperationStats {
  count: number;
  errors: number;
  proto: number;
  json: number;
}

export interface MetricStats {
  readonly name: string;
  type: MetricType;
  readonly series: DistinctCounter;
  /** Series estimate at the end of each bucket, like KeyStats.history. */
  readonly history: Float32Array;
  readonly labels: Map<string, KeyStats>;
  points: number;
  proto: number;
  json: number;
}

export interface UsageTrackerOptions {
  budget: CardinalityBudget;
  caps?: CardinalityCaps;
  seed?: number;
  /** Redacts sample text for an attribute key (an empty key for names and log bodies). */
  redact?: (key: string, text: string) => string;
  bucketMs?: number;
  /** Live data: timestamps more than a day ahead of the clock are replaced by it. */
  live?: boolean;
  clock?: () => number;
}

const DEFAULT_REDACTOR = createRedactor();

/** Redacts with the built-in rules; values of sensitive keys are blanked. */
export function defaultRedact(key: string, text: string): string {
  if (!key) return DEFAULT_REDACTOR.text(text);
  const out = DEFAULT_REDACTOR.attrs({ [key]: text })[key];
  return typeof out === 'string' ? out : '';
}

/** Bucket width that fits an imported time range into the bucket ring (whole minutes, at least one). */
export function bucketMsForRange(minMs: number, maxMs: number): number {
  if (!(maxMs > minMs)) return LIVE_BUCKET_MS;
  return Math.max(LIVE_BUCKET_MS, Math.ceil((maxMs - minMs) / (BUCKETS - 1) / LIVE_BUCKET_MS) * LIVE_BUCKET_MS);
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const volume = (): Volume => ({ count: 0, proto: 0, json: 0 });
const signalBuckets = (): SignalBuckets => ({
  count: new Float64Array(BUCKETS),
  proto: new Float64Array(BUCKETS),
  json: new Float64Array(BUCKETS),
});
const nanHistory = () => new Float32Array(BUCKETS).fill(NaN);

function toText(v: AttributeValue): string {
  if (typeof v === 'string') return v;
  if (v === null || typeof v !== 'object') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

type GroupMap = Map<string, ScopeGroup & { size: Size }>;

export class UsageTracker {
  readonly bucketMs: number;
  readonly totals: Record<Signal, Volume> = { traces: volume(), logs: volume(), metrics: volume() };
  readonly buckets: Record<Signal, SignalBuckets> = { traces: signalBuckets(), logs: signalBuckets(), metrics: signalBuckets() };
  /** Bucket number (time / bucketMs) of the newest bucket; -Infinity before any data. */
  head = -Infinity;
  /** Earliest and latest record time seen (after clock substitution). */
  firstMs = Infinity;
  lastMs = -Infinity;

  readonly spanKeys = new Map<string, KeyStats>();
  readonly spanEventKeys = new Map<string, KeyStats>();
  readonly logKeys = new Map<string, KeyStats>();
  readonly metrics = new Map<string, MetricStats>();
  readonly operations = new Map<string, OperationStats>();
  readonly otherOperations: OperationStats = { count: 0, errors: 0, proto: 0, json: 0 };
  /** Points of metrics beyond the metric-name cap. */
  readonly otherMetrics: Volume = volume();
  readonly spanNames = new DistinctCounter();
  spanNamesClassified = 0;
  spanNamesWithIds = 0;
  readonly idNameSamples: string[] = [];
  readonly templates: DrainTemplater;
  /** Attribute occurrences not tracked because the key caps were reached. */
  droppedKeyOccurrences = 0;

  private readonly budget: CardinalityBudget;
  private readonly caps: CardinalityCaps;
  private readonly seed: number;
  private readonly redact: (key: string, text: string) => string;
  private readonly live: boolean;
  private readonly clock: () => number;
  private keyCount = 0;
  private metricCount = 0;
  private disposed = false;
  // Per-point state for the metric sink.
  private curLabels: Map<string, KeyStats> | undefined;
  private seriesAcc = 0;
  private seriesLen = 0;

  private readonly spanSink: AttrSink = (key, value, proto, json, scope) => {
    if (scope === 'link') return;
    this.touch(scope === 'event' ? this.spanEventKeys : this.spanKeys, key, value, hashValue(value, this.seed), proto, json);
  };

  private readonly logSink: AttrSink = (key, value, proto, json) => {
    this.touch(this.logKeys, key, value, hashValue(value, this.seed), proto, json);
  };

  private readonly metricSink: AttrSink = (key, value, proto, json) => {
    const vh = hashValue(value, this.seed);
    // Order-independent sum, so {a, b} and {b, a} are one series.
    this.seriesAcc = (this.seriesAcc + fmix(hashString(key, this.seed) ^ Math.imul(vh, 0x9e3779b1))) >>> 0;
    this.seriesLen++;
    if (this.curLabels) this.touch(this.curLabels, key, value, vh, proto, json);
  };

  constructor(opts: UsageTrackerOptions) {
    this.budget = opts.budget;
    this.caps = opts.caps ?? DEFAULT_CARDINALITY_CAPS;
    this.seed = opts.seed ?? PROCESS_SEED;
    this.redact = opts.redact ?? defaultRedact;
    this.bucketMs = opts.bucketMs ?? LIVE_BUCKET_MS;
    this.live = opts.live ?? true;
    this.clock = opts.clock ?? Date.now;
    this.templates = new DrainTemplater(
      { maxTemplates: this.caps.templatesPerInstance, sampleChars: this.caps.sampleChars },
      this.budget.templates,
      (s) => this.redact('', s)
    );
  }

  get trackedKeys(): number {
    return this.keyCount;
  }

  addSpans(resource: ResourceInfo, spans: readonly Span[]): void {
    if (this.disposed) return;
    const now = this.clock();
    const groups: GroupMap = new Map();
    let slot = -1;
    for (const s of spans) {
      if (!s.traceId || !s.spanId) continue;
      // Bucket first: advancing closes earlier buckets before this record's values are counted.
      slot = this.slot(this.time(s.startMs, now));
      const size = spanSize(s, this.spanSink);
      addToGroup(groups, s.scope, size);
      this.count('traces', slot, size);
      this.operation(s.name, s.statusCode === 'ERROR', size);
      this.spanName(s.name);
    }
    this.overhead('traces', resource, groups, slot);
  }

  addLogs(resource: ResourceInfo, logs: readonly LogRecord[]): void {
    if (this.disposed) return;
    const now = this.clock();
    const groups: GroupMap = new Map();
    let slot = -1;
    for (const l of logs) {
      const t = this.time(l.timeMs || l.observedTimeMs || 0, now);
      slot = this.slot(t);
      const size = logSize(l, this.logSink);
      addToGroup(groups, l.scope, size);
      this.count('logs', slot, size);
      this.templates.add(l.body, t, size.proto);
    }
    this.overhead('logs', resource, groups, slot);
  }

  addMetrics(resource: ResourceInfo, metrics: readonly Metric[]): void {
    if (this.disposed) return;
    const now = this.clock();
    const groups: GroupMap = new Map();
    let slot = -1;
    for (const m of metrics) {
      const stats = this.metricStats(m);
      const points: Size = { proto: 0, json: 0 };
      let n = 0;
      this.curLabels = stats?.labels;
      // Points of an unknown type are not encoded, so they cost nothing.
      if (m.type !== 'unknown') {
        for (const dp of m.dataPoints) {
          slot = this.slot(this.time(dp.timeMs, now));
          this.seriesAcc = 0;
          this.seriesLen = 0;
          const size = pointSize(m.type, dp, this.metricSink);
          points.proto += size.proto;
          points.json += size.json;
          n++;
          this.count('metrics', slot, size);
          if (stats) {
            stats.series.add(fmix((this.seriesAcc ^ this.seriesLen) >>> 0));
            stats.points++;
          } else {
            this.otherMetrics.count++;
            this.otherMetrics.proto += size.proto;
            this.otherMetrics.json += size.json;
          }
        }
      }
      this.curLabels = undefined;
      const whole = metricSize(m, points, n);
      this.addBytes('metrics', slot, whole.proto - points.proto, whole.json - points.json);
      if (stats) {
        stats.proto += whole.proto;
        stats.json += whole.json;
      }
      addToGroup(groups, undefined, whole);
    }
    this.overhead('metrics', resource, groups, slot);
  }

  /** Rough heap held by this tracker's counters, samples and buckets. */
  approxBytes(): number {
    let bytes = 3 * 3 * BUCKETS * 8 + this.spanNames.approxBytes() + this.operations.size * 120;
    const keyBytes = (k: KeyStats) => {
      bytes += 200 + k.distinct.approxBytes() + k.history.byteLength + k.key.length * 2;
      for (const s of k.samples) bytes += s.length * 2;
    };
    this.spanKeys.forEach(keyBytes);
    this.spanEventKeys.forEach(keyBytes);
    this.logKeys.forEach(keyBytes);
    for (const m of this.metrics.values()) {
      bytes += 200 + m.series.approxBytes() + m.history.byteLength + m.name.length * 2;
      m.labels.forEach(keyBytes);
    }
    return bytes;
  }

  /** Releases this tracker's share of the store-wide budgets. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.budget.keys.release(this.keyCount);
    this.budget.metrics.release(this.metricCount);
    this.templates.dispose();
    this.keyCount = 0;
    this.metricCount = 0;
  }

  private time(t: number | undefined, now: number): number {
    if (t === undefined || !(t > 0) || (this.live && t > now + MAX_FUTURE_MS)) return now;
    return t;
  }

  /** Ring index of the bucket holding `t`, advancing the ring if needed; -1 when older than the ring. */
  private slot(t: number): number {
    if (t < this.firstMs) this.firstMs = t;
    if (t > this.lastMs) this.lastMs = t;
    const b = Math.floor(t / this.bucketMs);
    if (b > this.head) this.advance(b);
    if (b <= this.head - BUCKETS) return -1;
    return b % BUCKETS;
  }

  private advance(b: number): void {
    const prev = this.head;
    this.head = b;
    const firstNew = prev === -Infinity ? b - BUCKETS + 1 : Math.max(prev + 1, b - BUCKETS + 1);
    for (const signal of ['traces', 'logs', 'metrics'] as const) {
      const sb = this.buckets[signal];
      for (let x = firstNew; x <= b; x++) {
        const i = x % BUCKETS;
        sb.count[i] = 0;
        sb.proto[i] = 0;
        sb.json[i] = 0;
      }
    }
    if (prev === -Infinity) return;
    // Close the previous bucket (and any skipped ones) with the current estimate; the new one is open.
    const from = Math.max(prev, b - BUCKETS);
    const stamp = (history: Float32Array, estimate: number) => {
      for (let x = from; x < b; x++) history[x % BUCKETS] = estimate;
      history[b % BUCKETS] = NaN;
    };
    const stampKey = (k: KeyStats) => stamp(k.history, k.distinct.estimate());
    this.spanKeys.forEach(stampKey);
    this.spanEventKeys.forEach(stampKey);
    this.logKeys.forEach(stampKey);
    for (const m of this.metrics.values()) {
      stamp(m.history, m.series.estimate());
      m.labels.forEach(stampKey);
    }
  }

  private count(signal: Signal, slot: number, size: Size): void {
    const t = this.totals[signal];
    t.count++;
    t.proto += size.proto;
    t.json += size.json;
    if (slot < 0) return;
    const b = this.buckets[signal];
    b.count[slot]++;
    b.proto[slot] += size.proto;
    b.json[slot] += size.json;
  }

  private addBytes(signal: Signal, slot: number, proto: number, json: number): void {
    const t = this.totals[signal];
    t.proto += proto;
    t.json += json;
    if (slot < 0) return;
    this.buckets[signal].proto[slot] += proto;
    this.buckets[signal].json[slot] += json;
  }

  /** Adds the request's resource and scope framing on top of its records. */
  private overhead(signal: Signal, resource: ResourceInfo, groups: GroupMap, slot: number): void {
    if (!groups.size) return;
    const list = [...groups.values()];
    const req = requestSize(signal, resource, list);
    let proto = req.proto;
    let json = req.json;
    for (const g of list) {
      proto -= g.size.proto;
      json -= g.size.json;
    }
    this.addBytes(signal, slot, proto, json);
  }

  private touch(map: Map<string, KeyStats>, key: string, value: AttributeValue, h: number, proto: number, json: number): void {
    let k = map.get(key);
    if (!k) {
      k = this.newKey(key);
      if (!k) {
        this.droppedKeyOccurrences++;
        return;
      }
      map.set(key, k);
    }
    k.occurrences++;
    k.proto += proto;
    k.json += json;
    if (k.distinct.add(h)) {
      if (!k.classes.full) k.classes.add(classifyValue(value));
      if (k.samples.length < this.caps.samplesPerKey) k.samples.push(this.sample(key, toText(value)));
    }
  }

  private newKey(key: string): KeyStats | undefined {
    if (key.length > MAX_KEY_CHARS || this.keyCount >= this.caps.keysPerInstance || !this.budget.keys.tryAcquire()) return undefined;
    this.keyCount++;
    return {
      key,
      distinct: new DistinctCounter(),
      classes: new ClassTally(),
      samples: [],
      history: nanHistory(),
      occurrences: 0,
      proto: 0,
      json: 0,
    };
  }

  private metricStats(m: Metric): MetricStats | undefined {
    let s = this.metrics.get(m.name);
    if (!s) {
      if (m.name.length > MAX_KEY_CHARS || this.metricCount >= this.caps.metricsPerInstance || !this.budget.metrics.tryAcquire()) {
        return undefined;
      }
      this.metricCount++;
      s = {
        name: m.name,
        type: m.type,
        series: new DistinctCounter(),
        history: nanHistory(),
        labels: new Map(),
        points: 0,
        proto: 0,
        json: 0,
      };
      this.metrics.set(m.name, s);
    }
    s.type = m.type;
    return s;
  }

  private operation(name: string, error: boolean, size: Size): void {
    const key = name.length > MAX_OPERATION_CHARS ? name.slice(0, MAX_OPERATION_CHARS) : name;
    let op = this.operations.get(key);
    if (!op) {
      if (this.operations.size < this.caps.operationsPerInstance) {
        op = { count: 0, errors: 0, proto: 0, json: 0 };
        this.operations.set(key, op);
      } else {
        op = this.otherOperations;
      }
    }
    op.count++;
    if (error) op.errors++;
    op.proto += size.proto;
    op.json += size.json;
  }

  private spanName(name: string): void {
    if (!this.spanNames.add(hashString(name, this.seed)) || this.spanNamesClassified >= CLASSIFIED_NAMES) return;
    this.spanNamesClassified++;
    if (!hasIdPart(name)) return;
    this.spanNamesWithIds++;
    if (this.idNameSamples.length < this.caps.samplesPerKey) this.idNameSamples.push(this.sample('', name));
  }

  private sample(key: string, text: string): string {
    const window = text.length > SAMPLE_REDACT_CHARS ? text.slice(0, SAMPLE_REDACT_CHARS) : text;
    const redacted = this.redact(key, window);
    const max = this.caps.sampleChars;
    return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
  }
}

function addToGroup(groups: GroupMap, scope: string | undefined, size: Size): void {
  const name = scope ?? '';
  let g = groups.get(name);
  if (!g) {
    g = { scope: scope || undefined, size: { proto: 0, json: 0 }, count: 0 };
    groups.set(name, g);
  }
  g.size.proto += size.proto;
  g.size.json += size.json;
  g.count++;
}
