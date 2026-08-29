// In-memory telemetry store. Framework-agnostic (no vscode import) so it can be unit-tested.
// Holds applications -> instances -> {logs, traces, metrics}. Data is cleared on receiver
// restart. Emits debounced change events for the UI.

import { createHash } from 'crypto';
import {
  KeyValueMap,
  LogRecord,
  Metric,
  MetricSeriesPoint,
  ResourceInfo,
  ResourceLogs,
  ResourceMetrics,
  ResourceSpans,
  Span,
  Trace,
} from './model';
import { RingBuffer } from './ringBuffer';

// Time-ordered history for one metric series (a metric name + attribute set + field).
export interface MetricSeries {
  metricName: string;
  attrs: KeyValueMap;
  field: string;
  points: RingBuffer<MetricSeriesPoint>;
}

export interface Instance {
  id: string;
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttrs: KeyValueMap;
  logs: RingBuffer<LogRecord>;
  traces: Map<string, Trace>;
  metrics: Map<string, Metric>;
  metricSeries: Map<string, MetricSeries>;
  firstSeen: number;
  lastSeen: number;
  peer?: string;
  logCount: number;
  spanCount: number;
}

export interface Application {
  name: string;
  instances: Instance[];
}

type Listener = () => void;

export class TelemetryStore {
  private instances = new Map<string, Instance>();
  private listeners = new Set<Listener>();
  private fireTimer: NodeJS.Timeout | undefined;
  private maxLogs: number;
  private maxTraces: number;
  private maxMetricPoints: number;
  private maxMetricSeries: number;

  constructor(maxLogs = 5000, maxTraces = 2000, maxMetricPoints = 500, maxMetricSeries = 200) {
    this.maxLogs = maxLogs;
    this.maxTraces = maxTraces;
    this.maxMetricPoints = maxMetricPoints;
    this.maxMetricSeries = maxMetricSeries;
  }

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private scheduleFire(): void {
    if (this.fireTimer) return;
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      for (const l of this.listeners) {
        try {
          l();
        } catch {
          /* ignore listener errors */
        }
      }
    }, 150);
  }

  setRetention(maxLogs: number, maxTraces: number, maxMetricPoints?: number): void {
    this.maxLogs = Math.max(1, maxLogs);
    this.maxTraces = Math.max(1, maxTraces);
    if (maxMetricPoints !== undefined) this.maxMetricPoints = Math.max(1, maxMetricPoints);
    for (const inst of this.instances.values()) {
      inst.logs.setCapacity(this.maxLogs);
      this.capTraces(inst);
      for (const series of inst.metricSeries.values()) {
        series.points.setCapacity(this.maxMetricPoints);
      }
    }
  }

  getApplications(): Application[] {
    const byApp = new Map<string, Instance[]>();
    for (const inst of this.instances.values()) {
      const list = byApp.get(inst.serviceName) ?? [];
      list.push(inst);
      byApp.set(inst.serviceName, list);
    }
    return [...byApp.entries()]
      .map(([name, instances]) => ({
        name,
        instances: instances.sort((a, b) => b.lastSeen - a.lastSeen),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  getAllInstances(): Instance[] {
    return [...this.instances.values()];
  }

  removeInstance(id: string): void {
    if (this.instances.delete(id)) {
      this.scheduleFire();
    }
  }

  clear(): void {
    this.instances.clear();
    this.scheduleFire();
  }

  private instanceId(resource: ResourceInfo, peer?: string): string {
    if (resource.serviceInstanceId) {
      return `${resource.serviceName}::${resource.serviceInstanceId}`;
    }
    const hash = createHash('sha1');
    const keys = Object.keys(resource.attrs).sort();
    hash.update(resource.serviceName);
    for (const k of keys) {
      hash.update(k);
      hash.update(String(resource.attrs[k]));
    }
    if (peer) hash.update(peer);
    return `${resource.serviceName}::${hash.digest('hex').slice(0, 16)}`;
  }

  private upsertInstance(resource: ResourceInfo, peer?: string): Instance {
    const id = this.instanceId(resource, peer);
    let inst = this.instances.get(id);
    const now = Date.now();
    if (!inst) {
      inst = {
        id,
        serviceName: resource.serviceName,
        serviceInstanceId: resource.serviceInstanceId,
        resourceAttrs: resource.attrs,
        logs: new RingBuffer<LogRecord>(this.maxLogs),
        traces: new Map(),
        metrics: new Map(),
        metricSeries: new Map(),
        firstSeen: now,
        lastSeen: now,
        peer,
        logCount: 0,
        spanCount: 0,
      };
      this.instances.set(id, inst);
    } else {
      inst.lastSeen = now;
      inst.resourceAttrs = resource.attrs;
      if (peer) inst.peer = peer;
    }
    return inst;
  }

  ingestLogs(batches: ResourceLogs[], peer?: string): void {
    let changed = false;
    for (const b of batches) {
      const inst = this.upsertInstance(b.resource, peer);
      for (const log of b.logs) {
        inst.logs.push(log);
        inst.logCount++;
        changed = true;
      }
    }
    if (changed) this.scheduleFire();
  }

  ingestSpans(batches: ResourceSpans[], peer?: string): void {
    let changed = false;
    for (const b of batches) {
      const inst = this.upsertInstance(b.resource, peer);
      for (const span of b.spans) {
        if (!span.traceId || !span.spanId) continue;
        this.addSpan(inst, span);
        inst.spanCount++;
        changed = true;
      }
      this.capTraces(inst);
    }
    if (changed) this.scheduleFire();
  }

  private addSpan(inst: Instance, span: Span): void {
    let trace = inst.traces.get(span.traceId);
    if (!trace) {
      trace = {
        traceId: span.traceId,
        spans: new Map(),
        startMs: span.startMs,
        endMs: span.endMs,
        durationMs: 0,
        hasError: false,
        serviceNames: new Set(),
        lastUpdated: Date.now(),
      };
      inst.traces.set(span.traceId, trace);
    }
    trace.spans.set(span.spanId, span);
    trace.serviceNames.add(inst.serviceName);
    trace.startMs = trace.startMs === 0 ? span.startMs : Math.min(trace.startMs, span.startMs);
    trace.endMs = Math.max(trace.endMs, span.endMs);
    trace.durationMs = Math.max(0, trace.endMs - trace.startMs);
    if (span.statusCode === 'ERROR') trace.hasError = true;
    if (!span.parentSpanId || !trace.spans.has(span.parentSpanId)) {
      // tentative root; finalize on read
    }
    if (!span.parentSpanId) trace.rootSpanId = span.spanId;
    trace.lastUpdated = Date.now();
  }

  private capTraces(inst: Instance): void {
    while (inst.traces.size > this.maxTraces) {
      const oldest = inst.traces.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      inst.traces.delete(oldest);
    }
  }

  ingestMetrics(batches: ResourceMetrics[], peer?: string): void {
    let changed = false;
    for (const b of batches) {
      const inst = this.upsertInstance(b.resource, peer);
      for (const metric of b.metrics) {
        const existing = inst.metrics.get(metric.name);
        if (existing) {
          existing.dataPoints = metric.dataPoints;
          existing.type = metric.type;
          existing.unit = metric.unit;
          existing.description = metric.description;
        } else {
          inst.metrics.set(metric.name, metric);
        }
        this.recordSeries(inst, metric);
        changed = true;
      }
    }
    if (changed) this.scheduleFire();
  }

  /** Append the scalar values of a metric's data points into their per-series history. */
  private recordSeries(inst: Instance, metric: Metric): void {
    for (const dp of metric.dataPoints) {
      if (metric.type === 'summary') {
        for (const q of dp.quantiles ?? []) {
          this.pushSeries(inst, metric.name, dp.attrs, `q${q.quantile}`, dp.timeMs, q.value);
        }
        if (dp.count !== undefined) {
          this.pushSeries(inst, metric.name, dp.attrs, 'count', dp.timeMs, dp.count);
        }
      } else if (metric.type === 'histogram' || metric.type === 'exponentialHistogram') {
        if (dp.count !== undefined) {
          this.pushSeries(inst, metric.name, dp.attrs, 'count', dp.timeMs, dp.count);
        }
        if (dp.sum !== undefined) {
          this.pushSeries(inst, metric.name, dp.attrs, 'sum', dp.timeMs, dp.sum);
        }
      } else if (dp.value !== undefined) {
        this.pushSeries(inst, metric.name, dp.attrs, 'value', dp.timeMs, dp.value);
      }
    }
  }

  private pushSeries(
    inst: Instance,
    metricName: string,
    attrs: KeyValueMap,
    field: string,
    timeMs: number,
    value: number
  ): void {
    const key = this.seriesKey(metricName, attrs, field);
    let series = inst.metricSeries.get(key);
    if (!series) {
      if (inst.metricSeries.size >= this.maxMetricSeries) {
        const oldest = inst.metricSeries.keys().next().value as string | undefined;
        if (oldest !== undefined) inst.metricSeries.delete(oldest);
      }
      series = {
        metricName,
        attrs,
        field,
        points: new RingBuffer<MetricSeriesPoint>(this.maxMetricPoints),
      };
      inst.metricSeries.set(key, series);
    }
    // Drop duplicate/out-of-order re-exports of the same timestamp.
    const last = series.points.last();
    if (last && timeMs <= last.timeMs) return;
    series.points.push({ timeMs, value });
  }

  private seriesKey(metricName: string, attrs: KeyValueMap, field: string): string {
    const hash = createHash('sha1');
    for (const k of Object.keys(attrs).sort()) {
      hash.update(k);
      hash.update('=');
      hash.update(String(attrs[k]));
      hash.update(';');
    }
    return `${metricName}\u0000${field}\u0000${hash.digest('hex').slice(0, 16)}`;
  }

  /** Time-series history for all series of a metric, for charting. */
  getMetricSeries(
    instanceId: string,
    metricName: string
  ): { attrs: KeyValueMap; field: string; data: MetricSeriesPoint[] }[] {
    const inst = this.instances.get(instanceId);
    if (!inst) return [];
    const out: { attrs: KeyValueMap; field: string; data: MetricSeriesPoint[] }[] = [];
    for (const series of inst.metricSeries.values()) {
      if (series.metricName === metricName) {
        out.push({ attrs: series.attrs, field: series.field, data: series.points.toArray() });
      }
    }
    return out;
  }

  /** Merge spans for a trace id across all instances, tagging each with its service. */
  getSpansForTrace(traceId: string): { span: Span; serviceName: string }[] {
    const out: { span: Span; serviceName: string }[] = [];
    for (const inst of this.instances.values()) {
      const trace = inst.traces.get(traceId);
      if (!trace) continue;
      for (const span of trace.spans.values()) {
        out.push({ span, serviceName: inst.serviceName });
      }
    }
    return out;
  }

  /** All spans across all instances, tagged with service name (for the service map). */
  getAllTaggedSpans(): { span: Span; serviceName: string }[] {
    const out: { span: Span; serviceName: string }[] = [];
    for (const inst of this.instances.values()) {
      for (const trace of inst.traces.values()) {
        for (const span of trace.spans.values()) {
          out.push({ span, serviceName: inst.serviceName });
        }
      }
    }
    return out;
  }
}
