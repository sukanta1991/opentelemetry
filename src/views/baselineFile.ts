// SPDX-License-Identifier: Apache-2.0
// Baseline file format: serialize and strictly validate. Files may come from other machines, so nothing is trusted.

import { DEFAULT_SNAPSHOT_CAPS, Snapshot, SnapshotEntry, SnapshotNode, SnapshotSource, SnapshotSourceKind } from './baseline';
import { NodeType } from './serviceGraph';
import { MAX_OPERATION_KEY_LENGTH } from './serviceMapModel';

export const BASELINE_FORMAT = 'otel-baseline';
export const BASELINE_VERSION = 1;
export const BASELINE_EXTENSION = 'otel-baseline.json';
export const MAX_BASELINE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BASELINE_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 2000;
const MAX_LABEL_LENGTH = 200;
const MAX_NODES = DEFAULT_SNAPSHOT_CAPS.keys * 2;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SOURCE_KINDS: ReadonlySet<SnapshotSourceKind> = new Set(['window', 'mark', 'time', 'session', 'file']);
const NODE_TYPES: ReadonlySet<NodeType> = new Set(['service', 'database', 'queue', 'external']);

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
  const { source, nodes, entries, truncated } = b.snapshot;
  return JSON.stringify({
    format: BASELINE_FORMAT,
    version: BASELINE_VERSION,
    name: b.name,
    createdMs: b.createdMs,
    snapshot: { source, nodes, entries, truncated },
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
  if (root.version !== BASELINE_VERSION) {
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
  return {
    name: sanitizeBaselineName(root.name),
    createdMs: num(root.createdMs, 'createdMs'),
    snapshot: { source: parseSource(snap.source), nodes, entries, truncated: snap.truncated as boolean },
  };
}
