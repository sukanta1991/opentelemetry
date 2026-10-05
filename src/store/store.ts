// SPDX-License-Identifier: Apache-2.0
// In-memory telemetry store. Framework-agnostic (no vscode import) so it can be unit-tested.
// Holds applications -> instances -> {logs, traces, metrics}. Data is cleared on receiver
// restart. Emits debounced change events for the UI.

import { createHash } from 'crypto';
import {
  InstanceKind,
  KeyValueMap,
  LogRecord,
  Metric,
  MetricSeriesPoint,
  ResourceInfo,
  ResourceLogs,
  ResourceMetrics,
  ResourceSpans,
  Span,
  StoredLogRecord,
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

// Realm of received data; each loaded file gets its own realm so its traces never merge with others.
export const LIVE_REALM = 'live';

export interface Instance {
  id: string;
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttrs: KeyValueMap;
  kind: InstanceKind;
  realm: string;
  // Display label for imported instances (the source filename).
  source?: string;
  logs: RingBuffer<StoredLogRecord>;
  nextLogSeq: number;
  traces: Map<string, Trace>;
  metrics: Map<string, Metric>;
  metricSeries: Map<string, MetricSeries>;
  firstSeen: number;
  lastSeen: number;
  peer?: string;
  logCount: number;
  spanCount: number;
}

// A window of logs newer than a caller-held cursor, plus the current eviction watermark.
export interface LogDelta {
  records: readonly StoredLogRecord[];
  oldestSeq: number;
  total: number;
}

export interface ImportLogsOptions {
  serviceName: string;
  resourceAttrs: KeyValueMap;
  logs: LogRecord[];
  sourceLabel: string;
}

export interface ImportSessionOptions {
  sourceLabel: string;
  traces: ResourceSpans[];
  logs: ResourceLogs[];
  metrics: ResourceMetrics[];
}

export interface ImportedSession {
  id: string;
  source: string;
  loadedAt: number;
}

export interface ImportedSessionView {
  session: ImportedSession;
  instances: Instance[];
}

export interface Application {
  name: string;
  instances: Instance[];
}

export interface TaggedSpan {
  span: Span;
  serviceName: string;
  instanceId: string;
}

// One instance's share of a trace; a distributed trace has one part per participating instance.
export interface TracePart {
  instanceId: string;
  serviceName: string;
  trace: Trace;
}

export interface TraceLog {
  instanceId: string;
  log: StoredLogRecord;
}

export interface TraceLogs {
  items: TraceLog[];
  truncated: boolean;
}

type Listener = () => void;

export function attrsKey(attrs: KeyValueMap): string {
  return JSON.stringify(Object.keys(attrs).sort().map((k) => [k, attrs[k]]));
}

export class TelemetryStore {
  private instances = new Map<string, Instance>();
  private sessions = new Map<string, ImportedSession>();
  private listeners = new Set<Listener>();
  private fireTimer: NodeJS.Timeout | undefined;
  private maxLogs: number;
  private maxTraces: number;
  private maxMetricPoints: number;
  private maxMetricSeries: number;
  private importCounter = 0;

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
      if (inst.kind === 'imported') continue;
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
      if (inst.kind === 'imported') continue;
      const list = byApp.get(inst.serviceName) ?? [];
      list.push(inst);
      byApp.set(inst.serviceName, list);
    }
    return [...byApp.entries()]
      .map(([name, instances]) => ({
        name,
        instances: instances.sort((a, b) =>
          (a.serviceInstanceId ?? a.id).localeCompare(b.serviceInstanceId ?? b.id)
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getImportedInstances(): Instance[] {
    return [...this.instances.values()]
      .filter((i) => i.kind === 'imported')
      .sort((a, b) => b.firstSeen - a.firstSeen);
  }

  getSession(id: string): ImportedSession | undefined {
    return this.sessions.get(id);
  }

  /** Loaded files, newest first, each with its instances. */
  getImportedSessions(): ImportedSessionView[] {
    const out: ImportedSessionView[] = [];
    for (const session of this.sessions.values()) {
      const instances = this.realmInstances(session.id).sort(
        (a, b) => a.serviceName.localeCompare(b.serviceName) || a.id.localeCompare(b.id)
      );
      if (instances.length) out.push({ session, instances });
    }
    return out.sort((a, b) => b.session.loadedAt - a.session.loadedAt);
  }

  private realmInstances(realm: string): Instance[] {
    return [...this.instances.values()].filter((i) => i.realm === realm);
  }

  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  getAllInstances(): Instance[] {
    return [...this.instances.values()];
  }

  getLogs(instanceId: string): readonly StoredLogRecord[] {
    return this.instances.get(instanceId)?.logs.view() ?? [];
  }

  // Logs with seq > sinceSeq. `oldestSeq` lets callers drop rows evicted since their last read.
  getLogsSince(instanceId: string, sinceSeq: number): LogDelta {
    const inst = this.instances.get(instanceId);
    if (!inst) return { records: [], oldestSeq: 0, total: 0 };
    const all = inst.logs.view();
    const oldestSeq = all.length ? all[0].seq : inst.nextLogSeq;
    let start = all.length;
    while (start > 0 && all[start - 1].seq > sinceSeq) start--;
    return { records: all.slice(start), oldestSeq, total: all.length };
  }

  findLog(instanceId: string, seq: number): StoredLogRecord | undefined {
    const all = this.instances.get(instanceId)?.logs.view();
    if (!all || !all.length) return undefined;
    // seq is ascending across the buffer, so binary search is safe.
    let lo = 0;
    let hi = all.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const found = all[mid];
      if (found.seq === seq) return found;
      if (found.seq < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  removeInstance(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.instances.delete(id);
    if (inst.kind === 'imported' && !this.realmInstances(inst.realm).length) {
      this.sessions.delete(inst.realm);
    }
    this.scheduleFire();
  }

  removeSession(id: string): void {
    if (!this.sessions.delete(id)) return;
    for (const inst of this.realmInstances(id)) this.instances.delete(inst.id);
    this.scheduleFire();
  }

  clear(): void {
    let changed = false;
    for (const [id, inst] of this.instances) {
      if (inst.kind === 'imported') continue;
      this.instances.delete(id);
      changed = true;
    }
    if (changed) this.scheduleFire();
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
        kind: 'live',
        realm: LIVE_REALM,
        logs: new RingBuffer<StoredLogRecord>(this.maxLogs),
        nextLogSeq: 1,
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
      if (inst.kind === 'imported') continue;
      for (const log of b.logs) {
        inst.logs.push(this.withSeq(inst, log));
        inst.logCount++;
        changed = true;
      }
    }
    if (changed) this.scheduleFire();
  }

  // Records come straight from decode/import and are owned by the store, so stamping in place
  // avoids a copy per log on the ingest hot path.
  private withSeq(inst: Instance, log: LogRecord): StoredLogRecord {
    const stored = log as StoredLogRecord;
    stored.seq = inst.nextLogSeq++;
    return stored;
  }

  private newSession(source: string): ImportedSession {
    const now = Date.now();
    const hash = createHash('sha1')
      .update(source)
      .update(String(now))
      .update(String(this.importCounter++))
      .digest('hex')
      .slice(0, 8);
    const session: ImportedSession = { id: `imported::${source}::${hash}`, source, loadedAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  // Imported instances are read-only, retention-exempt and not removed by clear().
  private newImportedInstance(
    session: ImportedSession,
    id: string,
    serviceName: string,
    serviceInstanceId: string | undefined,
    resourceAttrs: KeyValueMap
  ): Instance {
    return {
      id,
      serviceName,
      serviceInstanceId,
      resourceAttrs,
      kind: 'imported',
      realm: session.id,
      source: session.source,
      logs: new RingBuffer<StoredLogRecord>(0),
      nextLogSeq: 1,
      traces: new Map(),
      metrics: new Map(),
      metricSeries: new Map(),
      firstSeen: session.loadedAt,
      lastSeen: session.loadedAt,
      logCount: 0,
      spanCount: 0,
    };
  }

  importLogs(opts: ImportLogsOptions): string {
    const session = this.newSession(opts.sourceLabel);
    const inst = this.newImportedInstance(session, session.id, opts.serviceName, undefined, opts.resourceAttrs);
    for (const log of opts.logs) {
      inst.logs.push(this.withSeq(inst, log));
      inst.logCount++;
    }
    this.instances.set(inst.id, inst);
    this.scheduleFire();
    return inst.id;
  }

  /** Loads traces, logs and metrics from one file into a new realm, one instance per resource. */
  importSession(opts: ImportSessionOptions): { sessionId: string; instanceIds: string[] } {
    const session = this.newSession(opts.sourceLabel);
    const byResource = new Map<string, Instance>();
    const instanceFor = (resource: ResourceInfo): Instance => {
      const key = this.instanceId(resource);
      let inst = byResource.get(key);
      if (!inst) {
        inst = this.newImportedInstance(
          session,
          `${session.id}::${key}`,
          resource.serviceName,
          resource.serviceInstanceId,
          resource.attrs
        );
        byResource.set(key, inst);
      }
      return inst;
    };

    for (const b of opts.traces) {
      const inst = instanceFor(b.resource);
      for (const span of b.spans) {
        if (!span.traceId || !span.spanId) continue;
        this.addSpan(inst, span);
        inst.spanCount++;
      }
    }
    for (const b of opts.logs) {
      const inst = instanceFor(b.resource);
      for (const log of b.logs) {
        inst.logs.push(this.withSeq(inst, log));
        inst.logCount++;
      }
    }

    // A file may repeat a metric across batches; merge, then replay points in time order.
    const metrics = new Map<Instance, Map<string, Metric>>();
    for (const b of opts.metrics) {
      const inst = instanceFor(b.resource);
      let byName = metrics.get(inst);
      if (!byName) metrics.set(inst, (byName = new Map()));
      for (const m of b.metrics) {
        const existing = byName.get(m.name);
        if (existing) existing.dataPoints.push(...m.dataPoints);
        else byName.set(m.name, { ...m, dataPoints: [...m.dataPoints] });
      }
    }
    for (const [inst, byName] of metrics) {
      for (const m of byName.values()) {
        m.dataPoints.sort((a, b) => a.timeMs - b.timeMs);
        this.recordSeries(inst, m);
        const latest = new Map<string, Metric['dataPoints'][number]>();
        for (const dp of m.dataPoints) latest.set(attrsKey(dp.attrs), dp);
        m.dataPoints = [...latest.values()];
        inst.metrics.set(m.name, m);
      }
    }

    if (!byResource.size) this.sessions.delete(session.id);
    for (const inst of byResource.values()) this.instances.set(inst.id, inst);
    this.scheduleFire();
    return { sessionId: session.id, instanceIds: [...byResource.values()].map((i) => i.id) };
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
    if (!span.parentSpanId) {
      const current = trace.rootSpanId ? trace.spans.get(trace.rootSpanId) : undefined;
      if (!current || span.startMs < current.startMs) {
        trace.rootSpanId = span.spanId;
      }
    }
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
          existing.monotonic = metric.monotonic;
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
      const imported = inst.kind === 'imported';
      if (!imported && inst.metricSeries.size >= this.maxMetricSeries) {
        const oldest = inst.metricSeries.keys().next().value as string | undefined;
        if (oldest !== undefined) inst.metricSeries.delete(oldest);
      }
      series = {
        metricName,
        attrs,
        field,
        points: new RingBuffer<MetricSeriesPoint>(imported ? 0 : this.maxMetricPoints),
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
  getSpansForTrace(traceId: string, realm?: string): TaggedSpan[] {
    const out: TaggedSpan[] = [];
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      const trace = inst.traces.get(traceId);
      if (!trace) continue;
      for (const span of trace.spans.values()) {
        out.push({ span, serviceName: inst.serviceName, instanceId: inst.id });
      }
    }
    return out;
  }

  /** All spans across all instances, tagged with service name (for the service map). */
  getAllTaggedSpans(realm?: string): TaggedSpan[] {
    const out: TaggedSpan[] = [];
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      for (const trace of inst.traces.values()) {
        for (const span of trace.spans.values()) {
          out.push({ span, serviceName: inst.serviceName, instanceId: inst.id });
        }
      }
    }
    return out;
  }

  findTraceInstances(traceId: string, realm?: string): string[] {
    const out: string[] = [];
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      if (inst.traces.has(traceId)) out.push(inst.id);
    }
    return out;
  }

  getTraceParts(traceId: string, realm?: string): TracePart[] {
    const out: TracePart[] = [];
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      const trace = inst.traces.get(traceId);
      if (trace) out.push({ instanceId: inst.id, serviceName: inst.serviceName, trace });
    }
    return out;
  }

  /** Logs correlated with a trace (optionally one span) across all instances, oldest first. */
  getLogsForTrace(
    traceId: string,
    opts: { spanId?: string; limit?: number; realm?: string } = {}
  ): TraceLogs {
    const items: TraceLog[] = [];
    for (const inst of this.instances.values()) {
      if (opts.realm !== undefined && inst.realm !== opts.realm) continue;
      for (const log of inst.logs.view()) {
        if (log.traceId !== traceId) continue;
        if (opts.spanId !== undefined && log.spanId !== opts.spanId) continue;
        items.push({ instanceId: inst.id, log });
      }
    }
    items.sort((a, b) => a.log.timeMs - b.log.timeMs || a.log.seq - b.log.seq);
    const limit = opts.limit ?? Infinity;
    if (items.length <= limit) return { items, truncated: false };
    return { items: items.slice(items.length - Math.max(0, limit)), truncated: true };
  }

  countLogsByInstance(traceId: string, spanId?: string, realm?: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      let n = 0;
      for (const log of inst.logs.view()) {
        if (log.traceId === traceId && (spanId === undefined || log.spanId === spanId)) n++;
      }
      if (n) out.set(inst.id, n);
    }
    return out;
  }

  countLogsByTrace(realm?: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const inst of this.instances.values()) {
      if (realm !== undefined && inst.realm !== realm) continue;
      for (const log of inst.logs.view()) {
        if (log.traceId) out.set(log.traceId, (out.get(log.traceId) ?? 0) + 1);
      }
    }
    return out;
  }
}
