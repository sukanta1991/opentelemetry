// Internal normalized telemetry model. Both the gRPC and HTTP receivers decode
// incoming OTLP payloads into these shapes (see decode.ts) before they reach the store.

export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | AttributeValue[]
  | { [key: string]: AttributeValue };

export interface KeyValueMap {
  [key: string]: AttributeValue;
}

export interface ResourceInfo {
  serviceName: string;
  serviceInstanceId?: string;
  attrs: KeyValueMap;
}

export interface CodeLocation {
  filepath: string;
  line?: number;
  column?: number;
  function?: string;
}

export interface LogRecord {
  timeMs: number;
  observedTimeMs?: number;
  severityNumber: number;
  severityText: string;
  body: AttributeValue;
  attrs: KeyValueMap;
  traceId?: string;
  spanId?: string;
  scope?: string;
  codeLocation?: CodeLocation;
}

// A log held by the store. `seq` is a per-instance monotonic id that stays valid after
// ring-buffer eviction, unlike an array index.
export interface StoredLogRecord extends LogRecord {
  seq: number;
}

// 'imported' instances are loaded from a file: read-only, retention-exempt, and not cleared.
export type InstanceKind = 'live' | 'imported';

export type SpanKind =
  | 'UNSPECIFIED'
  | 'INTERNAL'
  | 'SERVER'
  | 'CLIENT'
  | 'PRODUCER'
  | 'CONSUMER';

export type StatusCode = 'UNSET' | 'OK' | 'ERROR';

export interface SpanEvent {
  timeMs: number;
  name: string;
  attrs: KeyValueMap;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attrs: KeyValueMap;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  durationMs: number;
  statusCode: StatusCode;
  statusMessage?: string;
  attrs: KeyValueMap;
  events: SpanEvent[];
  links: SpanLink[];
  scope?: string;
  codeLocation?: CodeLocation;
}

export interface MetricQuantile {
  quantile: number;
  value: number;
}

export interface MetricDataPoint {
  attrs: KeyValueMap;
  timeMs: number;
  value?: number;
  count?: number;
  sum?: number;
  bucketBounds?: number[];
  bucketCounts?: number[];
  quantiles?: MetricQuantile[];
}

// A single sampled value in a metric series' time-ordered history.
export interface MetricSeriesPoint {
  timeMs: number;
  value: number;
}

export type MetricType =
  | 'gauge'
  | 'sum'
  | 'histogram'
  | 'exponentialHistogram'
  | 'summary'
  | 'unknown';

export interface Metric {
  name: string;
  description?: string;
  unit?: string;
  type: MetricType;
  // Only meaningful for `sum`: true = counter, false = updowncounter.
  monotonic?: boolean;
  dataPoints: MetricDataPoint[];
}

// Grouped decode results.
export interface ResourceLogs {
  resource: ResourceInfo;
  logs: LogRecord[];
}
export interface ResourceSpans {
  resource: ResourceInfo;
  spans: Span[];
}
export interface ResourceMetrics {
  resource: ResourceInfo;
  metrics: Metric[];
}

// Store-side aggregate types.
export interface Trace {
  traceId: string;
  spans: Map<string, Span>;
  rootSpanId?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  hasError: boolean;
  serviceNames: Set<string>;
  lastUpdated: number;
}
