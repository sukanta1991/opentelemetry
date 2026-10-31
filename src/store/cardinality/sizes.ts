// SPDX-License-Identifier: Apache-2.0
// Byte sizes of records as OTLP protobuf (uncompressed, proto3 canonical: default-valued fields omitted)
// and as OTLP/JSON exactly as encode.ts writes it, computed arithmetically in one pass without encoding.
// Only fields the model keeps are counted (no start times, flags, dropped counts or exemplars).
// Pure; no vscode import.

import {
  AttributeValue,
  KeyValueMap,
  LogRecord,
  Metric,
  MetricDataPoint,
  MetricType,
  ResourceInfo,
  Span,
  SpanKind,
  StatusCode,
} from '../model';

export interface Size {
  proto: number;
  json: number;
}

/** Records and their bytes. */
export interface Volume extends Size {
  count: number;
}

export type AttrScope = 'record' | 'event' | 'link';

/**
 * Receives each attribute's share: its framed KeyValue in protobuf, and its JSON object plus the
 * separating comma (none for the first in its list). Called in attribute order.
 */
export type AttrSink = (key: string, value: AttributeValue, proto: number, json: number, scope: AttrScope) => void;

export type Signal = 'traces' | 'logs' | 'metrics';

/** Records under one instrumentation scope: summed record sizes (from the *Size functions) and their count. */
export interface ScopeGroup {
  scope?: string;
  size: Size;
  count: number;
}

// Punctuation and keys of each JSON shape, with every value slot left empty.
const J_KV = '{"key":,"value":}'.length;
const J_STRING = '{"stringValue":}'.length;
const J_INT = '{"intValue":""}'.length;
const J_DOUBLE = '{"doubleValue":}'.length;
const J_TRUE = '{"boolValue":true}'.length;
const J_FALSE = '{"boolValue":false}'.length;
const J_NULL = '{}'.length;
const J_ARRAY = '{"arrayValue":{"values":[]}}'.length;
const J_KVLIST = '{"kvlistValue":{"values":[]}}'.length;
const J_SPAN = '{"traceId":,"spanId":,"name":,"kind":,"startTimeUnixNano":,"endTimeUnixNano":,"attributes":[],"events":[],"links":[],"status":}'.length;
const J_PARENT = ',"parentSpanId":'.length;
const J_EVENT = '{"timeUnixNano":,"name":,"attributes":[]}'.length;
const J_LINK = '{"traceId":,"spanId":,"attributes":[]}'.length;
const J_TRACE_STATE = ',"traceState":'.length;
const J_STATUS = '{"code":}'.length;
const J_STATUS_MESSAGE = ',"message":'.length;
const J_LOG = '{"timeUnixNano":,"severityNumber":,"severityText":,"body":,"attributes":[]}'.length;
const J_OBSERVED = ',"observedTimeUnixNano":'.length;
const J_TRACE_ID = ',"traceId":'.length;
const J_SPAN_ID = ',"spanId":'.length;
const J_POINT = '{"attributes":[],"timeUnixNano":}'.length;
const J_AS_DOUBLE = ',"asDouble":'.length;
const J_COUNT = ',"count":""'.length;
const J_SUM = ',"sum":'.length;
const J_BOUNDS = ',"explicitBounds":[]'.length;
const J_BUCKETS = ',"bucketCounts":[]'.length;
const J_QUANTILES = ',"quantileValues":[]'.length;
const J_QUANTILE = '{"quantile":,"value":}'.length;
const J_METRIC = '{"name":}'.length;
const J_DESCRIPTION = ',"description":'.length;
const J_UNIT = ',"unit":'.length;
// `,"<type>":{"dataPoints":[]}` without the type name.
const J_DATA = ',"":{"dataPoints":[]}'.length;
const J_MONOTONIC = ',"isMonotonic":'.length;
const J_RESOURCE = '{"attributes":[]}'.length;
const J_NAMED_SCOPE = '{"name":}'.length;

const REQUEST_KEYS: Record<Signal, { resources: string; scopes: string; records: string }> = {
  traces: { resources: 'resourceSpans', scopes: 'scopeSpans', records: 'spans' },
  logs: { resources: 'resourceLogs', scopes: 'scopeLogs', records: 'logRecords' },
  metrics: { resources: 'resourceMetrics', scopes: 'scopeMetrics', records: 'metrics' },
};

const KIND: Record<SpanKind, number> = { UNSPECIFIED: 0, INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
const STATUS: Record<StatusCode, number> = { UNSET: 0, OK: 1, ERROR: 2 };

// Outputs of measure() and anyValue(); scratch values avoid an allocation per string on the ingest path.
let strUtf8 = 0;
let strJson = 0;
let lastJson = 0;

/** Sets strUtf8 (UTF-8 bytes) and strJson (bytes of the JSON string literal, quotes included). */
function measure(s: string): void {
  const n = s.length;
  // Leading printable ASCII other than " and \ is one byte in both encodings.
  let i = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 34 || c === 92) break;
  }
  let utf8 = i;
  let json = 2 + i;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      utf8++;
      if (c === 34 || c === 92) json += 2;
      else if (c >= 0x20) json++;
      else json += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    } else if (c < 0x800) {
      utf8 += 2;
      json += 2;
    } else if ((c & 0xfc00) === 0xd800 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      utf8 += 4;
      json += 4;
      i++;
    } else if ((c & 0xf800) === 0xd800) {
      // Lone surrogate: U+FFFD in UTF-8, a \uXXXX escape in JSON.
      utf8 += 3;
      json += 6;
    } else {
      utf8 += 3;
      json += 3;
    }
  }
  strUtf8 = utf8;
  strJson = json;
}

function varint(n: number): number {
  let size = 1;
  while (n >= 128) {
    n = Math.floor(n / 128);
    size++;
  }
  return size;
}

// Negative int64 values always take 10 bytes; so do values beyond int64.
const int64Varint = (n: number) => (n < 0 || n >= 2 ** 63 ? 10 : varint(n));

/** A length-delimited field with a one-byte tag (every OTLP field number used here is below 16). */
const lenField = (len: number) => 1 + varint(len) + len;

const POW10 = Array.from({ length: 16 }, (_, i) => 10 ** i);

/** Decimal digits of an integer (with its minus sign); comparisons instead of repeated division. */
function intDigits(n: number): number {
  const a = Math.abs(n);
  let d = 1;
  while (d < POW10.length && a >= POW10[d]) d++;
  if (d === POW10.length) d = String(Math.floor(a)).length;
  return n < 0 ? d + 1 : d;
}

const stringLen = (n: number) => (Number.isSafeInteger(n) ? intDigits(n) : String(n).length);
const numJson = (n: number) => (Number.isFinite(n) ? stringLen(n) : 4);
const commas = (n: number) => (n > 0 ? n - 1 : 0);

/** Digits of msToNano(ms), or 0 when it is "0" (the field is then omitted in protobuf). */
function nanoDigits(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return 0;
  const whole = Math.floor(ms);
  const frac = Math.min(999_999, Math.round((ms - whole) * 1e6));
  if (whole > 0) return intDigits(whole) + 6;
  return frac > 0 ? intDigits(frac) : 0;
}

const nanoProto = (ms: number | undefined) => (nanoDigits(ms) ? 9 : 0);
const nanoJson = (ms: number | undefined) => 2 + Math.max(1, nanoDigits(ms));

/** Framed protobuf length of a string field (0 when empty); also sets strJson. */
function stringField(s: string | undefined): number {
  if (!s) {
    strUtf8 = 0;
    strJson = 2;
    return 0;
  }
  measure(s);
  return lenField(strUtf8);
}

function stringJson(s: string): number {
  measure(s);
  return strJson;
}

// Hex ids are bytes fields in protobuf (half the hex length) and ASCII strings in JSON.
const idField = (hex: string | undefined) => (hex ? lenField(hex.length >> 1) : 0);
const idJson = (hex: string) => hex.length + 2;

/** Protobuf length of the AnyValue message's content; sets lastJson to its JSON length. */
function anyValue(v: AttributeValue): number {
  if (typeof v === 'string') {
    measure(v);
    lastJson = J_STRING + strJson;
    return lenField(strUtf8);
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      lastJson = J_INT + stringLen(v);
      return 1 + int64Varint(v);
    }
    lastJson = J_DOUBLE + numJson(v);
    return 9;
  }
  if (typeof v === 'boolean') {
    lastJson = v ? J_TRUE : J_FALSE;
    return 2;
  }
  if (v === null || v === undefined) {
    lastJson = J_NULL;
    return 0;
  }
  let content = 0;
  if (Array.isArray(v)) {
    let json = J_ARRAY + commas(v.length);
    for (const item of v) {
      content += lenField(anyValue(item));
      json += lastJson;
    }
    lastJson = json;
    return lenField(content);
  }
  const keys = Object.keys(v);
  let json = J_KVLIST + commas(keys.length);
  for (const k of keys) {
    content += lenField(keyValue(k, v[k]));
    json += lastJson;
  }
  lastJson = json;
  return lenField(content);
}

/** Protobuf length of a KeyValue's content (a null value is omitted); sets lastJson. */
function keyValue(key: string, v: AttributeValue): number {
  measure(key);
  const keyProto = strUtf8 ? lenField(strUtf8) : 0;
  const keyJson = strJson;
  const valueProto = anyValue(v);
  lastJson = J_KV + keyJson + lastJson;
  return keyProto + (v === null || v === undefined ? 0 : lenField(valueProto));
}

/** Framed protobuf length of an attribute list; sets lastJson to the JSON items and commas (no brackets). */
function attributes(map: KeyValueMap, sink: AttrSink | undefined, scope: AttrScope): number {
  let proto = 0;
  let json = 0;
  let first = true;
  for (const k of Object.keys(map)) {
    const v = map[k];
    const p = lenField(keyValue(k, v));
    const j = lastJson + (first ? 0 : 1);
    first = false;
    proto += p;
    json += j;
    sink?.(k, v, p, j, scope);
  }
  lastJson = json;
  return proto;
}

/** A span as one entry of ScopeSpans.spans. */
export function spanSize(s: Span, sink?: AttrSink): Size {
  let proto = stringField(s.name);
  let json = J_SPAN + strJson + idJson(s.traceId) + idJson(s.spanId) + 1;
  proto += idField(s.traceId) + idField(s.spanId) + idField(s.parentSpanId);
  if (s.parentSpanId) json += J_PARENT + idJson(s.parentSpanId);
  if (KIND[s.kind]) proto += 2;
  proto += nanoProto(s.startMs) + nanoProto(s.endMs);
  json += nanoJson(s.startMs) + nanoJson(s.endMs);

  proto += attributes(s.attrs, sink, 'record');
  json += lastJson;

  json += commas(s.events.length);
  for (const e of s.events) {
    const content = nanoProto(e.timeMs) + stringField(e.name) + attributes(e.attrs, sink, 'event');
    json += J_EVENT + lastJson + nanoJson(e.timeMs) + stringJson(e.name);
    proto += lenField(content);
  }

  json += commas(s.links.length);
  for (const l of s.links) {
    const content = idField(l.traceId) + idField(l.spanId) + stringField(l.traceState) + attributes(l.attrs, sink, 'link');
    json += J_LINK + lastJson + idJson(l.traceId) + idJson(l.spanId);
    if (l.traceState) json += J_TRACE_STATE + stringJson(l.traceState);
    proto += lenField(content);
  }

  const code = STATUS[s.statusCode] ?? 0;
  const status = stringField(s.statusMessage) + (code ? 2 : 0);
  if (status) proto += lenField(status);
  json += J_STATUS + 1;
  if (s.statusMessage) json += J_STATUS_MESSAGE + stringJson(s.statusMessage);

  return { proto: lenField(proto), json };
}

/** A log record as one entry of ScopeLogs.log_records. */
export function logSize(l: LogRecord, sink?: AttrSink): Size {
  let proto = stringField(l.severityText);
  let json = J_LOG + strJson + nanoJson(l.timeMs) + numJson(l.severityNumber);
  proto += nanoProto(l.timeMs) + idField(l.traceId) + idField(l.spanId);
  if (l.observedTimeMs) {
    proto += nanoProto(l.observedTimeMs);
    json += J_OBSERVED + nanoJson(l.observedTimeMs);
  }
  const severity = Math.trunc(l.severityNumber);
  if (severity) proto += 1 + int64Varint(severity);
  const body = anyValue(l.body);
  json += lastJson;
  if (l.body !== null && l.body !== undefined) proto += lenField(body);
  proto += attributes(l.attrs, sink, 'record');
  json += lastJson;
  if (l.traceId) json += J_TRACE_ID + idJson(l.traceId);
  if (l.spanId) json += J_SPAN_ID + idJson(l.spanId);
  return { proto: lenField(proto), json };
}

/** A data point as one entry of its metric's data_points. */
export function pointSize(type: MetricType, dp: MetricDataPoint, sink?: AttrSink): Size {
  let proto = attributes(dp.attrs, sink, 'record') + nanoProto(dp.timeMs);
  let json = J_POINT + lastJson + nanoJson(dp.timeMs);
  if (type !== 'histogram' && type !== 'summary' && type !== 'exponentialHistogram') {
    if (dp.value !== undefined) {
      proto += 9;
      json += J_AS_DOUBLE + numJson(dp.value);
    }
    return { proto: lenField(proto), json };
  }
  if (dp.count !== undefined) {
    if (dp.count !== 0) proto += 9;
    json += J_COUNT + String(dp.count).length;
  }
  if (dp.sum !== undefined) {
    // `sum` is optional (has presence) on histograms, a plain double on summaries.
    if (type !== 'summary' || dp.sum !== 0) proto += 9;
    json += J_SUM + numJson(dp.sum);
  }
  if (dp.bucketBounds) {
    if (type === 'histogram' && dp.bucketBounds.length) proto += lenField(8 * dp.bucketBounds.length);
    json += J_BOUNDS + commas(dp.bucketBounds.length);
    for (const b of dp.bucketBounds) json += numJson(b);
  }
  if (dp.bucketCounts) {
    if (type === 'histogram' && dp.bucketCounts.length) proto += lenField(8 * dp.bucketCounts.length);
    json += J_BUCKETS + commas(dp.bucketCounts.length);
    for (const c of dp.bucketCounts) json += 2 + String(c).length;
  }
  if (dp.quantiles) {
    json += J_QUANTILES + commas(dp.quantiles.length);
    for (const q of dp.quantiles) {
      if (type === 'summary') proto += lenField((q.quantile !== 0 ? 9 : 0) + (q.value !== 0 ? 9 : 0));
      json += J_QUANTILE + numJson(q.quantile) + numJson(q.value);
    }
  }
  return { proto: lenField(proto), json };
}

/** A metric as one entry of ScopeMetrics.metrics, given its points' summed pointSize() and count. */
export function metricSize(m: Metric, points: Size, pointCount: number): Size {
  let proto = stringField(m.name) + stringField(m.description) + stringField(m.unit);
  let json = J_METRIC + stringJson(m.name);
  if (m.description) json += J_DESCRIPTION + stringJson(m.description);
  if (m.unit) json += J_UNIT + stringJson(m.unit);
  if (m.type !== 'unknown') {
    proto += lenField(points.proto + (m.type === 'sum' && m.monotonic === true ? 2 : 0));
    json += J_DATA + m.type.length + points.json + commas(pointCount);
    if (m.type === 'sum' && m.monotonic !== undefined) json += J_MONOTONIC + (m.monotonic ? 4 : 5);
  }
  return { proto: lenField(proto), json };
}

/** A whole Export*ServiceRequest holding one resource and its scope groups. */
export function requestSize(signal: Signal, resource: ResourceInfo, groups: readonly ScopeGroup[]): Size {
  const keys = REQUEST_KEYS[signal];
  // Mirrors encodeResource: service.name always, service.instance.id when known, replacing same-named attributes.
  const attrs = resource.attrs;
  let resProto = 0;
  let resJson = 0;
  let count = 0;
  const add = (k: string, v: AttributeValue): void => {
    resProto += lenField(keyValue(k, v));
    resJson += lastJson;
    count++;
  };
  for (const k of Object.keys(attrs)) {
    if (k === 'service.name') add(k, resource.serviceName);
    else if (k === 'service.instance.id' && resource.serviceInstanceId) add(k, resource.serviceInstanceId);
    else add(k, attrs[k]);
  }
  if (!Object.prototype.hasOwnProperty.call(attrs, 'service.name')) add('service.name', resource.serviceName);
  if (resource.serviceInstanceId && !Object.prototype.hasOwnProperty.call(attrs, 'service.instance.id')) {
    add('service.instance.id', resource.serviceInstanceId);
  }

  let proto = lenField(resProto);
  let json =
    `{"${keys.resources}":[{"resource":,"${keys.scopes}":[]}]}`.length + J_RESOURCE + resJson + commas(count) + commas(groups.length);
  const groupJson = `{"scope":,"${keys.records}":[]}`.length;
  for (const g of groups) {
    const scope = g.scope ? lenField(stringField(g.scope)) : 0;
    proto += lenField(scope + g.size.proto);
    json += groupJson + (g.scope ? J_NAMED_SCOPE + stringJson(g.scope) : J_NULL) + g.size.json + commas(g.count);
  }
  return { proto: lenField(proto), json };
}
