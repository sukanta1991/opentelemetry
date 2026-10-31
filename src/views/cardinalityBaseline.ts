// SPDX-License-Identifier: Apache-2.0
// Captures cardinality summaries for baselines and compares two of them. No vscode import.

import { byCodeUnit } from '../compare';
import { keyHint } from '../store/cardinality/keyHints';
import { Signal, Volume } from '../store/cardinality/sizes';
import { ID_CLASSES } from '../store/cardinality/valueClass';
import { Instance } from '../store/store';
import { CardinalityScope, aggregateScope } from './cardinalityModel';
import { CardinalitySettings, ID_LIKE_MIN_DISTINCT } from './cardinalityRules';
import {
  CardinalityChange,
  CardinalityComparison,
  CardinalitySummary,
  ChangeVerdict,
  SUMMARY_LIMITS,
  ServiceSummary,
  SummaryKey,
  SummaryMetric,
  SummaryScope,
  VolumeChange,
} from './cardinalitySummary';

/** Relative change in per-minute volume worth reporting. */
export const VOLUME_CHANGE = 0.25;
/** A flagged key "grew" when its unique values at least doubled and rose by at least minDistinct. */
export const GROWTH_FACTOR = 2;

const SIGNALS: readonly Signal[] = ['traces', 'logs', 'metrics'];
const bytesOf = (v: Record<Signal, Volume>) => v.traces.proto + v.logs.proto + v.metrics.proto;
const copy = (v: Volume): Volume => ({ count: v.count, proto: v.proto, json: v.json });
const copyAll = (r: Record<Signal, Volume>): Record<Signal, Volume> => ({ traces: copy(r.traces), logs: copy(r.logs), metrics: copy(r.metrics) });

const keyOrder = (a: SummaryKey, b: SummaryKey) =>
  b.distinct - a.distinct || b.proto - a.proto || byCodeUnit(a.scope, b.scope) || byCodeUnit(a.key, b.key);
const metricOrder = (a: SummaryMetric, b: SummaryMetric) => b.series - a.series || b.points - a.points || byCodeUnit(a.name, b.name);

/** Keeps the top `total` items across services; marks services that lost items. */
function capTotal<T>(services: ServiceSummary[], items: (s: ServiceSummary) => T[], set: (s: ServiceSummary, kept: T[]) => void, order: (a: T, b: T) => number, total: number): void {
  const all: { s: ServiceSummary; item: T }[] = [];
  for (const s of services) for (const item of items(s)) all.push({ s, item });
  if (all.length <= total) return;
  all.sort((a, b) => order(a.item, b.item) || byCodeUnit(a.s.service, b.s.service));
  const keep = new Set(all.slice(0, total).map((x) => x.item));
  for (const s of services) {
    const before = items(s);
    const kept = before.filter((x) => keep.has(x));
    if (kept.length !== before.length) set(s, kept);
  }
}

/** Summary of the usage counters in a scope, or undefined when nothing has been counted. */
export function captureCardinality(instances: readonly Instance[], scope: CardinalityScope): CardinalitySummary | undefined {
  const agg = aggregateScope(instances, scope);
  if (!Number.isFinite(agg.firstMs) || !Number.isFinite(agg.lastMs)) return undefined;
  const all = agg.services
    .filter((a) => Number.isFinite(a.firstMs))
    .sort((a, b) => bytesOf(b.row.totals) - bytesOf(a.row.totals) || byCodeUnit(a.row.service, b.row.service));
  const services = all.slice(0, SUMMARY_LIMITS.services).map((a): ServiceSummary => {
    const keys = a.facts.keys
      .map((k): SummaryKey => {
        const out: SummaryKey = { scope: k.scope as SummaryScope, key: k.key, distinct: k.distinct, approx: k.approx, occurrences: k.occurrences, proto: k.proto };
        if (k.valueClass) out.cls = k.valueClass;
        return out;
      })
      .sort(keyOrder);
    const metrics = a.facts.metrics
      .map((m): SummaryMetric => {
        let driver: (typeof m.labels)[number] | undefined;
        for (const l of m.labels) if (!driver || l.distinct > driver.distinct || (l.distinct === driver.distinct && byCodeUnit(l.key, driver.key) < 0)) driver = l;
        const out: SummaryMetric = { name: m.name, series: m.series, approx: m.approx, points: m.points };
        if (driver) out.driver = driver.key;
        return out;
      })
      .sort(metricOrder);
    return {
      service: a.row.service.slice(0, SUMMARY_LIMITS.serviceName),
      totals: copyAll(a.row.totals),
      perMinute: copyAll(a.row.perMinute),
      observedMs: Math.max(0, a.lastMs - a.firstMs),
      spanNames: a.facts.spanNames.distinct,
      templates: a.facts.templates.length,
      keys: keys.slice(0, SUMMARY_LIMITS.keysPerService),
      keysTruncated: keys.length > SUMMARY_LIMITS.keysPerService,
      metrics: metrics.slice(0, SUMMARY_LIMITS.metricsPerService),
      metricsTruncated: metrics.length > SUMMARY_LIMITS.metricsPerService,
    };
  });
  const cutKeys = (s: ServiceSummary, kept: SummaryKey[]) => {
    s.keys = kept;
    s.keysTruncated = true;
  };
  const cutMetrics = (s: ServiceSummary, kept: SummaryMetric[]) => {
    s.metrics = kept;
    s.metricsTruncated = true;
  };
  capTotal(services, (s) => s.keys, cutKeys, keyOrder, SUMMARY_LIMITS.keysTotal);
  capTotal(services, (s) => s.metrics, cutMetrics, metricOrder, SUMMARY_LIMITS.metricsTotal);
  return {
    fromMs: agg.firstMs,
    toMs: agg.lastMs,
    windowMinutes: agg.windowMinutes,
    services,
    truncated: all.length > SUMMARY_LIMITS.services,
  };
}

const SIGNAL_OF: Record<SummaryScope, Signal> = { span: 'traces', 'span.event': 'traces', log: 'logs' };
const VERDICT_ORDER: Record<ChangeVerdict, number> = { new: 0, grown: 1, resolved: 2 };

function keyFlagged(k: SummaryKey, s: CardinalitySettings): boolean {
  const high = k.distinct >= s.minDistinct && k.occurrences > 0 && k.distinct / k.occurrences >= s.minDistinctRatio;
  const idLike = ((k.cls !== undefined && ID_CLASSES.has(k.cls)) || keyHint(k.key) !== undefined) && k.distinct >= ID_LIKE_MIN_DISTINCT;
  return high || idLike;
}

const metricFlagged = (m: SummaryMetric, s: CardinalitySettings) => m.series >= s.maxSeriesPerMetric;
const grew = (base: number, current: number, s: CardinalitySettings) => current >= GROWTH_FACTOR * base && current - base >= s.minDistinct;

/** Compares one item kind of one service; `missingOk` is false when absence may only mean truncation. */
function diff<T>(
  out: CardinalityChange[],
  base: readonly T[],
  current: readonly T[],
  id: (x: T) => string,
  flagged: (x: T) => boolean,
  size: (x: T) => number,
  make: (verdict: ChangeVerdict, b: T | undefined, c: T | undefined) => CardinalityChange,
  baseComplete: boolean,
  currentComplete: boolean,
  s: CardinalitySettings
): void {
  const before = new Map(base.map((x) => [id(x), x]));
  const after = new Map(current.map((x) => [id(x), x]));
  for (const [k, c] of after) {
    if (!flagged(c)) continue;
    const b = before.get(k);
    if (!b) {
      if (baseComplete) out.push(make('new', undefined, c));
    } else if (!flagged(b)) out.push(make('new', b, c));
    else if (grew(size(b), size(c), s)) out.push(make('grown', b, c));
  }
  for (const [k, b] of before) {
    if (!flagged(b)) continue;
    const c = after.get(k);
    if (c ? !flagged(c) : currentComplete) out.push(make('resolved', b, c));
  }
}

const keyId = (k: SummaryKey) => `${k.scope}\u0000${k.key}`;

function serviceChanges(out: CardinalityChange[], service: string, base: ServiceSummary | undefined, current: ServiceSummary, s: CardinalitySettings): void {
  diff<SummaryKey>(
    out,
    base?.keys ?? [],
    current.keys,
    keyId,
    (k) => keyFlagged(k, s),
    (k) => k.distinct,
    (verdict, b, c) => {
      const k = (c ?? b)!;
      const change: CardinalityChange = { verdict, kind: 'attribute', service, signal: SIGNAL_OF[k.scope], scope: k.scope, key: k.key };
      if (b) change.base = b.distinct;
      if (c) change.current = c.distinct;
      if (k.cls) change.cls = k.cls;
      return change;
    },
    !base?.keysTruncated,
    !current.keysTruncated,
    s
  );
  diff<SummaryMetric>(
    out,
    base?.metrics ?? [],
    current.metrics,
    (m) => m.name,
    (m) => metricFlagged(m, s),
    (m) => m.series,
    (verdict, b, c) => {
      const m = (c ?? b)!;
      const change: CardinalityChange = { verdict, kind: 'metric', service, signal: 'metrics', key: m.name };
      if (b) change.base = b.series;
      if (c) change.current = c.series;
      if (m.driver) change.driver = m.driver;
      return change;
    },
    !base?.metricsTruncated,
    !current.metricsTruncated,
    s
  );
}

function volumeChanges(out: VolumeChange[], base: ServiceSummary, current: ServiceSummary): void {
  for (const signal of SIGNALS) {
    const b = base.perMinute[signal];
    const c = current.perMinute[signal];
    if (!b.count && !c.count) continue;
    const change = b.count ? c.count / b.count - 1 : Infinity;
    if (Math.abs(change) < VOLUME_CHANGE) continue;
    out.push({ service: current.service, signal, base: b.count, current: c.count, change, baseBytes: b.proto, currentBytes: c.proto });
  }
}

/** New, grown and resolved high-cardinality attributes and metrics, and per-service volume changes. */
export function compareCardinality(base: CardinalitySummary, current: CardinalitySummary, settings: CardinalitySettings): CardinalityComparison {
  const before = new Map(base.services.map((s) => [s.service, s]));
  const after = new Map(current.services.map((s) => [s.service, s]));
  const changes: CardinalityChange[] = [];
  const volume: VolumeChange[] = [];
  const addedServices: string[] = [];
  for (const [name, c] of after) {
    const b = before.get(name);
    // A service missing from a truncated baseline may just have been cut, so it is not "new".
    if (!b && base.truncated) continue;
    if (!b) addedServices.push(name);
    serviceChanges(changes, name, b, c, settings);
    if (b) volumeChanges(volume, b, c);
  }
  const missingServices = current.truncated ? [] : [...before.keys()].filter((n) => !after.has(n));
  changes.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      (b.current ?? b.base ?? 0) - (a.current ?? a.base ?? 0) ||
      byCodeUnit(a.service, b.service) ||
      byCodeUnit(a.kind, b.kind) ||
      byCodeUnit(a.key, b.key)
  );
  volume.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || byCodeUnit(a.service, b.service) || byCodeUnit(a.signal, b.signal));
  const summary: Record<ChangeVerdict, number> = { new: 0, grown: 0, resolved: 0 };
  for (const c of changes) summary[c.verdict]++;
  return { changes, volume, summary, addedServices: addedServices.sort(byCodeUnit), missingServices: missingServices.sort(byCodeUnit) };
}
