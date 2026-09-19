// Pure parsers for imported log files. Input is untrusted, so every field is validated and
// the first violation aborts the import rather than yielding a silently partial result.

import { AttributeValue, KeyValueMap, LogRecord } from '../store/model';

export type ImportFormat = 'otlp' | 'plain' | 'unknown';

export interface ImportedLogs {
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttrs: KeyValueMap;
  logs: LogRecord[];
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
          traceId: optionalString(rec.traceId, `${path}.traceId`),
          spanId: optionalString(rec.spanId, `${path}.spanId`),
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
      traceId: optionalString(rec.traceId, `${path}.traceId`),
      spanId: optionalString(rec.spanId, `${path}.spanId`),
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

// --- Entry point -------------------------------------------------------------------------------

export function parseLogFile(text: string, maxRecords: number): ImportedLogs {
  const doc = parseJsonDocument(text);
  const format = detectFormat(doc);
  if (format === 'unknown') {
    throw new LogImportError(
      'Unrecognised file. Import accepts OTLP/JSON or logs exported from this extension as Plain JSON.'
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
