// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { decodeLogs, decodeMetrics, decodeTraces } from '../../src/store/decode';
import { msToNano } from '../../src/store/encode';
import { Metric } from '../../src/store/model';
import { Instance, LIVE_REALM, TelemetryStore, attrsKey } from '../../src/store/store';
import { pickTraceInstance } from '../../src/views/navigationTargets';
import { buildSession, defaultSessionFileName } from '../../src/views/sessionExport';
import { parseSessionFile } from '../../src/views/sessionImport';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER_TRACE = '0af7651916cd43dd8448eb211c80319c';
const T1 = '1767268800000000000';
const T2 = '1767268810000000000';

const str = (v: string) => ({ stringValue: v });
const kv = (key: string, value: unknown) => ({ key, value });

const frontend = {
  attributes: [kv('service.name', str('frontend')), kv('service.instance.id', str('f1')), kv('host.name', str('h1'))],
};
// No service.instance.id: the instance is keyed by a hash of its attributes.
const checkout = { attributes: [kv('service.name', str('checkout')), kv('deployment.environment', str('dev'))] };

const allTypes = [
  kv('s', str('x')),
  kv('i', { intValue: '42' }),
  kv('d', { doubleValue: 1.5 }),
  kv('b', { boolValue: true }),
  kv('arr', { arrayValue: { values: [str('a'), { intValue: '1' }] } }),
  kv('map', { kvlistValue: { values: [kv('nested', str('y'))] } }),
];

const traces = {
  resourceSpans: [
    {
      resource: frontend,
      scopeSpans: [
        {
          scope: { name: 'http' },
          spans: [
            {
              traceId: TRACE,
              spanId: 'a000000000000001',
              name: 'GET /checkout',
              kind: 2,
              startTimeUnixNano: '1767268800000123456',
              endTimeUnixNano: '1767268800250987654',
              attributes: [...allTypes, kv('code.filepath', str('src/app.ts')), kv('code.lineno', { intValue: '12' })],
              events: [{ timeUnixNano: '1767268800100500000', name: 'retry', attributes: [kv('attempt', { intValue: '2' })] }],
              links: [{ traceId: OTHER_TRACE, spanId: 'c000000000000001', traceState: 'k=v', attributes: [] }],
              status: { code: 2, message: 'boom' },
            },
            {
              traceId: TRACE,
              spanId: 'a000000000000002',
              parentSpanId: 'a000000000000001',
              name: 'POST checkout',
              kind: 3,
              startTimeUnixNano: '1767268800010000001',
              endTimeUnixNano: '1767268800010450000',
              status: { code: 1 },
            },
          ],
        },
      ],
    },
    {
      resource: checkout,
      scopeSpans: [
        {
          spans: [
            {
              traceId: TRACE,
              spanId: 'b000000000000001',
              parentSpanId: 'a000000000000002',
              name: 'POST /pay',
              kind: 2,
              startTimeUnixNano: '1767268800020000000',
              endTimeUnixNano: '1767268800200000000',
            },
            {
              traceId: OTHER_TRACE,
              spanId: 'c000000000000001',
              name: 'cron',
              kind: 1,
              startTimeUnixNano: '1767268700000000000',
              endTimeUnixNano: '1767268700000000500',
            },
          ],
        },
      ],
    },
  ],
};

const logs = {
  resourceLogs: [
    {
      resource: frontend,
      scopeLogs: [
        {
          scope: { name: 'app' },
          logRecords: [
            {
              timeUnixNano: '1767268800050000000',
              observedTimeUnixNano: '1767268800050000100',
              severityNumber: 17,
              severityText: 'ERROR',
              body: str('payment failed'),
              attributes: allTypes,
              traceId: TRACE,
              spanId: 'a000000000000001',
            },
            {
              timeUnixNano: '1767268801000000000',
              severityNumber: 9,
              severityText: 'INFO',
              body: { kvlistValue: { values: [kv('event', str('startup'))] } },
            },
          ],
        },
      ],
    },
    {
      resource: checkout,
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1767268800150000000',
              severityNumber: 13,
              body: str('slow db'),
              traceId: TRACE,
              spanId: 'b000000000000001',
            },
          ],
        },
      ],
    },
  ],
};

function metrics(time: string, scale: number) {
  const route = (r: string) => [kv('route', str(r))];
  return {
    resourceMetrics: [
      {
        resource: frontend,
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'cpu',
                unit: '1',
                gauge: {
                  dataPoints: [
                    { attributes: route('a'), timeUnixNano: time, asDouble: 0.25 * scale },
                    { attributes: route('b'), timeUnixNano: time, asInt: String(5 * scale) },
                  ],
                },
              },
              {
                name: 'requests',
                description: 'Requests served',
                sum: { isMonotonic: true, dataPoints: [{ attributes: [], timeUnixNano: time, asInt: String(10 * scale) }] },
              },
              {
                name: 'latency',
                unit: 'ms',
                histogram: {
                  dataPoints: [
                    {
                      attributes: route('a'),
                      timeUnixNano: time,
                      count: String(4 * scale),
                      sum: 12.5 * scale,
                      explicitBounds: [1, 5, 10],
                      bucketCounts: ['1', '1', String(scale), '1'],
                    },
                  ],
                },
              },
              {
                name: 'rpc',
                summary: {
                  dataPoints: [
                    {
                      attributes: [],
                      timeUnixNano: time,
                      count: String(3 * scale),
                      sum: 9 * scale,
                      quantileValues: [
                        { quantile: 0.5, value: 2 * scale },
                        { quantile: 0.99, value: 7 * scale },
                      ],
                    },
                  ],
                },
              },
              { name: 'expo', exponentialHistogram: { dataPoints: [{ attributes: [], timeUnixNano: time }] } },
            ],
          },
        ],
      },
    ],
  };
}

function liveStore(): TelemetryStore {
  const store = new TelemetryStore();
  store.ingestSpans(decodeTraces(traces));
  store.ingestLogs(decodeLogs(logs));
  store.ingestMetrics(decodeMetrics(metrics(T1, 1)));
  store.ingestMetrics(decodeMetrics(metrics(T2, 2)));
  return store;
}

function sortedPoints(m: Metric): Metric {
  return { ...m, dataPoints: [...m.dataPoints].sort((a, b) => attrsKey(a.attrs).localeCompare(attrsKey(b.attrs))) };
}

// Everything a panel reads from an instance, minus ids and wall-clock bookkeeping.
function snapshot(inst: Instance) {
  return {
    serviceName: inst.serviceName,
    serviceInstanceId: inst.serviceInstanceId,
    resourceAttrs: inst.resourceAttrs,
    logCount: inst.logCount,
    spanCount: inst.spanCount,
    logs: inst.logs.toArray(),
    traces: [...inst.traces.values()]
      .map((t) => ({
        traceId: t.traceId,
        startMs: t.startMs,
        endMs: t.endMs,
        durationMs: t.durationMs,
        hasError: t.hasError,
        rootSpanId: t.rootSpanId,
        serviceNames: [...t.serviceNames],
        spans: [...t.spans.values()],
      }))
      .sort((a, b) => a.traceId.localeCompare(b.traceId)),
    metrics: [...inst.metrics.values()].map(sortedPoints).sort((a, b) => a.name.localeCompare(b.name)),
    series: [...inst.metricSeries.values()]
      .map((s) => ({ metricName: s.metricName, attrs: s.attrs, field: s.field, points: s.points.toArray() }))
      .sort((a, b) =>
        `${a.metricName}|${a.field}|${attrsKey(a.attrs)}`.localeCompare(`${b.metricName}|${b.field}|${attrsKey(b.attrs)}`)
      ),
  };
}

function load(text: string, store = new TelemetryStore()) {
  const parsed = parseSessionFile(text, 1_000_000);
  const loaded = store.importSession({ sourceLabel: 's.otel.json', ...parsed });
  return { store, parsed, ...loaded };
}

function byService(store: TelemetryStore, ids: string[]): Map<string, Instance> {
  return new Map(ids.map((id) => [store.getInstance(id)!.serviceName, store.getInstance(id)!]));
}

describe('session save/load', () => {
  it('round-trips every instance of an all-data session', () => {
    const live = liveStore();
    const built = buildSession(live, { kind: 'all' });
    const { store, instanceIds } = load(built.text);

    assert.strictEqual(instanceIds.length, 2);
    const loaded = byService(store, instanceIds);
    for (const inst of live.getAllInstances()) {
      const copy = loaded.get(inst.serviceName);
      assert.ok(copy, `${inst.serviceName} loaded`);
      assert.strictEqual(copy.kind, 'imported');
      assert.deepStrictEqual(snapshot(copy), snapshot(inst));
    }
    assert.deepStrictEqual(built.counts, { spans: 4, logs: 3, metricPoints: 11 });
  });

  it('keeps sub-millisecond span timings', () => {
    const live = liveStore();
    const { store, instanceIds } = load(buildSession(live, { kind: 'all' }).text);
    const span = byService(store, instanceIds).get('frontend')!.traces.get(TRACE)!.spans.get('a000000000000002')!;
    assert.ok(Math.abs(span.durationMs - 0.449999) < 1e-3, `duration ${span.durationMs}`);
  });

  it('saves one instance only', () => {
    const live = liveStore();
    const built = buildSession(live, { kind: 'instance', instanceId: 'frontend::f1' });
    const doc = JSON.parse(built.text);
    assert.strictEqual(doc.format, 'otel-session');
    assert.deepStrictEqual(doc.scope, { kind: 'instance', service: 'frontend' });
    const { store, instanceIds } = load(built.text);
    assert.strictEqual(instanceIds.length, 1);
    assert.deepStrictEqual(snapshot(store.getInstance(instanceIds[0])!), snapshot(live.getInstance('frontend::f1')!));
  });

  it('saves one trace across services with its correlated logs and no metrics', () => {
    const live = liveStore();
    const built = buildSession(live, { kind: 'trace', traceId: TRACE, realm: LIVE_REALM });
    assert.deepStrictEqual(built.counts, { spans: 3, logs: 2, metricPoints: 0 });
    const { store, instanceIds } = load(built.text);
    const loaded = byService(store, instanceIds);
    assert.deepStrictEqual([...loaded.keys()].sort(), ['checkout', 'frontend']);
    for (const inst of loaded.values()) {
      assert.deepStrictEqual([...inst.traces.keys()], [TRACE]);
      assert.strictEqual(inst.metrics.size, 0);
      assert.ok(inst.logs.view().every((l) => l.traceId === TRACE));
    }
    assert.strictEqual(store.getSpansForTrace(TRACE).length, 3);
  });

  it('re-saves a loaded session file', () => {
    const live = liveStore();
    const first = load(buildSession(live, { kind: 'all' }).text);
    const again = load(buildSession(first.store, { kind: 'session', sessionId: first.sessionId }).text);
    const a = byService(first.store, first.instanceIds);
    const b = byService(again.store, again.instanceIds);
    for (const [name, inst] of a) assert.deepStrictEqual(snapshot(b.get(name)!), snapshot(inst));
  });

  it('isolates a loaded session from live data holding the same trace', () => {
    const store = liveStore();
    const { sessionId } = load(buildSession(store, { kind: 'all' }).text, store);

    assert.strictEqual(store.getSpansForTrace(TRACE, LIVE_REALM).length, 3);
    assert.strictEqual(store.getSpansForTrace(TRACE, sessionId).length, 3);
    assert.strictEqual(store.getLogsForTrace(TRACE, { realm: sessionId }).items.length, 2);
    assert.strictEqual(store.getAllTaggedSpans(LIVE_REALM).length, 4);
    assert.ok(store.findTraceInstances(TRACE, sessionId).every((id) => store.getInstance(id)!.realm === sessionId));
    assert.strictEqual(pickTraceInstance(store, TRACE), 'frontend::f1', 'live wins without a caller');
    const importedFrontend = store.getImportedSessions()[0].instances.find((i) => i.serviceName === 'frontend')!;
    assert.strictEqual(pickTraceInstance(store, TRACE, importedFrontend.id), importedFrontend.id);
  });

  it('keeps sessions on clear and removes them as a unit', () => {
    const store = liveStore();
    const { sessionId, instanceIds } = load(buildSession(store, { kind: 'all' }).text, store);
    store.clear();
    assert.strictEqual(store.getApplications().length, 0);
    assert.deepStrictEqual(store.getImportedSessions().map((s) => s.session.id), [sessionId]);
    assert.strictEqual(store.getImportedSessions()[0].instances.length, instanceIds.length);

    store.removeSession(sessionId);
    assert.strictEqual(store.getAllInstances().length, 0);
    assert.strictEqual(store.getSession(sessionId), undefined);
  });

  it('drops the session when its last instance is removed', () => {
    const store = liveStore();
    const { sessionId, instanceIds } = load(buildSession(store, { kind: 'all' }).text, store);
    store.removeInstance(instanceIds[0]);
    assert.ok(store.getSession(sessionId));
    store.removeInstance(instanceIds[1]);
    assert.strictEqual(store.getSession(sessionId), undefined);
  });

  it('keeps every metric point of a loaded session regardless of retention', () => {
    const store = new TelemetryStore(10, 10, 2, 1);
    const points = Array.from({ length: 5 }, (_, i) => ({ attrs: { n: i % 3 }, timeMs: i + 1, value: i }));
    const resource = { serviceName: 'svc', attrs: {} };
    const { instanceIds } = store.importSession({
      sourceLabel: 'm.json',
      traces: [],
      logs: [],
      metrics: [{ resource, metrics: [{ name: 'g', type: 'gauge', dataPoints: points }] }],
    });
    const inst = store.getInstance(instanceIds[0])!;
    assert.strictEqual(inst.metricSeries.size, 3);
    assert.strictEqual([...inst.metricSeries.values()].reduce((n, s) => n + s.points.length, 0), 5);
    assert.deepStrictEqual(
      inst.metrics.get('g')!.dataPoints.map((p) => p.timeMs).sort(),
      [3, 4, 5],
      'snapshot is the newest point per attribute set'
    );
  });

  it('reports nothing to save for an empty store', () => {
    assert.deepStrictEqual(buildSession(new TelemetryStore(), { kind: 'all' }).counts, {
      spans: 0,
      logs: 0,
      metricPoints: 0,
    });
  });

  it('builds a file-safe default name', () => {
    const name = defaultSessionFileName('my svc/../x', new Date(2026, 8, 29, 7, 5, 3));
    assert.strictEqual(name, 'my_svc_.._x-20260929-070503.otel.json');
  });
});

describe('msToNano', () => {
  it('encodes whole and missing times', () => {
    assert.strictEqual(msToNano(0), '0');
    assert.strictEqual(msToNano(undefined), '0');
    assert.strictEqual(msToNano(1700000000123), '1700000000123000000');
  });

  it('decodes back to the same millisecond value', () => {
    const [rs] = decodeTraces(traces);
    for (const s of rs.spans) {
      const again = decodeTraces({
        resourceSpans: [
          { scopeSpans: [{ spans: [{ traceId: TRACE, spanId: s.spanId, startTimeUnixNano: msToNano(s.startMs) }] }] },
        ],
      });
      assert.strictEqual(again[0].spans[0].startMs, s.startMs);
    }
  });
});
