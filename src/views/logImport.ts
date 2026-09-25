// Pure parsers for imported log files. Input is untrusted, so every field is validated and
// the first violation aborts the import rather than yielding a silently partial result.

import { normalizeSpanId, normalizeTraceId } from '../store/ids';
import { AttributeValue, KeyValueMap, LogRecord } from '../store/model';

export type ImportFormat = 'otlp' | 'plain' | 'jsonl' | 'unknown';

export interface ImportedLogs {
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttrs: KeyValueMap;
  logs: LogRecord[];
  /** Lines rejected during a JSON Lines import; other formats abort instead of skipping. */
  skipped?: number;
  /** Reason the first rejected line failed, for the user-facing summary. */
  skippedSample?: string;
}

export class LogImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogImportError';
  }
}

// Keys that would let a crafted file reach Object.prototype once the parsed value is spread.
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const MAX_ATTRS_PER_RECORD = 256;
const MAX_SEVERITY_NUMBER = 24;

// Bound the work a single crafted JSONL line can force during flattening.
const MAX_FLATTEN_DEPTH = 8;
const MAX_FLATTEN_KEYS = 512;
// Cap the detection scan so a large non-JSONL file is rejected quickly.
const JSONL_DETECT_LINES = 20;

// --- Validation primitives ---------------------------------------------------------------

function fail(path: string, expected: string): never {
  throw new LogImportError(`${path}: expected ${expected}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectObject(v: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(v)) fail(path, 'an object');
  assertSafeKeys(v, path);
  return v;
}

function expectArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'an array');
  return v;
}

function optionalString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(path, 'a string');
  return v;
}

// Unrecognized vendor id formats are kept verbatim so they stay visible and searchable.
function importedId(
  v: string | undefined,
  normalize: (v: unknown) => string | undefined
): string | undefined {
  const t = v?.trim();
  if (!t || /^(0x)?[0-]+$/i.test(t)) return undefined;
  return normalize(t) ?? t;
}

const traceIdOf = (v: string | undefined) => importedId(v, normalizeTraceId);
const spanIdOf = (v: string | undefined) => importedId(v, normalizeSpanId);

function assertSafeKeys(o: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(o)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new LogImportError(`${path}: key "${key}" is not allowed`);
    }
  }
}

function clampSeverity(v: unknown, path: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'a number');
  return Math.min(MAX_SEVERITY_NUMBER, Math.max(0, Math.round(v)));
}

// Nanosecond values exceed Number.MAX_SAFE_INTEGER, so strings are divided as BigInt.
function nanoToMs(v: unknown, path: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v / 1e6);
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    return Number(BigInt(v) / BigInt(1_000_000));
  }
  fail(path, 'a nanosecond timestamp');
}

function epochMs(v: unknown, path: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isNaN(parsed)) fail(path, 'an ISO-8601 timestamp');
    return parsed;
  }
  fail(path, 'a timestamp');
}

function readAttrs(v: unknown, path: string): KeyValueMap {
  if (v === undefined || v === null) return {};
  const raw = expectObject(v, path);
  const keys = Object.keys(raw);
  if (keys.length > MAX_ATTRS_PER_RECORD) {
    throw new LogImportError(
      `${path}: ${keys.length} attributes exceeds the ${MAX_ATTRS_PER_RECORD} per-record limit`
    );
  }
  const out: KeyValueMap = {};
  for (const k of keys) out[k] = readAttributeValue(raw[k], `${path}.${k}`);
  return out;
}

function readAttributeValue(v: unknown, path: string): AttributeValue {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v as AttributeValue;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) fail(path, 'a finite number');
    return v as number;
  }
  if (Array.isArray(v)) return v.map((item, i) => readAttributeValue(item, `${path}[${i}]`));
  if (isPlainObject(v)) {
    assertSafeKeys(v, path);
    const out: KeyValueMap = {};
    for (const k of Object.keys(v)) out[k] = readAttributeValue(v[k], `${path}.${k}`);
    return out;
  }
  fail(path, 'a JSON value');
}

// --- Format detection ----------------------------------------------------------------------

// Takes the already-parsed document; the file is only deserialised once.
export function detectFormat(value: unknown): ImportFormat {
  if (!isPlainObject(value)) return 'unknown';
  if (Array.isArray(value.resourceLogs)) return 'otlp';
  if (Array.isArray(value.logs)) return 'plain';
  return 'unknown';
}

export function parseJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new LogImportError(`Not valid JSON: ${(e as Error).message}`);
  }
}

// --- OTLP/JSON -------------------------------------------------------------------------------

function fromAnyValue(v: unknown, path: string): AttributeValue {
  if (v === undefined || v === null) return null;
  const o = expectObject(v, path);
  if ('stringValue' in o) return optionalString(o.stringValue, `${path}.stringValue`) ?? '';
  if ('boolValue' in o) return o.boolValue === true;
  if ('intValue' in o) {
    const raw = o.intValue;
    if (typeof raw === 'number') return raw;
    const s = optionalString(raw, `${path}.intValue`) ?? '0';
    if (!/^-?\d+$/.test(s)) fail(`${path}.intValue`, 'an integer string');
    return Number(s);
  }
  if ('doubleValue' in o) {
    if (typeof o.doubleValue !== 'number') fail(`${path}.doubleValue`, 'a number');
    return o.doubleValue;
  }
  if ('bytesValue' in o) return optionalString(o.bytesValue, `${path}.bytesValue`) ?? '';
  if ('arrayValue' in o) {
    const arr = expectObject(o.arrayValue, `${path}.arrayValue`);
    const values = arr.values === undefined ? [] : expectArray(arr.values, `${path}.arrayValue.values`);
    return values.map((item, i) => fromAnyValue(item, `${path}.arrayValue.values[${i}]`));
  }
  if ('kvlistValue' in o) {
    const kv = expectObject(o.kvlistValue, `${path}.kvlistValue`);
    const values = kv.values === undefined ? [] : expectArray(kv.values, `${path}.kvlistValue.values`);
    return fromKeyValues(values, `${path}.kvlistValue.values`);
  }
  return null;
}

function fromKeyValues(entries: unknown[], path: string): KeyValueMap {
  if (entries.length > MAX_ATTRS_PER_RECORD) {
    throw new LogImportError(
      `${path}: ${entries.length} attributes exceeds the ${MAX_ATTRS_PER_RECORD} per-record limit`
    );
  }
  const out: KeyValueMap = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = expectObject(entries[i], `${path}[${i}]`);
    const key = optionalString(entry.key, `${path}[${i}].key`);
    if (!key) fail(`${path}[${i}].key`, 'a non-empty string');
    if (FORBIDDEN_KEYS.has(key)) {
      throw new LogImportError(`${path}[${i}].key: key "${key}" is not allowed`);
    }
    out[key] = fromAnyValue(entry.value, `${path}[${i}].value`);
  }
  return out;
}

export function parseOtlpJson(value: unknown): ImportedLogs {
  const root = expectObject(value, 'root');
  const resourceLogs = expectArray(root.resourceLogs, 'resourceLogs');
  if (!resourceLogs.length) throw new LogImportError('resourceLogs: file contains no resources');

  let serviceName = '';
  let serviceInstanceId: string | undefined;
  let resourceAttrs: KeyValueMap = {};
  const logs: LogRecord[] = [];

  for (let r = 0; r < resourceLogs.length; r++) {
    const rlPath = `resourceLogs[${r}]`;
    const rl = expectObject(resourceLogs[r], rlPath);
    const resource = rl.resource === undefined ? {} : expectObject(rl.resource, `${rlPath}.resource`);
    const attrs = fromKeyValues(
      resource.attributes === undefined ? [] : expectArray(resource.attributes, `${rlPath}.resource.attributes`),
      `${rlPath}.resource.attributes`
    );

    // Everything merges into one imported instance, identified by the first resource seen.
    if (!serviceName) {
      serviceName = typeof attrs['service.name'] === 'string' ? (attrs['service.name'] as string) : '';
      const sid = attrs['service.instance.id'];
      serviceInstanceId = typeof sid === 'string' ? sid : undefined;
      resourceAttrs = attrs;
    }

    const scopeLogs = rl.scopeLogs === undefined ? [] : expectArray(rl.scopeLogs, `${rlPath}.scopeLogs`);
    for (let s = 0; s < scopeLogs.length; s++) {
      const slPath = `${rlPath}.scopeLogs[${s}]`;
      const sl = expectObject(scopeLogs[s], slPath);
      const scopeObj = sl.scope === undefined ? {} : expectObject(sl.scope, `${slPath}.scope`);
      const scope = optionalString(scopeObj.name, `${slPath}.scope.name`);

      const records = sl.logRecords === undefined ? [] : expectArray(sl.logRecords, `${slPath}.logRecords`);
      for (let i = 0; i < records.length; i++) {
        const path = `${slPath}.logRecords[${i}]`;
        const rec = expectObject(records[i], path);
        const timeMs = nanoToMs(rec.timeUnixNano, `${path}.timeUnixNano`);
        const observedTimeMs = nanoToMs(rec.observedTimeUnixNano, `${path}.observedTimeUnixNano`);
        const severityNumber = clampSeverity(rec.severityNumber, `${path}.severityNumber`);
        logs.push({
          timeMs: timeMs ?? observedTimeMs ?? 0,
          observedTimeMs,
          severityNumber,
          severityText: optionalString(rec.severityText, `${path}.severityText`) ?? '',
          body: fromAnyValue(rec.body, `${path}.body`),
          attrs: fromKeyValues(
            rec.attributes === undefined ? [] : expectArray(rec.attributes, `${path}.attributes`),
            `${path}.attributes`
          ),
          traceId: traceIdOf(optionalString(rec.traceId, `${path}.traceId`)),
          spanId: spanIdOf(optionalString(rec.spanId, `${path}.spanId`)),
          scope,
        });
      }
    }
  }

  return { serviceName: serviceName || 'imported', serviceInstanceId, resourceAttrs, logs };
}

// --- Plain JSON ------------------------------------------------------------------------------

export function parsePlainJson(value: unknown): ImportedLogs {
  const root = expectObject(value, 'root');
  if (root.columns !== undefined) {
    throw new LogImportError(
      'This file was exported with "Grid columns", which keeps only the displayed text. ' +
        'Re-export with "All attributes" to import it.'
    );
  }

  const instance = root.instance === undefined ? {} : expectObject(root.instance, 'instance');
  const entries = expectArray(root.logs, 'logs');
  const logs: LogRecord[] = [];

  for (let i = 0; i < entries.length; i++) {
    const path = `logs[${i}]`;
    const rec = expectObject(entries[i], path);
    const timeMs = epochMs(rec.timeMs ?? rec.time, `${path}.timeMs`);
    const observedTimeMs = epochMs(rec.observedTimeMs ?? rec.observedTime, `${path}.observedTimeMs`);
    logs.push({
      timeMs: timeMs ?? observedTimeMs ?? 0,
      observedTimeMs,
      severityNumber: clampSeverity(rec.severityNumber, `${path}.severityNumber`),
      severityText: optionalString(rec.severityText, `${path}.severityText`) ?? '',
      body: readAttributeValue(rec.body, `${path}.body`),
      attrs: readAttrs(rec.attributes, `${path}.attributes`),
      traceId: traceIdOf(optionalString(rec.traceId, `${path}.traceId`)),
      spanId: spanIdOf(optionalString(rec.spanId, `${path}.spanId`)),
      scope: optionalString(rec.scope, `${path}.scope`),
      codeLocation: readCodeLocation(rec.codeLocation, `${path}.codeLocation`),
    });
  }

  return {
    serviceName: optionalString(instance.serviceName, 'instance.serviceName') || 'imported',
    serviceInstanceId: optionalString(instance.serviceInstanceId, 'instance.serviceInstanceId'),
    resourceAttrs: readAttrs(instance.resourceAttrs, 'instance.resourceAttrs'),
    logs,
  };
}

function readCodeLocation(v: unknown, path: string): LogRecord['codeLocation'] {
  if (v === undefined || v === null) return undefined;
  const o = expectObject(v, path);
  const filepath = optionalString(o.filepath, `${path}.filepath`);
  if (!filepath) return undefined;
  const num = (x: unknown, p: string): number | undefined => {
    if (x === undefined || x === null) return undefined;
    if (typeof x !== 'number' || !Number.isFinite(x)) fail(p, 'a number');
    return x;
  };
  return {
    filepath,
    line: num(o.line, `${path}.line`),
    column: num(o.column, `${path}.column`),
    function: optionalString(o.function, `${path}.function`),
  };
}

// --- JSON Lines ------------------------------------------------------------------------------
//
// One JSON object per line, from an arbitrary vendor. There is no schema to rely on, so each
// object is flattened to dotted paths and the well-known fields are located by leaf name. Keys
// are matched exactly against the candidate lists below, never by substring, so a near-miss like
// "timestampMicros" cannot be mistaken for "timestamp".

interface FlatField {
  path: string;
  leaf: string;
  value: AttributeValue;
}

// Lower-cases and folds _ and - to . so trace_id, traceId and trace-id all reach a candidate.
function normaliseLeaf(key: string): string {
  return key
    .toLowerCase()
    .replace(/[_-]+/g, '.')
    .replace(/^[@$.]+/, '');
}

const TIME_KEYS = [
  'timestamp', 'time', 'timeunixnano', 'time.unix.nano', 'timems', 'time.ms',
  'timestampnanos', 'timestamp.nanos', 'timestampmicros', 'timestamp.micros',
  'eventtime', 'event.time', 'datetime', 'date', 'ts',
];
const OBSERVED_TIME_KEYS = [
  'observedtimeunixnano', 'observed.time.unix.nano', 'observedtime', 'observed.time',
  'ingresstimestamp', 'ingress.timestamp', 'ingestedat', 'ingested.at', 'receivedat', 'received.at',
];
const BODY_KEYS = ['message', 'body', 'msg', 'text', 'log', 'event', 'description'];
const SEVERITY_KEYS = ['severity', 'severitytext', 'severity.text', 'level', 'loglevel', 'log.level'];
const SEVERITY_NUMBER_KEYS = ['severitynumber', 'severity.number'];
const TRACE_KEYS = ['traceid', 'trace.id'];
const SPAN_KEYS = ['spanid', 'span.id'];
const SCOPE_KEYS = ['scope', 'logger', 'loggername', 'logger.name', 'category', 'classname', 'class.name'];
const SERVICE_KEYS = [
  'service.name', 'servicename', 'application.name', 'applicationname',
  'faas.name', 'faasname', 'subsystemname', 'service', 'application', 'app',
];
const SERVICE_INSTANCE_KEYS = [
  'service.instance.id', 'serviceinstanceid', 'faas.instance.cx.id',
  'instance.id', 'instanceid', 'host.name', 'hostname', 'computername',
];

const SEVERITY_BY_TEXT: Record<string, number> = {
  trace: 1, trce: 1, verbose: 1, finest: 1,
  debug: 5, dbug: 5, fine: 5,
  info: 9, information: 9, informational: 9, notice: 9,
  warn: 13, warning: 13,
  error: 17, err: 17, fail: 17, failure: 17, severe: 17,
  fatal: 21, critical: 21, crit: 21, alert: 21, emerg: 21, emergency: 21, panic: 21,
};

// Microsoft.Extensions.Logging console layout, e.g. "fail: Some.Category[0]\n  ...".
const PREFIX_SEVERITY: Record<string, [number, string]> = {
  trce: [1, 'TRACE'],
  dbug: [5, 'DEBUG'],
  info: [9, 'INFO'],
  warn: [13, 'WARN'],
  fail: [17, 'ERROR'],
  crit: [21, 'FATAL'],
};

function flattenInto(o: Record<string, unknown>, prefix: string, depth: number, out: FlatField[]): void {
  if (depth > MAX_FLATTEN_DEPTH) {
    throw new LogImportError(`${prefix || 'record'}: nesting is deeper than ${MAX_FLATTEN_DEPTH} levels`);
  }
  for (const key of Object.keys(o)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new LogImportError(`${prefix ? `${prefix}.` : ''}${key}: key "${key}" is not allowed`);
    }
    const path = prefix ? `${prefix}.${key}` : key;
    const value = o[key];
    if (isPlainObject(value)) {
      flattenInto(value, path, depth + 1, out);
      continue;
    }
    // Empty strings and nulls are placeholders in most exports, not data worth a column.
    if (value === null || value === undefined || value === '') continue;
    if (out.length >= MAX_FLATTEN_KEYS) {
      throw new LogImportError(`record has more than ${MAX_FLATTEN_KEYS} fields`);
    }
    out.push({ path, leaf: normaliseLeaf(key), value: readAttributeValue(value, path) });
  }
}

// Magnitude decides the unit: an epoch in seconds and one in nanoseconds are 9 digits apart.
function scaleToMs(n: number): number {
  const abs = Math.abs(n);
  if (abs >= 1e17) return Math.round(n / 1e6);
  if (abs >= 1e14) return Math.round(n / 1e3);
  if (abs >= 1e11) return Math.round(n);
  return Math.round(n * 1000);
}

function autoEpochMs(v: AttributeValue, path: string): number | undefined {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(path, 'a finite timestamp');
    return scaleToMs(v);
  }
  if (typeof v === 'string') {
    // Nanosecond epochs exceed Number.MAX_SAFE_INTEGER, so integer strings are scaled as BigInt.
    if (/^-?\d+$/.test(v)) {
      const n = BigInt(v);
      const abs = n < 0n ? -n : n;
      if (abs >= 100_000_000_000_000_000n) return Number(n / 1_000_000n);
      if (abs >= 100_000_000_000_000n) return Number(n / 1_000n);
      if (abs >= 100_000_000_000n) return Number(n);
      return Number(n) * 1000;
    }
    const parsed = Date.parse(v);
    if (Number.isNaN(parsed)) fail(path, 'a timestamp');
    return parsed;
  }
  return undefined;
}

function severityFromPrefix(body: AttributeValue): [number, string] | undefined {
  if (typeof body !== 'string') return undefined;
  const m = /^(trce|dbug|info|warn|fail|crit)\s*:/i.exec(body);
  return m ? PREFIX_SEVERITY[m[1].toLowerCase()] : undefined;
}

function pick(byLeaf: Map<string, FlatField>, candidates: readonly string[]): FlatField | undefined {
  for (const c of candidates) {
    const f = byLeaf.get(c);
    if (f) return f;
  }
  return undefined;
}

interface MappedLine {
  log: LogRecord;
  serviceName?: string;
  serviceInstanceId?: string;
}

export function mapJsonlRecord(value: Record<string, unknown>, path: string): MappedLine {
  const fields: FlatField[] = [];
  flattenInto(value, '', 0, fields);
  if (!fields.length) throw new LogImportError(`${path}: object has no usable fields`);

  const byLeaf = new Map<string, FlatField>();
  for (const f of fields) if (!byLeaf.has(f.leaf)) byLeaf.set(f.leaf, f);

  const consumed = new Set<string>();
  const take = (candidates: readonly string[]): FlatField | undefined => {
    const f = pick(byLeaf, candidates);
    if (f) consumed.add(f.path);
    return f;
  };

  const timeField = take(TIME_KEYS);
  const observedField = take(OBSERVED_TIME_KEYS);
  const bodyField = take(BODY_KEYS);
  const severityField = take(SEVERITY_KEYS);
  const severityNumberField = take(SEVERITY_NUMBER_KEYS);
  const traceField = take(TRACE_KEYS);
  const spanField = take(SPAN_KEYS);
  const scopeField = take(SCOPE_KEYS);
  const serviceField = take(SERVICE_KEYS);
  const instanceField = take(SERVICE_INSTANCE_KEYS);

  const body = bodyField ? bodyField.value : null;
  const timeMs = timeField ? autoEpochMs(timeField.value, `${path}.${timeField.path}`) : undefined;
  const observedTimeMs = observedField
    ? autoEpochMs(observedField.value, `${path}.${observedField.path}`)
    : undefined;

  let severityText = '';
  let severityNumber = 0;
  if (severityNumberField) {
    severityNumber = clampSeverity(severityNumberField.value, `${path}.${severityNumberField.path}`);
  }
  if (severityField) {
    if (typeof severityField.value === 'string') {
      severityText = severityField.value;
      if (!severityNumber) severityNumber = SEVERITY_BY_TEXT[severityText.trim().toLowerCase()] ?? 0;
    } else if (typeof severityField.value === 'number' && !severityNumber) {
      severityNumber = clampSeverity(severityField.value, `${path}.${severityField.path}`);
    }
  }
  if (!severityNumber) {
    const fromPrefix = severityFromPrefix(body);
    if (fromPrefix) {
      severityNumber = fromPrefix[0];
      if (!severityText) severityText = fromPrefix[1];
    }
  }

  const str = (f: FlatField | undefined): string | undefined =>
    f && typeof f.value === 'string' ? f.value : undefined;

  const attrs: KeyValueMap = {};
  let count = 0;
  for (const f of fields) {
    if (consumed.has(f.path)) continue;
    if (++count > MAX_ATTRS_PER_RECORD) {
      throw new LogImportError(
        `${path}: more than ${MAX_ATTRS_PER_RECORD} leftover fields exceeds the per-record attribute limit`
      );
    }
    attrs[f.path] = f.value;
  }

  return {
    log: {
      timeMs: timeMs ?? observedTimeMs ?? 0,
      observedTimeMs,
      severityNumber,
      severityText,
      body,
      attrs,
      traceId: traceIdOf(str(traceField)),
      spanId: spanIdOf(str(spanField)),
      scope: str(scopeField),
    },
    serviceName: str(serviceField),
    serviceInstanceId: str(instanceField),
  };
}

// Tolerant on purpose: a single malformed leading line should not disqualify the whole file.
export function detectJsonl(text: string): boolean {
  let checked = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const value = JSON.parse(line);
        if (isPlainObject(value) && looksLikeLogObject(value)) return true;
      } catch {
        // Keep scanning; a later line may still be well-formed.
      }
    }
    if (++checked >= JSONL_DETECT_LINES) return false;
  }
  return false;
}

// An arbitrary JSON object is only a log line if something time-, body- or severity-shaped is in it.
function looksLikeLogObject(value: Record<string, unknown>): boolean {
  const fields: FlatField[] = [];
  try {
    flattenInto(value, '', 0, fields);
  } catch {
    return false;
  }
  const leaves = new Set(fields.map((f) => f.leaf));
  return [...TIME_KEYS, ...BODY_KEYS, ...SEVERITY_KEYS].some((k) => leaves.has(k));
}

export function parseJsonLines(text: string, maxRecords: number): ImportedLogs {
  const lines = text.split(/\r?\n/);
  const logs: LogRecord[] = [];
  let skipped = 0;
  let skippedSample: string | undefined;
  let serviceName = '';
  let serviceInstanceId: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = i === 0 ? lines[i].replace(/^\uFEFF/, '') : lines[i];
    if (!raw.trim()) continue;

    let mapped: MappedLine;
    try {
      const value = JSON.parse(raw);
      if (!isPlainObject(value)) fail(`line ${i + 1}`, 'a JSON object');
      mapped = mapJsonlRecord(value, `line ${i + 1}`);
    } catch (e) {
      skipped++;
      if (!skippedSample) skippedSample = `line ${i + 1}: ${(e as Error).message}`;
      continue;
    }

    if (!serviceName && mapped.serviceName) serviceName = mapped.serviceName;
    if (!serviceInstanceId && mapped.serviceInstanceId) serviceInstanceId = mapped.serviceInstanceId;
    logs.push(mapped.log);
    // Bail as soon as the cap is passed rather than materialising the whole file first.
    if (logs.length > maxRecords) {
      throw new LogImportError(
        `File contains more than ${maxRecords} records, above the import limit. ` +
          'Raise otel.import.maxRecords to import it.'
      );
    }
  }

  if (!logs.length) {
    throw new LogImportError(
      skippedSample
        ? `No line could be read as a log record. First failure — ${skippedSample}`
        : 'File contains no log records.'
    );
  }

  const resolvedName = serviceName || 'imported';
  const resourceAttrs: KeyValueMap = { 'service.name': resolvedName };
  if (serviceInstanceId) resourceAttrs['service.instance.id'] = serviceInstanceId;

  return { serviceName: resolvedName, serviceInstanceId, resourceAttrs, logs, skipped, skippedSample };
}

// --- Entry point -------------------------------------------------------------------------------

export function parseLogFile(text: string, maxRecords: number): ImportedLogs {
  let doc: unknown;
  let jsonError: string | undefined;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    jsonError = (e as Error).message;
  }

  const format = jsonError === undefined ? detectFormat(doc) : 'unknown';
  if (format === 'unknown') {
    if (detectJsonl(text)) return parseJsonLines(text, maxRecords);
    throw new LogImportError(
      'Unrecognised file. Import accepts OTLP/JSON, JSON Lines (.jsonl/.ndjson), ' +
        'or logs exported from this extension as Plain JSON.' +
        (jsonError ? ` Not valid JSON: ${jsonError}` : '')
    );
  }

  const parsed = format === 'otlp' ? parseOtlpJson(doc) : parsePlainJson(doc);
  if (parsed.logs.length > maxRecords) {
    throw new LogImportError(
      `File contains ${parsed.logs.length} records, above the ${maxRecords} limit. ` +
        'Raise otel.import.maxRecords to import it.'
    );
  }
  if (!parsed.logs.length) throw new LogImportError('File contains no log records.');
  return parsed;
}
