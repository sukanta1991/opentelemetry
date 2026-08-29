// Decodes OTLP payloads (already parsed from protobuf or JSON into plain JS objects)
// into the internal model. Handles the union of shapes produced by @grpc/proto-loader,
// protobufjs toObject, and OTLP/JSON: camelCase fields, 64-bit ints as decimal strings,
// bytes as base64 (proto) or hex (OTLP/JSON), enums as numbers or names.

import {
  AttributeValue,
  CodeLocation,
  KeyValueMap,
  LogRecord,
  Metric,
  MetricDataPoint,
  MetricType,
  ResourceInfo,
  ResourceLogs,
  ResourceMetrics,
  ResourceSpans,
  Span,
  SpanEvent,
  SpanKind,
  StatusCode,
} from './model';

const HEX_TRACE = /^[0-9a-f]{32}$/i;
const HEX_SPAN = /^[0-9a-f]{16}$/i;

export function toHexId(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') {
    if (input.length === 0) return undefined;
    if (HEX_TRACE.test(input) || HEX_SPAN.test(input)) return input.toLowerCase();
    // assume base64
    try {
      const hex = Buffer.from(input, 'base64').toString('hex');
      return hex.length ? hex : undefined;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(input)) {
    return Buffer.from(input).toString('hex');
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input).toString('hex');
  }
  return undefined;
}

function nanoToMs(nano: unknown): number {
  if (nano === undefined || nano === null) return 0;
  if (typeof nano === 'number') return nano / 1e6;
  if (typeof nano === 'string') {
    if (nano === '' || nano === '0') return 0;
    // Preserve millisecond precision without float error on the full nanosecond value.
    try {
      const big = BigInt(nano);
      const ms = big / 1_000_000n;
      const frac = Number(big % 1_000_000n) / 1e6;
      return Number(ms) + frac;
    } catch {
      const n = Number(nano);
      return Number.isFinite(n) ? n / 1e6 : 0;
    }
  }
  if (typeof nano === 'object' && nano !== null && 'low' in (nano as any)) {
    // protobufjs Long-like
    const l = nano as { low: number; high: number; unsigned?: boolean };
    const big = (BigInt(l.high >>> 0) << 32n) | BigInt(l.low >>> 0);
    return Number(big / 1_000_000n);
  }
  return 0;
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'object' && v !== null && 'low' in (v as any)) {
    const l = v as { low: number; high: number };
    return Number((BigInt(l.high >>> 0) << 32n) | BigInt(l.low >>> 0));
  }
  return undefined;
}

function anyValue(v: any): AttributeValue {
  if (v === undefined || v === null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return !!v.boolValue;
  if (v.intValue !== undefined) return toNumber(v.intValue) ?? 0;
  if (v.doubleValue !== undefined) return toNumber(v.doubleValue) ?? 0;
  if (v.bytesValue !== undefined) {
    try {
      return Buffer.from(v.bytesValue, typeof v.bytesValue === 'string' ? 'base64' : undefined as any).toString('hex');
    } catch {
      return String(v.bytesValue);
    }
  }
  if (v.arrayValue !== undefined) {
    const items = v.arrayValue.values || [];
    return items.map((it: any) => anyValue(it));
  }
  if (v.kvlistValue !== undefined) {
    return keyValues(v.kvlistValue.values || []);
  }
  return null;
}

function keyValues(list: any[]): KeyValueMap {
  const out: KeyValueMap = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    if (!kv || typeof kv.key !== 'string') continue;
    out[kv.key] = anyValue(kv.value);
  }
  return out;
}

function attrString(attrs: KeyValueMap, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
}

function resourceInfo(resource: any): ResourceInfo {
  const attrs = keyValues(resource?.attributes || []);
  const serviceName = attrString(attrs, 'service.name') || 'unknown_service';
  const serviceInstanceId = attrString(attrs, 'service.instance.id');
  return { serviceName, serviceInstanceId, attrs };
}

const SPAN_KIND_MAP: Record<string, SpanKind> = {
  '0': 'UNSPECIFIED',
  '1': 'INTERNAL',
  '2': 'SERVER',
  '3': 'CLIENT',
  '4': 'PRODUCER',
  '5': 'CONSUMER',
  SPAN_KIND_UNSPECIFIED: 'UNSPECIFIED',
  SPAN_KIND_INTERNAL: 'INTERNAL',
  SPAN_KIND_SERVER: 'SERVER',
  SPAN_KIND_CLIENT: 'CLIENT',
  SPAN_KIND_PRODUCER: 'PRODUCER',
  SPAN_KIND_CONSUMER: 'CONSUMER',
};

function spanKind(k: unknown): SpanKind {
  return SPAN_KIND_MAP[String(k)] ?? 'UNSPECIFIED';
}

const STATUS_MAP: Record<string, StatusCode> = {
  '0': 'UNSET',
  '1': 'OK',
  '2': 'ERROR',
  STATUS_CODE_UNSET: 'UNSET',
  STATUS_CODE_OK: 'OK',
  STATUS_CODE_ERROR: 'ERROR',
};

function statusCode(c: unknown): StatusCode {
  return STATUS_MAP[String(c)] ?? 'UNSET';
}

function codeLocation(attrs: KeyValueMap): CodeLocation | undefined {
  const filepath = attrString(attrs, 'code.filepath') || attrString(attrs, 'code.file.path');
  if (!filepath) return undefined;
  const line = toNumber(attrs['code.lineno'] ?? attrs['code.line.number']);
  const column = toNumber(attrs['code.column'] ?? attrs['code.column.number']);
  const fn = attrString(attrs, 'code.function') || attrString(attrs, 'code.function.name');
  return { filepath, line, column, function: fn };
}

function scopeName(scope: any): string | undefined {
  return scope && typeof scope.name === 'string' && scope.name ? scope.name : undefined;
}

export function decodeLogs(req: any): ResourceLogs[] {
  const out: ResourceLogs[] = [];
  for (const rl of req?.resourceLogs || []) {
    const resource = resourceInfo(rl.resource);
    const logs: LogRecord[] = [];
    for (const sl of rl.scopeLogs || rl.instrumentationLibraryLogs || []) {
      const scope = scopeName(sl.scope);
      for (const lr of sl.logRecords || sl.log_records || []) {
        const attrs = keyValues(lr.attributes || []);
        logs.push({
          timeMs: nanoToMs(lr.timeUnixNano),
          observedTimeMs: nanoToMs(lr.observedTimeUnixNano) || undefined,
          severityNumber: toNumber(lr.severityNumber) ?? 0,
          severityText: typeof lr.severityText === 'string' ? lr.severityText : '',
          body: anyValue(lr.body),
          attrs,
          traceId: toHexId(lr.traceId),
          spanId: toHexId(lr.spanId),
          scope,
          codeLocation: codeLocation(attrs),
        });
      }
    }
    out.push({ resource, logs });
  }
  return out;
}

export function decodeTraces(req: any): ResourceSpans[] {
  const out: ResourceSpans[] = [];
  for (const rs of req?.resourceSpans || []) {
    const resource = resourceInfo(rs.resource);
    const spans: Span[] = [];
    for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
      const scope = scopeName(ss.scope);
      for (const sp of ss.spans || []) {
        const startMs = nanoToMs(sp.startTimeUnixNano);
        const endMs = nanoToMs(sp.endTimeUnixNano);
        const events: SpanEvent[] = (sp.events || []).map((e: any) => ({
          timeMs: nanoToMs(e.timeUnixNano),
          name: typeof e.name === 'string' ? e.name : '',
          attrs: keyValues(e.attributes || []),
        }));
        const traceId = toHexId(sp.traceId) || '';
        const spanId = toHexId(sp.spanId) || '';
        spans.push({
          traceId,
          spanId,
          parentSpanId: toHexId(sp.parentSpanId),
          name: typeof sp.name === 'string' ? sp.name : '',
          kind: spanKind(sp.kind),
          startMs,
          endMs,
          durationMs: Math.max(0, endMs - startMs),
          statusCode: statusCode(sp.status?.code),
          statusMessage:
            sp.status && typeof sp.status.message === 'string' && sp.status.message
              ? sp.status.message
              : undefined,
          attrs: keyValues(sp.attributes || []),
          events,
          scope,
        });
      }
    }
    out.push({ resource, spans });
  }
  return out;
}

function metricType(m: any): { type: MetricType; points: any[]; monotonic?: boolean } {
  if (m.gauge) return { type: 'gauge', points: m.gauge.dataPoints || [] };
  if (m.sum) return { type: 'sum', points: m.sum.dataPoints || [], monotonic: m.sum.isMonotonic };
  if (m.histogram) return { type: 'histogram', points: m.histogram.dataPoints || [] };
  if (m.exponentialHistogram)
    return { type: 'exponentialHistogram', points: m.exponentialHistogram.dataPoints || [] };
  if (m.summary) return { type: 'summary', points: m.summary.dataPoints || [] };
  return { type: 'unknown', points: [] };
}

function metricPoint(type: MetricType, dp: any): MetricDataPoint {
  const attrs = keyValues(dp.attributes || []);
  const timeMs = nanoToMs(dp.timeUnixNano);
  if (type === 'histogram') {
    return {
      attrs,
      timeMs,
      count: toNumber(dp.count),
      sum: toNumber(dp.sum),
      bucketBounds: (dp.explicitBounds || []).map((b: any) => toNumber(b) ?? 0),
      bucketCounts: (dp.bucketCounts || []).map((b: any) => toNumber(b) ?? 0),
    };
  }
  if (type === 'summary') {
    return {
      attrs,
      timeMs,
      count: toNumber(dp.count),
      sum: toNumber(dp.sum),
      quantiles: (dp.quantileValues || []).map((q: any) => ({
        quantile: toNumber(q.quantile) ?? 0,
        value: toNumber(q.value) ?? 0,
      })),
    };
  }
  const value = dp.asDouble !== undefined ? toNumber(dp.asDouble) : toNumber(dp.asInt);
  return { attrs, timeMs, value };
}

export function decodeMetrics(req: any): ResourceMetrics[] {
  const out: ResourceMetrics[] = [];
  for (const rm of req?.resourceMetrics || []) {
    const resource = resourceInfo(rm.resource);
    const metrics: Metric[] = [];
    for (const sm of rm.scopeMetrics || rm.instrumentationLibraryMetrics || []) {
      for (const m of sm.metrics || []) {
        const { type, points } = metricType(m);
        metrics.push({
          name: typeof m.name === 'string' ? m.name : '',
          description: m.description || undefined,
          unit: m.unit || undefined,
          type,
          dataPoints: points.map((dp: any) => metricPoint(type, dp)),
        });
      }
    }
    out.push({ resource, metrics });
  }
  return out;
}
