// SPDX-License-Identifier: Apache-2.0
// Builds OTLP/JSON session files from the store. No vscode import so it stays unit-testable.

import { byScope, encodeLog, encodeMetric, encodeResource, encodeSpan } from '../store/encode';
import { LogRecord, Metric, MetricDataPoint, Span } from '../store/model';
import { Instance, TelemetryStore, attrsKey } from '../store/store';

export const SESSION_FORMAT = 'otel-session';
export const SESSION_VERSION = 1;
export const SESSION_EXTENSION = '.otel.json';

export type SessionScope =
  | { kind: 'all' }
  | { kind: 'instance'; instanceId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'trace'; traceId: string; realm?: string };

export interface SessionCounts {
  spans: number;
  logs: number;
  metricPoints: number;
}

export interface BuiltSession {
  text: string;
  counts: SessionCounts;
}

interface Slice {
  inst: Instance;
  spans: Span[];
  logs: readonly LogRecord[];
  metrics: boolean;
}

function wholeInstance(inst: Instance): Slice {
  const spans: Span[] = [];
  for (const trace of inst.traces.values()) spans.push(...trace.spans.values());
  return { inst, spans, logs: inst.logs.view(), metrics: true };
}

function traceSlices(store: TelemetryStore, traceId: string, realm: string | undefined): Slice[] {
  const byInstance = new Map<string, { inst: Instance; spans: Span[]; logs: LogRecord[] }>();
  const sliceFor = (id: string) => {
    let slice = byInstance.get(id);
    if (!slice) {
      const inst = store.getInstance(id);
      if (!inst) return undefined;
      byInstance.set(id, (slice = { inst, spans: [], logs: [] }));
    }
    return slice;
  };
  for (const t of store.getSpansForTrace(traceId, realm)) sliceFor(t.instanceId)?.spans.push(t.span);
  for (const l of store.getLogsForTrace(traceId, { realm }).items) sliceFor(l.instanceId)?.logs.push(l.log);
  return [...byInstance.values()].map((s) => ({ ...s, metrics: false }));
}

function slicesFor(store: TelemetryStore, scope: SessionScope): Slice[] {
  switch (scope.kind) {
    case 'all':
      return store.getAllInstances().map(wholeInstance);
    case 'instance': {
      const inst = store.getInstance(scope.instanceId);
      return inst ? [wholeInstance(inst)] : [];
    }
    case 'session': {
      const view = store.getImportedSessions().find((s) => s.session.id === scope.sessionId);
      return view ? view.instances.map(wholeInstance) : [];
    }
    case 'trace':
      return traceSlices(store, scope.traceId, scope.realm);
  }
}

// Only the newest snapshot keeps full detail (e.g. buckets); older points are rebuilt from the
// per-series history the charts use.
export function metricPoints(inst: Instance, m: Metric): MetricDataPoint[] {
  const byKey = new Map<string, MetricDataPoint>();
  for (const series of inst.metricSeries.values()) {
    if (series.metricName !== m.name) continue;
    const ak = attrsKey(series.attrs);
    for (const p of series.points.view()) {
      const key = `${p.timeMs}\u0000${ak}`;
      let dp = byKey.get(key);
      if (!dp) byKey.set(key, (dp = { attrs: series.attrs, timeMs: p.timeMs }));
      if (series.field === 'value') dp.value = p.value;
      else if (series.field === 'count') dp.count = p.value;
      else if (series.field === 'sum') dp.sum = p.value;
      else if (series.field.startsWith('q')) {
        (dp.quantiles ??= []).push({ quantile: Number(series.field.slice(1)), value: p.value });
      }
    }
  }
  for (const dp of m.dataPoints) byKey.set(`${dp.timeMs}\u0000${attrsKey(dp.attrs)}`, dp);
  return [...byKey.values()].sort((a, b) => a.timeMs - b.timeMs);
}

function scopeDescription(store: TelemetryStore, scope: SessionScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'instance':
      return { kind: 'instance', service: store.getInstance(scope.instanceId)?.serviceName };
    case 'session':
      return { kind: 'session', source: store.getSession(scope.sessionId)?.source };
    case 'trace':
      return { kind: 'trace', traceId: scope.traceId };
    default:
      return { kind: 'all' };
  }
}

export function buildSession(store: TelemetryStore, scope: SessionScope, savedAt = new Date()): BuiltSession {
  const counts: SessionCounts = { spans: 0, logs: 0, metricPoints: 0 };
  const resourceSpans: unknown[] = [];
  const resourceLogs: unknown[] = [];
  const resourceMetrics: unknown[] = [];

  for (const { inst, spans, logs, metrics } of slicesFor(store, scope)) {
    const resource = encodeResource(inst.serviceName, inst.serviceInstanceId, inst.resourceAttrs);
    if (spans.length) {
      counts.spans += spans.length;
      resourceSpans.push({
        resource,
        scopeSpans: byScope(spans).map((g) => ({ scope: g.scope, spans: g.items.map(encodeSpan) })),
      });
    }
    if (logs.length) {
      counts.logs += logs.length;
      resourceLogs.push({
        resource,
        scopeLogs: byScope(logs).map((g) => ({ scope: g.scope, logRecords: g.items.map(encodeLog) })),
      });
    }
    if (metrics && inst.metrics.size) {
      const encoded = [...inst.metrics.values()].map((m) => {
        const points = metricPoints(inst, m);
        counts.metricPoints += points.length;
        return encodeMetric(m, points);
      });
      resourceMetrics.push({ resource, scopeMetrics: [{ scope: {}, metrics: encoded }] });
    }
  }

  const doc = {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: savedAt.toISOString(),
    scope: scopeDescription(store, scope),
    traces: { resourceSpans },
    logs: { resourceLogs },
    metrics: { resourceMetrics },
  };
  return { text: JSON.stringify(doc), counts };
}

function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'session';
}

export function defaultSessionFileName(label: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${fileSafe(label)}-${stamp}${SESSION_EXTENSION}`;
}
