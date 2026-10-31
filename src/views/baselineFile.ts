// SPDX-License-Identifier: Apache-2.0
// Baseline file format: serialize and strictly validate. Files may come from other machines, so nothing is trusted.

import { Signal, Volume } from '../store/cardinality/sizes';
import { VALUE_CLASSES, ValueClass } from '../store/cardinality/valueClass';
import { DEFAULT_SNAPSHOT_CAPS, Snapshot, SnapshotEntry, SnapshotNode, SnapshotSource, SnapshotSourceKind } from './baseline';
import { CardinalitySummary, SUMMARY_LIMITS, ServiceSummary, SummaryKey, SummaryMetric, SummaryScope } from './cardinalitySummary';
import { NodeType } from './serviceGraph';
import { MAX_OPERATION_KEY_LENGTH } from './serviceMapModel';

export const BASELINE_FORMAT = 'otel-baseline';
// 2 adds the optional snapshot.cardinality summary; 1 is still read.
export const BASELINE_VERSION = 2;
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);
export const BASELINE_EXTENSION = 'otel-baseline.json';
export const MAX_BASELINE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BASELINE_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 2000;
const MAX_LABEL_LENGTH = 200;
const MAX_NODES = DEFAULT_SNAPSHOT_CAPS.keys * 2;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SOURCE_KINDS: ReadonlySet<SnapshotSourceKind> = new Set(['window', 'mark', 'time', 'session', 'file']);
const NODE_TYPES: ReadonlySet<NodeType> = new Set(['service', 'database', 'queue', 'external']);
const SUMMARY_SCOPES: ReadonlySet<SummaryScope> = new Set(['span', 'span.event', 'log']);
const CLASSES: ReadonlySet<ValueClass> = new Set(VALUE_CLASSES);

export class BaselineFileError extends Error {}

export interface BaselineFile {
  name: string;
  createdMs: number;
  snapshot: Snapshot;
}

// Names are shown in menus and reports: no control or bidi-override characters, bounded length.
export function sanitizeBaselineName(raw: unknown, fallback = 'Baseline'): string {
  // eslint-disable-next-line no-control-regex
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() : '';
  return (s || fallback).slice(0, MAX_BASELINE_NAME_LENGTH);
}

export function serializeBaseline(b: BaselineFile): string {
  const { source, nodes, entries, truncated, cardinality } = b.snapshot;
  return JSON.stringify({
    format: BASELINE_FORMAT,
    version: BASELINE_VERSION,
    name: b.name,
    createdMs: b.createdMs,
    snapshot: cardinality ? { source, nodes, entries, truncated, cardinality } : { source, nodes, entries, truncated },
  });
}

const fail = (msg: string): never => {
  throw new BaselineFileError(msg);
};

function obj(v: unknown, what: string): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${what} must be an object.`);
}

function arr(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} must be a list.`);
  return (v as unknown[]).length <= max ? (v as unknown[]) : fail(`${what} has more than ${max} items.`);
}

function str(v: unknown, max: number, what: string): string {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(`${what} must be text of 1–${max} characters.`);
}

function num(v: unknown, what: string): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(`${what} must be a number ≥ 0.`);
}

function int(v: unknown, what: string): number {
  return Number.isInteger(v) ? num(v, what) : fail(`${what} must be a whole number ≥ 0.`);
}

const numOrNull = (v: unknown, what: string) => (v === null ? null : num(v, what));

// Attribute keys and metric names may legitimately be empty strings.
function name(v: unknown, max: number, what: string): string {
  return typeof v === 'string' && v.length <= max ? v : fail(`${what} must be text of at most ${max} characters.`);
}

function bool(v: unknown, what: string): boolean {
  return typeof v === 'boolean' ? v : fail(`${what} must be true or false.`);
}

function parseVolumes(v: unknown, what: string, whole: boolean): Record<Signal, Volume> {
  const o = obj(v, what);
  const read = whole ? int : num;
  const one = (s: Signal): Volume => {
    const x = obj(o[s], `${what}.${s}`);
    return { count: read(x.count, `${what}.${s}.count`), proto: read(x.proto, `${what}.${s}.proto`), json: read(x.json, `${what}.${s}.json`) };
  };
  return { traces: one('traces'), logs: one('logs'), metrics: one('metrics') };
}

function parseSummaryKey(v: unknown, at: string): SummaryKey {
  const k = obj(v, at);
  const scope = k.scope as SummaryScope;
  if (!SUMMARY_SCOPES.has(scope)) fail(`${at}.scope is not recognised.`);
  const key: SummaryKey = {
    scope,
    key: name(k.key, SUMMARY_LIMITS.keyName, `${at}.key`),
    distinct: int(k.distinct, `${at}.distinct`),
    approx: bool(k.approx, `${at}.approx`),
    occurrences: int(k.occurrences, `${at}.occurrences`),
    proto: int(k.proto, `${at}.proto`),
  };
  if (k.cls !== undefined) {
    if (!CLASSES.has(k.cls as ValueClass)) fail(`${at}.cls is not recognised.`);
    key.cls = k.cls as ValueClass;
  }
  return key;
}

function parseSummaryMetric(v: unknown, at: string): SummaryMetric {
  const m = obj(v, at);
  const metric: SummaryMetric = {
    name: name(m.name, SUMMARY_LIMITS.keyName, `${at}.name`),
    series: int(m.series, `${at}.series`),
    approx: bool(m.approx, `${at}.approx`),
    points: int(m.points, `${at}.points`),
  };
  if (m.driver !== undefined) metric.driver = name(m.driver, SUMMARY_LIMITS.keyName, `${at}.driver`);
  return metric;
}

function unique<T>(items: readonly T[], id: (x: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const x of items) {
    const k = id(x);
    if (seen.has(k)) fail(`${what} lists ${JSON.stringify(k.slice(0, 80))} twice.`);
    seen.add(k);
  }
}

function parseServiceSummary(v: unknown, i: number): ServiceSummary {
  const at = `cardinality.services[${i}]`;
  const s = obj(v, at);
  const keys = arr(s.keys, SUMMARY_LIMITS.keysPerService, `${at}.keys`).map((k, j) => parseSummaryKey(k, `${at}.keys[${j}]`));
  unique(keys, (k) => `${k.scope} ${k.key}`, `${at}.keys`);
  const metrics = arr(s.metrics, SUMMARY_LIMITS.metricsPerService, `${at}.metrics`).map((m, j) => parseSummaryMetric(m, `${at}.metrics[${j}]`));
  unique(metrics, (m) => m.name, `${at}.metrics`);
  return {
    service: name(s.service, SUMMARY_LIMITS.serviceName, `${at}.service`),
    totals: parseVolumes(s.totals, `${at}.totals`, true),
    perMinute: parseVolumes(s.perMinute, `${at}.perMinute`, false),
    observedMs: num(s.observedMs, `${at}.observedMs`),
    spanNames: int(s.spanNames, `${at}.spanNames`),
    templates: int(s.templates, `${at}.templates`),
    keys,
    keysTruncated: bool(s.keysTruncated, `${at}.keysTruncated`),
    metrics,
    metricsTruncated: bool(s.metricsTruncated, `${at}.metricsTruncated`),
  };
}

function parseCardinality(v: unknown): CardinalitySummary {
  const c = obj(v, 'cardinality');
  const services = arr(c.services, SUMMARY_LIMITS.services, 'cardinality.services').map((s, i) => parseServiceSummary(s, i));
  unique(services, (s) => s.service, 'cardinality.services');
  let keys = 0;
  let metrics = 0;
  for (const s of services) {
    keys += s.keys.length;
    metrics += s.metrics.length;
  }
  if (keys > SUMMARY_LIMITS.keysTotal) fail(`cardinality has more than ${SUMMARY_LIMITS.keysTotal} keys.`);
  if (metrics > SUMMARY_LIMITS.metricsTotal) fail(`cardinality has more than ${SUMMARY_LIMITS.metricsTotal} metrics.`);
  const fromMs = num(c.fromMs, 'cardinality.fromMs');
  const toMs = num(c.toMs, 'cardinality.toMs');
  if (toMs < fromMs) fail('cardinality.toMs is before cardinality.fromMs.');
  return { fromMs, toMs, windowMinutes: num(c.windowMinutes, 'cardinality.windowMinutes'), services, truncated: bool(c.truncated, 'cardinality.truncated') };
}

function parseSource(v: unknown): SnapshotSource {
  const s = obj(v, 'snapshot.source');
  const kind = s.kind as SnapshotSourceKind;
  if (!SOURCE_KINDS.has(kind)) fail('snapshot.source.kind is not recognised.');
  return {
    kind,
    label: str(s.label, MAX_LABEL_LENGTH, 'snapshot.source.label'),
    realm: str(s.realm, MAX_LABEL_LENGTH, 'snapshot.source.realm'),
    fromMs: num(s.fromMs, 'snapshot.source.fromMs'),
    toMs: num(s.toMs, 'snapshot.source.toMs'),
  };
}

function parseNode(v: unknown, i: number): SnapshotNode {
  const n = obj(v, `nodes[${i}]`);
  const type = n.type as NodeType;
  if (!NODE_TYPES.has(type)) fail(`nodes[${i}].type is not recognised.`);
  return { id: str(n.id, MAX_ID_LENGTH, `nodes[${i}].id`), label: str(n.label, MAX_ID_LENGTH, `nodes[${i}].label`), type };
}

function parseEntry(v: unknown, i: number, nodeIds: ReadonlySet<string>): SnapshotEntry {
  const e = obj(v, `entries[${i}]`);
  const at = `entries[${i}]`;
  const target = str(e.target, MAX_ID_LENGTH, `${at}.target`);
  if (!nodeIds.has(target)) fail(`${at}.target is not a listed node.`);
  const count = int(e.count, `${at}.count`);
  const errors = int(e.errors, `${at}.errors`);
  if (errors > count) fail(`${at}.errors exceeds its count.`);
  const samples = arr(e.samples, DEFAULT_SNAPSHOT_CAPS.samplesPerKey, `${at}.samples`).map((s) => num(s, `${at}.samples`));
  for (let k = 1; k < samples.length; k++) if (samples[k] < samples[k - 1]) fail(`${at}.samples must be sorted.`);
  const exemplars = arr(e.exemplars, 2, `${at}.exemplars`).map((t) =>
    typeof t === 'string' && TRACE_ID.test(t) ? t : fail(`${at}.exemplars must be 32-character lowercase hex trace ids.`)
  );
  const entry: SnapshotEntry = {
    target,
    count,
    errors,
    p50: numOrNull(e.p50, `${at}.p50`),
    p95: numOrNull(e.p95, `${at}.p95`),
    samples,
    exemplars,
  };
  if (e.source !== undefined) {
    entry.source = str(e.source, MAX_ID_LENGTH, `${at}.source`);
    if (!nodeIds.has(entry.source)) fail(`${at}.source is not a listed node.`);
  }
  if (e.op !== undefined) entry.op = str(e.op, MAX_OPERATION_KEY_LENGTH, `${at}.op`);
  if (e.opsTruncated !== undefined) {
    if (typeof e.opsTruncated !== 'boolean') fail(`${at}.opsTruncated must be true or false.`);
    if (e.opsTruncated) entry.opsTruncated = true;
  }
  return entry;
}

// Builds fresh objects from known fields only; unknown fields (including __proto__) are dropped.
export function parseBaselineFile(text: string): BaselineFile {
  if (text.length > MAX_BASELINE_FILE_BYTES) fail('File is larger than 8 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('File is not valid JSON.');
  }
  const root = obj(raw, 'File');
  if (root.format !== BASELINE_FORMAT) fail('Not an OpenTelemetry baseline file.');
  if (!READABLE_VERSIONS.has(root.version)) {
    fail(typeof root.version === 'number' && root.version > BASELINE_VERSION ? 'File was made by a newer version of the extension.' : 'Unsupported baseline file version.');
  }
  const snap = obj(root.snapshot, 'snapshot');
  const nodes = arr(snap.nodes, MAX_NODES, 'nodes').map((n, i) => parseNode(n, i));
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (nodeIds.has(n.id)) fail(`Node ${JSON.stringify(n.id.slice(0, 80))} is listed twice.`);
    nodeIds.add(n.id);
  }
  const entries = arr(snap.entries, DEFAULT_SNAPSHOT_CAPS.keys, 'entries').map((e, i) => parseEntry(e, i, nodeIds));
  const keys = new Set<string>();
  let samples = 0;
  for (const e of entries) {
    const key = JSON.stringify([e.source ?? null, e.target, e.op ?? null]);
    if (keys.has(key)) fail('An entry is listed twice.');
    keys.add(key);
    samples += e.samples.length;
  }
  if (samples > DEFAULT_SNAPSHOT_CAPS.totalSamples) fail(`File has more than ${DEFAULT_SNAPSHOT_CAPS.totalSamples} samples.`);
  if (typeof snap.truncated !== 'boolean') fail('snapshot.truncated must be true or false.');
  const snapshot: Snapshot = { source: parseSource(snap.source), nodes, entries, truncated: snap.truncated as boolean };
  // Version 1 files predate the summary, so the field is ignored there like any unknown field.
  if (root.version !== 1 && snap.cardinality !== undefined) snapshot.cardinality = parseCardinality(snap.cardinality);
  return {
    name: sanitizeBaselineName(root.name),
    createdMs: num(root.createdMs, 'createdMs'),
    snapshot,
  };
}
