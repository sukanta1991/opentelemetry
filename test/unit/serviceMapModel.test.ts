// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { buildNodeDetails, buildServiceMap, ModelNode, ServiceMapModel } from '../../src/views/serviceMapModel';
import { DB_SPAN, DIST_TRACE, T0, addDistributedTrace, addSpans, span } from './aiFixtures';

const MIN = 60_000;
const tid = (i: number) => (i + 1).toString(16).padStart(32, '0');
const sid = (i: number) => (i + 1).toString(16).padStart(16, '0');

const node = (m: ServiceMapModel, id: string): ModelNode => {
  const n = m.nodes.find((x) => x.id === id);
  assert.ok(n, `missing node ${id}`);
  return n;
};
const edge = (m: ServiceMapModel, source: string, target: string) => {
  const e = m.edges.find((x) => x.source === source && x.target === target);
  assert.ok(e, `missing edge ${source} -> ${target}`);
  return e;
};

// One root SERVER span per entry, ending at `endMs`.
function roots(service: string, entries: { endMs: number; durationMs?: number; error?: boolean }[], offset = 0): Span[] {
  return entries.map((e, i) => {
    const durationMs = e.durationMs ?? 10;
    return span({
      traceId: tid(offset + i),
      spanId: sid(offset + i),
      kind: 'SERVER',
      name: 'GET /',
      startMs: e.endMs - durationMs,
      durationMs,
      statusCode: e.error ? 'ERROR' : 'UNSET',
    });
  });
}

describe('serviceMapModel', () => {
  describe('buildServiceMap', () => {
    it('returns an empty model for no spans', () => {
      assert.deepStrictEqual(buildServiceMap([], { range: '5m' }), {
        range: '5m',
        anchorMs: 0,
        fromMs: 0,
        effectiveWindowMs: 0,
        partial: false,
        hiddenNodes: 0,
        nodes: [],
        edges: [],
      });
    });

    it('computes entry-span node stats and caller-observed edge latency', () => {
      const store = new TelemetryStore();
      addDistributedTrace(store);
      const m = buildServiceMap(store.getAllTaggedSpans(), { range: 'all' });
      assert.deepStrictEqual(
        m.nodes.map((n) => n.id),
        ['svc:checkout', 'svc:frontend', 'db:postgresql:shop']
      );
      assert.strictEqual(node(m, 'svc:frontend').stats.p50, 1000);
      assert.strictEqual(node(m, 'svc:checkout').stats.p50, 930);
      assert.strictEqual(node(m, 'db:postgresql:shop').stats.p95, 800);
      // frontend's CLIENT span (950 ms) measures the edge, not checkout's SERVER span (930 ms).
      assert.strictEqual(edge(m, 'svc:frontend', 'svc:checkout').stats.p95, 950);
      assert.strictEqual(edge(m, 'svc:checkout', 'db:postgresql:shop').stats.p95, 800);
      assert.strictEqual(m.edges.length, 2);
      assert.strictEqual(m.anchorMs, T0 + 1000);
      assert.strictEqual(m.fromMs, T0);
      assert.strictEqual(m.partial, false);
      assert.strictEqual(edge(m, 'svc:frontend', 'svc:checkout').stats.ratePerMin, undefined);
    });

    it('treats a root INTERNAL span as a service entry', () => {
      const store = new TelemetryStore();
      addSpans(store, 'job', [
        span({ traceId: tid(0), spanId: sid(0), kind: 'INTERNAL', durationMs: 40 }),
        span({ traceId: tid(0), spanId: sid(1), parentSpanId: sid(0), durationMs: 5 }),
      ]);
      const stats = node(buildServiceMap(store.getAllTaggedSpans(), { range: 'all' }), 'svc:job').stats;
      assert.strictEqual(stats.count, 1);
      assert.strictEqual(stats.p50, 40);
    });

    it('counts errors and percentiles over the window', () => {
      const store = new TelemetryStore();
      addSpans(
        store,
        'api',
        roots('api', Array.from({ length: 20 }, (_, i) => ({ endMs: T0 + i * 100, durationMs: i + 1, error: i < 2 })))
      );
      const stats = node(buildServiceMap(store.getAllTaggedSpans(), { range: 'all' }), 'svc:api').stats;
      assert.strictEqual(stats.count, 20);
      assert.strictEqual(stats.errors, 2);
      assert.strictEqual(stats.errorRate, 0.1);
      assert.strictEqual(stats.p50, 10.5);
      assert.ok(Math.abs(stats.p95! - 19.05) < 1e-9);
    });

    it('keeps idle nodes and edges, and counts a call whose parent ended before the window', () => {
      const store = new TelemetryStore();
      const old = T0;
      const now = T0 + 6 * MIN;
      addSpans(store, 'web', [
        span({ traceId: tid(0), spanId: sid(0), kind: 'PRODUCER', startMs: old, durationMs: 10 }),
        span({ traceId: tid(1), spanId: sid(1), kind: 'CLIENT', startMs: old, durationMs: 5, attrs: { 'db.system': 'redis' } }),
      ]);
      addSpans(store, 'api', [
        span({ traceId: tid(0), spanId: sid(2), parentSpanId: sid(0), kind: 'CONSUMER', startMs: now - 20, durationMs: 20 }),
      ]);
      const m = buildServiceMap(store.getAllTaggedSpans(), { range: '5m' });
      assert.strictEqual(m.fromMs, now - 5 * MIN);
      const web = node(m, 'svc:web').stats;
      assert.strictEqual(web.count, 0);
      assert.strictEqual(web.p95, null);
      assert.strictEqual(web.lastSeenMs, old + 10);
      const async = edge(m, 'svc:web', 'svc:api').stats;
      assert.strictEqual(async.count, 1);
      assert.strictEqual(async.p95, 10);
      assert.strictEqual(edge(m, 'svc:web', 'db:redis:redis').stats.count, 0);
      assert.strictEqual(node(m, 'db:redis:redis').stats.count, 0);
    });

    it('rates over the effective window and flags partial windows', () => {
      const store = new TelemetryStore();
      // 13 calls, one every 10 s, spanning 2 minutes.
      addSpans(store, 'api', roots('api', Array.from({ length: 13 }, (_, i) => ({ endMs: T0 + 10 + i * 10_000 }))));
      const tagged = store.getAllTaggedSpans();

      const five = buildServiceMap(tagged, { range: '5m' });
      assert.strictEqual(five.effectiveWindowMs, 2 * MIN + 10);
      assert.strictEqual(five.partial, true);
      assert.ok(Math.abs(node(five, 'svc:api').stats.ratePerMin! - 13 / ((2 * MIN + 10) / MIN)) < 1e-9);

      const one = buildServiceMap(tagged, { range: '1m' });
      assert.strictEqual(one.effectiveWindowMs, MIN);
      assert.strictEqual(one.partial, false);
      assert.strictEqual(node(one, 'svc:api').stats.count, 7);
      assert.strictEqual(node(one, 'svc:api').stats.ratePerMin, 7);

      assert.strictEqual(node(buildServiceMap(tagged, { range: 'all' }), 'svc:api').stats.ratePerMin, undefined);
    });

    it('omits the rate when the effective window is under 10 s', () => {
      const store = new TelemetryStore();
      addSpans(store, 'api', roots('api', [{ endMs: T0 + 10 }, { endMs: T0 + 5000 }]));
      const m = buildServiceMap(store.getAllTaggedSpans(), { range: '5m' });
      assert.strictEqual(m.partial, true);
      assert.strictEqual(node(m, 'svc:api').stats.ratePerMin, undefined);
    });

    it('buckets sparklines across the window', () => {
      const store = new TelemetryStore();
      addSpans(
        store,
        'api',
        roots('api', [{ endMs: T0 + 100 }, { endMs: T0 + 400, error: true }, { endMs: T0 + 900 }, { endMs: T0 + 1010 }])
      );
      const { spark, count } = node(buildServiceMap(store.getAllTaggedSpans(), { range: 'all', buckets: 2 }), 'svc:api').stats;
      // Window is [T0 + 90, T0 + 1010] (oldest span start to newest end); the bucket edge is at T0 + 550.
      assert.deepStrictEqual(spark, { count: [2, 2], errors: [1, 0] });
      assert.strictEqual(spark.count.reduce((a, b) => a + b, 0), count);
    });

    it('caps nodes by dropping the least-called non-service nodes', () => {
      const store = new TelemetryStore();
      const spans: Span[] = [];
      let i = 0;
      for (const [db, calls] of [['a', 4], ['b', 1], ['c', 3], ['d', 2]] as const) {
        for (let k = 0; k < calls; k++, i++) {
          spans.push(span({ traceId: tid(i), spanId: sid(i), kind: 'CLIENT', attrs: { 'db.system': db } }));
        }
      }
      addSpans(store, 'api', spans);
      const m = buildServiceMap(store.getAllTaggedSpans(), { range: 'all', maxNodes: 3 });
      assert.strictEqual(m.hiddenNodes, 2);
      assert.deepStrictEqual(
        m.nodes.map((n) => n.id),
        ['svc:api', 'db:a:a', 'db:c:c']
      );
      assert.deepStrictEqual(
        m.edges.map((e) => e.target),
        ['db:a:a', 'db:c:c']
      );
    });

    it('is independent of span order', () => {
      const store = new TelemetryStore();
      addDistributedTrace(store);
      addDistributedTrace(store, tid(9), T0 + 2000, 100);
      const tagged = store.getAllTaggedSpans();
      assert.deepStrictEqual(
        buildServiceMap([...tagged].reverse(), { range: '5m' }),
        buildServiceMap(tagged, { range: '5m' })
      );
    });

    it('handles prototype-named services', () => {
      const store = new TelemetryStore();
      addSpans(store, '__proto__', [span({ traceId: tid(0), spanId: sid(0), kind: 'SERVER' })]);
      addSpans(store, 'toString', [span({ traceId: tid(0), spanId: sid(1), parentSpanId: sid(0) })]);
      const m = buildServiceMap(store.getAllTaggedSpans(), { range: 'all' });
      assert.deepStrictEqual(
        m.nodes.map((n) => n.id),
        ['svc:__proto__', 'svc:toString']
      );
      assert.strictEqual(edge(m, 'svc:__proto__', 'svc:toString').stats.count, 1);
    });

    it('only sees the realm it is given', () => {
      const store = new TelemetryStore();
      addDistributedTrace(store);
      store.importSession({
        sourceLabel: 'old.json',
        traces: [{ resource: { serviceName: 'legacy', attrs: {} }, spans: [span({ traceId: tid(0), spanId: sid(0) })] }],
        logs: [],
        metrics: [],
      });
      const live = buildServiceMap(store.getAllTaggedSpans(LIVE_REALM), { range: 'all' });
      assert.ok(!live.nodes.some((n) => n.id === 'svc:legacy'));
      assert.strictEqual(live.nodes.length, 3);
    });
  });

  describe('buildNodeDetails', () => {
    function distStore(): TelemetryStore {
      const store = new TelemetryStore();
      addDistributedTrace(store);
      return store;
    }

    it('describes a service node', () => {
      const tagged = distStore().getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: 'all' });
      const d = buildNodeDetails(tagged, m, { kind: 'node', id: 'svc:checkout' })!;
      assert.deepStrictEqual(
        d.inbound.map((e) => e.source),
        ['svc:frontend']
      );
      assert.deepStrictEqual(
        d.outbound.map((e) => e.target),
        ['db:postgresql:shop']
      );
      assert.deepStrictEqual(
        d.operations.map((o) => [o.name, o.count, o.p95]),
        [['POST /pay', 1, 930]]
      );
      assert.deepStrictEqual(d.sources, [
        { location: { filepath: '/srv/checkout/orders.py', line: 17, function: 'load_orders' }, count: 1 },
      ]);
      assert.deepStrictEqual(d.instanceIds, ['checkout::i1']);
      assert.deepStrictEqual(d.errorTraces, []);
      assert.deepStrictEqual(d.slowTraces, [
        {
          traceId: DIST_TRACE,
          spanId: 'b000000000000001',
          instanceId: 'checkout::i1',
          serviceName: 'checkout',
          name: 'POST /pay',
          startMs: T0 + 20,
          durationMs: 930,
          error: false,
        },
      ]);
    });

    it('describes a dependency node from its callers', () => {
      const tagged = distStore().getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: 'all' });
      const d = buildNodeDetails(tagged, m, { kind: 'node', id: 'db:postgresql:shop' })!;
      assert.deepStrictEqual(
        d.operations.map((o) => o.name),
        ['SELECT orders']
      );
      assert.strictEqual(d.sources[0].location.filepath, '/srv/checkout/orders.py');
      assert.deepStrictEqual(d.instanceIds, []);
      assert.strictEqual(d.slowTraces[0].spanId, DB_SPAN);
    });

    it('describes an edge with caller-observed latency', () => {
      const tagged = distStore().getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: 'all' });
      const d = buildNodeDetails(tagged, m, { kind: 'edge', source: 'svc:frontend', target: 'svc:checkout' })!;
      assert.deepStrictEqual(d.inbound, []);
      assert.deepStrictEqual(d.outbound, []);
      assert.strictEqual(d.slowTraces[0].durationMs, 950);
      assert.strictEqual(d.operations[0].p95, 950);
    });

    it('caps and de-duplicates trace lists', () => {
      const store = new TelemetryStore();
      const spans = roots(
        'api',
        Array.from({ length: 8 }, (_, i) => ({ endMs: T0 + i * 1000, durationMs: 10 + i, error: true }))
      );
      // A second entry span in the slowest trace must not list that trace twice.
      spans.push(span({ traceId: tid(7), spanId: sid(50), kind: 'SERVER', startMs: T0, durationMs: 16.5 }));
      addSpans(store, 'api', spans);
      const tagged = store.getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: 'all' });
      const d = buildNodeDetails(tagged, m, { kind: 'node', id: 'svc:api' })!;
      assert.deepStrictEqual(
        d.errorTraces.map((t) => t.traceId),
        [7, 6, 5, 4, 3].map(tid)
      );
      assert.deepStrictEqual(
        d.slowTraces.map((t) => t.durationMs),
        [17, 16, 15, 14, 13]
      );
      assert.strictEqual(new Set(d.slowTraces.map((t) => t.traceId)).size, 5);
    });

    it('only uses spans inside the model window', () => {
      const store = new TelemetryStore();
      addSpans(store, 'api', roots('api', [{ endMs: T0 }, { endMs: T0 + 10 * MIN, durationMs: 3 }]));
      const tagged = store.getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: '5m' });
      const d = buildNodeDetails(tagged, m, { kind: 'node', id: 'svc:api' })!;
      assert.deepStrictEqual(
        d.slowTraces.map((t) => t.durationMs),
        [3]
      );
    });

    it('returns undefined for a selection not in the model', () => {
      const tagged = distStore().getAllTaggedSpans();
      const m = buildServiceMap(tagged, { range: 'all' });
      assert.strictEqual(buildNodeDetails(tagged, m, { kind: 'node', id: 'svc:nope' }), undefined);
      assert.strictEqual(
        buildNodeDetails(tagged, m, { kind: 'edge', source: 'svc:checkout', target: 'svc:frontend' }),
        undefined
      );
    });
  });
});
