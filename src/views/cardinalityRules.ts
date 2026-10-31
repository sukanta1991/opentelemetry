// SPDX-License-Identifier: Apache-2.0
// Cardinality rules (R1–R6) over per-service facts aggregated from the usage trackers. No vscode import.

import { byCodeUnit } from '../compare';
import { classHint, keyHint } from '../store/cardinality/keyHints';
import { Signal } from '../store/cardinality/sizes';
import { DOMINANT_SHARE, ID_CLASSES, ValueClass } from '../store/cardinality/valueClass';
import { MetricType } from '../store/model';

export interface CardinalitySettings {
  minDistinct: number;
  minDistinctRatio: number;
  maxSeriesPerMetric: number;
  maxSpanNamesPerService: number;
}

export const DEFAULT_CARDINALITY_SETTINGS: Readonly<CardinalitySettings> = Object.freeze({
  minDistinct: 100,
  minDistinctRatio: 0.1,
  maxSeriesPerMetric: 500,
  maxSpanNamesPerService: 100,
});

const SETTING_RANGES: Record<keyof CardinalitySettings, [number, number, boolean]> = {
  minDistinct: [10, 100_000, true],
  minDistinctRatio: [0, 1, false],
  maxSeriesPerMetric: [10, 1_000_000, true],
  maxSpanNamesPerService: [5, 100_000, true],
};

/** Settings are user input: non-numbers fall back to defaults, numbers are clamped (and rounded where integral). */
export function sanitizeCardinalitySettings(raw: unknown): CardinalitySettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_CARDINALITY_SETTINGS };
  for (const key of Object.keys(SETTING_RANGES) as (keyof CardinalitySettings)[]) {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [min, max, integral] = SETTING_RANGES[key];
    const clamped = Math.min(max, Math.max(min, v));
    out[key] = integral ? Math.round(clamped) : clamped;
  }
  return out;
}

/** Unique values above which an id-like key or metric label is reported regardless of the thresholds. */
export const ID_LIKE_MIN_DISTINCT = 20;
/** Multiple of a threshold that makes a finding critical. */
export const CRITICAL_FACTOR = 10;
/** Share of a signal's bytes a span or log attribute needs before it can be critical. */
export const CRITICAL_BYTES_SHARE = 0.2;
/** Share of span names embedding ids that flags a service. */
export const ID_NAME_SHARE = 0.2;
const ID_NAME_MIN_CLASSIFIED = 5;
/** Share of a service's logs one template needs to be reported as noisy. */
export const NOISY_TEMPLATE_SHARE = 0.5;
export const NOISY_TEMPLATE_MIN_LOGS = 100;

export type KeyScope = 'span' | 'span.event' | 'log' | 'metric';
export type Severity = 'critical' | 'warning' | 'info';
export type Growth = 'growing' | 'saturated' | 'insufficient';
export type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R6';
export type FindingKind = 'attribute' | 'metricSeries' | 'metricLabel' | 'spanNames' | 'logTemplate';

export interface KeyFacts {
  scope: KeyScope;
  key: string;
  distinct: number;
  approx: boolean;
  occurrences: number;
  proto: number;
  json: number;
  /** Class covering at least DOMINANT_SHARE of the first unique values. */
  valueClass?: ValueClass;
  /** Class counts of the first unique values, most frequent first; built on demand. */
  classes: () => readonly [ValueClass, number][];
  samples: readonly string[];
  /** Unique-value estimate at the end of each bucket, oldest first (NaN = open or no data); built on demand. */
  history: () => ArrayLike<number>;
  /** growthOf(history), possibly computed without building the history. */
  growth: () => Growth;
}

export interface MetricFacts {
  name: string;
  type: MetricType;
  series: number;
  approx: boolean;
  points: number;
  proto: number;
  json: number;
  history: () => ArrayLike<number>;
  growth: () => Growth;
  labels: readonly KeyFacts[];
}

export interface ServiceFacts {
  service: string;
  /** Protobuf bytes per signal, for byte shares. */
  bytes: Record<Signal, number>;
  logs: number;
  keys: readonly KeyFacts[];
  metrics: readonly MetricFacts[];
  spanNames: { distinct: number; approx: boolean; classified: number; withIds: number; samples: readonly string[] };
  templates: readonly { text: string; count: number; proto: number; sample: string }[];
}

export interface Finding {
  /** Stable across refreshes while the finding exists. */
  id: string;
  rule: Rule;
  kind: FindingKind;
  severity: Severity;
  service: string;
  signal: Signal;
  scope?: KeyScope;
  /** Attribute key, metric name, "span names" or template text. */
  key: string;
  metric?: string;
  distinct: number;
  approx: boolean;
  occurrences: number;
  proto: number;
  json: number;
  /** Share of the service's bytes for this signal. */
  bytesShare: number;
  valueClass?: ValueClass;
  growth: Growth;
  driver?: { label: string; distinct: number };
  samples: readonly string[];
  hint?: string;
  prefer?: readonly string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const RAISED: Record<Severity, Severity> = { info: 'warning', warning: 'critical', critical: 'critical' };

/** The class covering at least DOMINANT_SHARE of the classified values. */
export function dominantClass(classes: readonly [ValueClass, number][]): ValueClass | undefined {
  let total = 0;
  let best: [ValueClass, number] | undefined;
  for (const entry of classes) {
    total += entry[1];
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best && total && best[1] / total >= DOMINANT_SHARE ? best[0] : undefined;
}

/**
 * Whether new unique values are still arriving: with at least 3 closed buckets, compares the average
 * new-value rate of the last third of buckets with the first third.
 */
export function growthOf(history: ArrayLike<number>): Growth {
  let n = 0;
  for (let i = 0; i < history.length; i++) if (Number.isFinite(history[i])) n++;
  if (n < 4) return 'insufficient';
  const diffs = n - 1;
  const third = Math.max(1, Math.floor(diffs / 3));
  let prev = NaN;
  let d = 0;
  let first = 0;
  let last = 0;
  for (let i = 0; i < history.length; i++) {
    const v = history[i];
    if (!Number.isFinite(v)) continue;
    if (!Number.isNaN(prev)) {
      const diff = Math.max(0, v - prev);
      if (d < third) first += diff;
      if (d >= diffs - third) last += diff;
      d++;
    }
    prev = v;
  }
  return last > 0 && last >= 0.5 * first ? 'growing' : 'saturated';
}

function isIdLike(key: string, cls: ValueClass | undefined): boolean {
  return (cls !== undefined && ID_CLASSES.has(cls)) || keyHint(key) !== undefined;
}

const SIGNAL_OF: Record<KeyScope, Signal> = { span: 'traces', 'span.event': 'traces', log: 'logs', metric: 'metrics' };

/** Remediation text for a key: its own hint if known, else the hint for its dominant class. */
export function hintFor(key: string, cls: ValueClass | undefined): { hint?: string; prefer?: readonly string[] } {
  const k = keyHint(key);
  if (k) return { hint: k.hint, prefer: k.prefer };
  const h = cls ? classHint(cls) : undefined;
  return h ? { hint: h } : {};
}

function finish(f: Omit<Finding, 'id'>): Finding {
  if (f.growth === 'growing') f.severity = RAISED[f.severity];
  return Object.assign(f, { id: `${f.service}\u0000${f.rule}\u0000${f.scope ?? ''}\u0000${f.metric ?? ''}\u0000${f.key}` });
}

function attributeFinding(svc: ServiceFacts, k: KeyFacts, s: CardinalitySettings): Finding | undefined {
  const cls = k.valueClass;
  const ratio = k.occurrences ? k.distinct / k.occurrences : 0;
  const high = k.distinct >= s.minDistinct && ratio >= s.minDistinctRatio;
  const idLike = isIdLike(k.key, cls) && k.distinct >= ID_LIKE_MIN_DISTINCT;
  if (!high && !idLike) return undefined;
  const signal = SIGNAL_OF[k.scope];
  const share = svc.bytes[signal] ? k.proto / svc.bytes[signal] : 0;
  const severity: Severity = high && k.distinct >= CRITICAL_FACTOR * s.minDistinct && share >= CRITICAL_BYTES_SHARE ? 'critical' : 'warning';
  return finish({
    rule: high ? 'R1' : 'R2',
    kind: 'attribute',
    severity,
    service: svc.service,
    signal,
    scope: k.scope,
    key: k.key,
    distinct: k.distinct,
    approx: k.approx,
    occurrences: k.occurrences,
    proto: k.proto,
    json: k.json,
    bytesShare: share,
    valueClass: cls,
    growth: k.growth(),
    samples: k.samples,
    ...hintFor(k.key, cls),
  });
}

function metricFindings(svc: ServiceFacts, m: MetricFacts, s: CardinalitySettings): Finding[] {
  const out: Finding[] = [];
  const share = svc.bytes.metrics ? m.proto / svc.bytes.metrics : 0;
  let driver: KeyFacts | undefined;
  for (const l of m.labels) if (!driver || l.distinct > driver.distinct) driver = l;
  if (m.series >= s.maxSeriesPerMetric) {
    const cls = driver?.valueClass;
    out.push(
      finish({
        rule: 'R3',
        kind: 'metricSeries',
        severity: m.series >= CRITICAL_FACTOR * s.maxSeriesPerMetric ? 'critical' : 'warning',
        service: svc.service,
        signal: 'metrics',
        key: m.name,
        distinct: m.series,
        approx: m.approx,
        occurrences: m.points,
        proto: m.proto,
        json: m.json,
        bytesShare: share,
        growth: m.growth(),
        driver: driver ? { label: driver.key, distinct: driver.distinct } : undefined,
        samples: driver?.samples ?? [],
        ...(driver ? hintFor(driver.key, cls) : {}),
      })
    );
  }
  for (const l of m.labels) {
    const cls = l.valueClass;
    if (!isIdLike(l.key, cls) || l.distinct < ID_LIKE_MIN_DISTINCT) continue;
    out.push(
      finish({
        rule: 'R2',
        kind: 'metricLabel',
        severity: 'critical',
        service: svc.service,
        signal: 'metrics',
        scope: 'metric',
        key: l.key,
        metric: m.name,
        distinct: l.distinct,
        approx: l.approx,
        occurrences: l.occurrences,
        proto: l.proto,
        json: l.json,
        bytesShare: share,
        valueClass: cls,
        growth: l.growth(),
        samples: l.samples,
        ...hintFor(l.key, cls),
      })
    );
  }
  return out;
}

function spanNameFinding(svc: ServiceFacts, s: CardinalitySettings): Finding | undefined {
  const n = svc.spanNames;
  const many = n.distinct >= s.maxSpanNamesPerService;
  const withIds = n.classified >= ID_NAME_MIN_CLASSIFIED && n.withIds / n.classified >= ID_NAME_SHARE;
  if (!many && !withIds) return undefined;
  return finish({
    rule: 'R4',
    kind: 'spanNames',
    severity: n.distinct >= CRITICAL_FACTOR * s.maxSpanNamesPerService ? 'critical' : 'warning',
    service: svc.service,
    signal: 'traces',
    key: 'span names',
    distinct: n.distinct,
    approx: n.approx,
    occurrences: n.withIds,
    proto: 0,
    json: 0,
    bytesShare: 0,
    valueClass: withIds ? 'pathId' : undefined,
    growth: 'insufficient',
    samples: n.samples,
    hint: 'Span names should be low-cardinality: name spans after the route template or operation (for example "GET /users/{id}") and put ids in attributes.',
    prefer: ['http.route'],
  });
}

function templateFindings(svc: ServiceFacts): Finding[] {
  if (svc.logs < NOISY_TEMPLATE_MIN_LOGS) return [];
  const out: Finding[] = [];
  for (const t of svc.templates) {
    if (t.count / svc.logs < NOISY_TEMPLATE_SHARE) continue;
    out.push(
      finish({
        rule: 'R6',
        kind: 'logTemplate',
        severity: 'info',
        service: svc.service,
        signal: 'logs',
        key: t.text,
        distinct: 1,
        approx: false,
        occurrences: t.count,
        proto: t.proto,
        json: 0,
        bytesShare: svc.bytes.logs ? t.proto / svc.bytes.logs : 0,
        growth: 'insufficient',
        samples: t.sample ? [t.sample] : [],
        hint: 'One log pattern makes up most of this service\u2019s logs. Lower its level, sample it, or turn it into a metric.',
      })
    );
  }
  return out;
}

/** All findings; sorted (most severe first, then by bytes, unique values, service and key) unless `sorted` is false. */
export function evaluateFindings(services: readonly ServiceFacts[], settings: CardinalitySettings, sorted = true): Finding[] {
  const out: Finding[] = [];
  for (const svc of services) {
    for (const k of svc.keys) {
      const f = attributeFinding(svc, k, settings);
      if (f) out.push(f);
    }
    for (const m of svc.metrics) out.push(...metricFindings(svc, m, settings));
    const names = spanNameFinding(svc, settings);
    if (names) out.push(names);
    out.push(...templateFindings(svc));
  }
  return sorted ? out.sort(compareFindings) : out;
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    b.proto - a.proto ||
    b.distinct - a.distinct ||
    byCodeUnit(a.service, b.service) ||
    byCodeUnit(a.id, b.id)
  );
}
