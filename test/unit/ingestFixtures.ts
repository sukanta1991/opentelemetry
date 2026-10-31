// SPDX-License-Identifier: Apache-2.0
// Deterministic OTLP-shaped batches for ingest benchmarks: realistic attribute mixes including
// IDs, full URLs, SQL text and metric labels that explode series. Not a *.test.ts file.

import { LogRecord, Metric, MetricDataPoint, ResourceLogs, ResourceMetrics, ResourceSpans, Span } from '../../src/store/model';
import { T0 } from './aiFixtures';

export const INGEST_SERVICES = 10;
export const SPANS_PER_TRACE = 10;
export const TRACES_PER_SERVICE = 2000;
export const LOGS_PER_SERVICE = 5000;
export const METRIC_CYCLES = 20;
export const POINTS_PER_CYCLE = 100;
// Typical SDK batch exporter size.
const BATCH = 500;

const ROUTES = ['/users/{id}', '/orders/{id}', '/cart', '/checkout', '/search'];
const METHODS = ['GET', 'POST'];
const STATUSES = [200, 404, 500];
const TENANTS = ['acme', 'globex', 'initech', 'umbrella', 'hooli'];
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000];

// Park-Miller LCG: fixed sequence, so every run sees identical data.
function rng(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647);
}

function hex(next: () => number, len: number): string {
  let out = '';
  while (out.length < len) out += next().toString(16).padStart(8, '0');
  return out.slice(0, len);
}

function uuid(next: () => number): string {
  const h = hex(next, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const resource = (s: number) => ({ serviceName: `svc${s}`, serviceInstanceId: 'i', attrs: {} });

function chunk<T, R>(items: T[], wrap: (part: T[]) => R): R[] {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(wrap(items.slice(i, i + BATCH)));
  return out;
}

function serverSpan(next: () => number, t: number, base: Omit<Span, 'name' | 'kind' | 'attrs'>): Span {
  const route = ROUTES[t % ROUTES.length];
  const id = 1000 + (next() % 100000);
  const path = route.replace('{id}', String(id));
  const method = METHODS[t % METHODS.length];
  return {
    ...base,
    // 5% of server spans embed the id in the name, as un-templated instrumentation does.
    name: t % 20 === 0 ? `${method} ${path}` : `${method} ${route}`,
    kind: 'SERVER',
    attrs: {
      'http.request.method': method,
      'http.route': route,
      'url.full': `https://api.example.com${path}?session=${hex(next, 16)}`,
      'http.response.status_code': STATUSES[t % STATUSES.length],
      'server.address': 'api.example.com',
      'user_agent.original': `Mozilla/5.0 (build ${t % 7})`,
      'user.id': uuid(next),
      'client.address': `10.${next() % 256}.${next() % 256}.${next() % 256}`,
      'request.id': hex(next, 16),
      tenant: TENANTS[t % TENANTS.length],
    },
  };
}

function dbSpan(next: () => number, t: number, s: number, base: Omit<Span, 'name' | 'kind' | 'attrs'>): Span {
  return {
    ...base,
    name: 'SELECT orders',
    kind: 'CLIENT',
    attrs: {
      'db.system.name': 'postgresql',
      'db.query.text': `SELECT * FROM orders WHERE id = ${next() % 1000000} AND tenant = '${TENANTS[t % TENANTS.length]}'`,
      'db.collection.name': 'orders',
      'db.operation.name': 'SELECT',
      'db.namespace': `db${s}`,
      'server.address': 'db.internal',
      'server.port': 5432,
      'thread.id': next() % 64,
      tenant: TENANTS[t % TENANTS.length],
      'request.id': hex(next, 16),
    },
  };
}

function internalSpan(next: () => number, t: number, k: number, base: Omit<Span, 'name' | 'kind' | 'attrs'>): Span {
  return {
    ...base,
    name: `op${k}`,
    kind: 'INTERNAL',
    attrs: {
      'code.function.name': `handler${k}`,
      'thread.id': next() % 64,
      tenant: TENANTS[t % TENANTS.length],
      'request.id': hex(next, 16),
      'feature.flag': t % 3 === 0,
      'retry.count': t % 4,
      'payload.size': next() % 65536,
      'cache.hit': t % 2 === 0,
      component: `component${k}`,
      'app.step': k,
    },
  };
}

/** 10 services x 2000 traces x 10 spans = 200k spans, 10 attributes each, in 500-span batches. */
export function buildSpanBatches(): ResourceSpans[] {
  const next = rng(1);
  const out: ResourceSpans[] = [];
  for (let s = 0; s < INGEST_SERVICES; s++) {
    const spans: Span[] = [];
    for (let t = 0; t < TRACES_PER_SERVICE; t++) {
      const traceId = hex(next, 32);
      const start = T0 + t * 50 + s;
      const failed = t % 50 === 0;
      for (let k = 0; k < SPANS_PER_TRACE; k++) {
        const durationMs = 5 + (t % 13);
        const base = {
          traceId,
          spanId: hex(next, 16),
          parentSpanId: k ? spans[spans.length - k].spanId : undefined,
          startMs: start + k,
          endMs: start + k + durationMs,
          durationMs,
          statusCode: failed && k === 3 ? ('ERROR' as const) : ('UNSET' as const),
          events: [] as Span['events'],
          links: [] as Span['links'],
          scope: '@app/instrumentation',
        };
        const sp = k === 0 ? serverSpan(next, t, base) : k === 3 ? dbSpan(next, t, s, base) : internalSpan(next, t, k, base);
        if (sp.statusCode === 'ERROR') {
          sp.events.push({
            timeMs: sp.endMs,
            name: 'exception',
            attrs: {
              'exception.type': 'QueryTimeoutError',
              'exception.message': `Query ${hex(next, 8)} timed out after ${durationMs} ms`,
              'exception.stacktrace': `QueryTimeoutError\n    at run (/srv/svc${s}/repo.ts:${10 + (t % 5)}:7)`,
            },
          });
        }
        spans.push(sp);
      }
    }
    out.push(...chunk(spans, (part) => ({ resource: resource(s), spans: part })));
  }
  return out;
}

/** 10 services x 5000 logs in 500-log batches; varied templates, 10% structured bodies. */
export function buildLogBatches(): ResourceLogs[] {
  const next = rng(2);
  const out: ResourceLogs[] = [];
  for (let s = 0; s < INGEST_SERVICES; s++) {
    const logs: LogRecord[] = [];
    for (let i = 0; i < LOGS_PER_SERVICE; i++) {
      const n = next();
      const body: LogRecord['body'] =
        i % 10 === 0
          ? { event: 'order.created', orderId: uuid(next), amount: n % 1000, items: [n % 7, n % 11] }
          : [
              `User ${n % 100000} logged in from 10.0.${n % 256}.${(n >> 8) % 256}`,
              `Order ${uuid(next)} processed in ${n % 500} ms`,
              `Cache miss for key product:${n % 5000}`,
              `GET /users/${n % 100000} returned 200 in ${n % 300} ms`,
              `Retrying request ${hex(next, 16)} (attempt ${n % 4})`,
              `Payment declined for card ending ${String(n % 10000).padStart(4, '0')}`,
              `Connection pool exhausted: ${n % 50} waiting, max 20`,
              `Scheduled job reindex finished`,
            ][i % 8];
      const traced = i % 2 === 0;
      logs.push({
        timeMs: T0 + i * 10 + s,
        observedTimeMs: T0 + i * 10 + s + 1,
        severityNumber: i % 20 === 0 ? 17 : 9,
        severityText: i % 20 === 0 ? 'ERROR' : 'INFO',
        body,
        attrs: {
          'code.function.name': `handler${i % 12}`,
          'user.id': uuid(next),
          'request.id': hex(next, 16),
          'http.route': ROUTES[i % ROUTES.length],
        },
        traceId: traced ? hex(next, 32) : undefined,
        spanId: traced ? hex(next, 16) : undefined,
        scope: '@app/logger',
      });
    }
    out.push(...chunk(logs, (part) => ({ resource: resource(s), logs: part })));
  }
  return out;
}

/**
 * 10 services x 20 export cycles x 100 points = 20k points. Each cycle: a 30-series duration histogram,
 * a 10-series memory gauge and a counter labelled with fresh user ids (60 new series per cycle).
 */
export function buildMetricBatches(): ResourceMetrics[] {
  const next = rng(3);
  const out: ResourceMetrics[] = [];
  for (let s = 0; s < INGEST_SERVICES; s++) {
    for (let c = 0; c < METRIC_CYCLES; c++) {
      const timeMs = T0 + c * 10_000;
      const hist: MetricDataPoint[] = [];
      for (const route of ROUTES) {
        for (const method of METHODS) {
          for (const status of STATUSES) {
            const counts = BOUNDS.map(() => next() % 50).concat(next() % 5);
            const count = counts.reduce((a, b) => a + b, 0);
            hist.push({
              attrs: { 'http.route': route, 'http.request.method': method, 'http.response.status_code': status },
              timeMs,
              count,
              sum: count * 42,
              bucketBounds: BOUNDS,
              bucketCounts: counts,
            });
          }
        }
      }
      const gauge: MetricDataPoint[] = Array.from({ length: 10 }, (_, p) => ({
        attrs: { 'jvm.memory.pool.name': `pool${p}` },
        timeMs,
        value: next() % 1_000_000,
      }));
      const counter: MetricDataPoint[] = Array.from({ length: POINTS_PER_CYCLE - hist.length - gauge.length }, () => ({
        attrs: { 'user.id': uuid(next), tenant: TENANTS[next() % TENANTS.length] },
        timeMs,
        value: next() % 100,
      }));
      const metrics: Metric[] = [
        { name: 'http.server.request.duration', unit: 'ms', type: 'histogram', dataPoints: hist },
        { name: 'jvm.memory.used', unit: 'By', type: 'gauge', dataPoints: gauge },
        { name: 'orders.processed', unit: '1', type: 'sum', monotonic: true, dataPoints: counter },
      ];
      out.push({ resource: resource(s), metrics });
    }
  }
  return out;
}

// The store keeps the first Metric object per name and overwrites its fields on later exports,
// so each timed run needs fresh Metric shells (points are shared, they are never mutated).
export function freshMetricBatches(batches: ResourceMetrics[]): ResourceMetrics[] {
  return batches.map((b) => ({ resource: b.resource, metrics: b.metrics.map((m) => ({ ...m })) }));
}
