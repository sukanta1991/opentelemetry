// SPDX-License-Identifier: Apache-2.0
// Encodes the internal model back into OTLP/JSON shapes; the inverse of decode.ts.
// No vscode import so it stays unit-testable.

import {
  AttributeValue,
  KeyValueMap,
  LogRecord,
  Metric,
  MetricDataPoint,
  Span,
  SpanKind,
  StatusCode,
} from './model';

type Json = Record<string, unknown>;

// Splits off the whole milliseconds so sub-millisecond span timings survive a round trip.
export function msToNano(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '0';
  const whole = Math.floor(ms);
  const frac = Math.min(999_999, Math.round((ms - whole) * 1e6));
  return (BigInt(whole) * 1_000_000n + BigInt(frac)).toString();
}

export function toAnyValue(v: AttributeValue): Json {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    // proto3 JSON encodes int64 as a string.
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
  return { kvlistValue: { values: toKeyValues(v as KeyValueMap) } };
}

export function toKeyValues(attrs: KeyValueMap): { key: string; value: unknown }[] {
  return Object.keys(attrs).map((key) => ({ key, value: toAnyValue(attrs[key]) }));
}

export function encodeResource(
  serviceName: string,
  serviceInstanceId: string | undefined,
  attrs: KeyValueMap
): Json {
  const all: KeyValueMap = { ...attrs, 'service.name': serviceName };
  if (serviceInstanceId) all['service.instance.id'] = serviceInstanceId;
  return { attributes: toKeyValues(all) };
}

// Groups records under their instrumentation scope, keeping first-seen order.
export function byScope<T extends { scope?: string }>(items: readonly T[]): { scope: Json; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.scope ?? '';
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([name, list]) => ({ scope: name ? { name } : {}, items: list }));
}

export function encodeLog(l: LogRecord): Json {
  const out: Json = {
    timeUnixNano: msToNano(l.timeMs),
    severityNumber: l.severityNumber,
    severityText: l.severityText,
    body: toAnyValue(l.body),
    attributes: toKeyValues(l.attrs),
  };
  if (l.observedTimeMs) out.observedTimeUnixNano = msToNano(l.observedTimeMs);
  if (l.traceId) out.traceId = l.traceId;
  if (l.spanId) out.spanId = l.spanId;
  return out;
}

const SPAN_KIND: Record<SpanKind, number> = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
};

const STATUS: Record<StatusCode, number> = { UNSET: 0, OK: 1, ERROR: 2 };

export function encodeSpan(s: Span): Json {
  const status: Json = { code: STATUS[s.statusCode] ?? 0 };
  if (s.statusMessage) status.message = s.statusMessage;
  const out: Json = {
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    kind: SPAN_KIND[s.kind] ?? 0,
    startTimeUnixNano: msToNano(s.startMs),
    endTimeUnixNano: msToNano(s.endMs),
    attributes: toKeyValues(s.attrs),
    events: s.events.map((e) => ({
      timeUnixNano: msToNano(e.timeMs),
      name: e.name,
      attributes: toKeyValues(e.attrs),
    })),
    links: s.links.map((l) => {
      const link: Json = { traceId: l.traceId, spanId: l.spanId, attributes: toKeyValues(l.attrs) };
      if (l.traceState) link.traceState = l.traceState;
      return link;
    }),
    status,
  };
  if (s.parentSpanId) out.parentSpanId = s.parentSpanId;
  return out;
}

function encodePoint(type: Metric['type'], dp: MetricDataPoint): Json {
  const out: Json = { attributes: toKeyValues(dp.attrs), timeUnixNano: msToNano(dp.timeMs) };
  if (type === 'histogram' || type === 'summary' || type === 'exponentialHistogram') {
    // uint64 counts are strings in proto3 JSON.
    if (dp.count !== undefined) out.count = String(dp.count);
    if (dp.sum !== undefined) out.sum = dp.sum;
    if (dp.bucketBounds) out.explicitBounds = dp.bucketBounds;
    if (dp.bucketCounts) out.bucketCounts = dp.bucketCounts.map(String);
    if (dp.quantiles) out.quantileValues = dp.quantiles.map((q) => ({ quantile: q.quantile, value: q.value }));
    return out;
  }
  if (dp.value !== undefined) out.asDouble = dp.value;
  return out;
}

export function encodeMetric(m: Metric, points: readonly MetricDataPoint[]): Json {
  const out: Json = { name: m.name };
  if (m.description) out.description = m.description;
  if (m.unit) out.unit = m.unit;
  if (m.type === 'unknown') return out;
  const data: Json = { dataPoints: points.map((dp) => encodePoint(m.type, dp)) };
  if (m.type === 'sum' && m.monotonic !== undefined) data.isMonotonic = m.monotonic;
  out[m.type] = data;
  return out;
}
