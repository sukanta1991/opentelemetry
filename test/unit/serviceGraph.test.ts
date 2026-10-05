// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { TelemetryStore } from '../../src/store/store';
import { buildGraph } from '../../src/views/serviceGraph';
import { DIST_TRACE, addDistributedTrace, addSpans, span } from './aiFixtures';

const T = 'cccccccccccccccccccccccccccccccc';

describe('serviceGraph', () => {
  it('builds service, database and cross-service edges for a distributed trace', () => {
    const store = new TelemetryStore();
    addDistributedTrace(store, DIST_TRACE);
    assert.deepStrictEqual(buildGraph(store.getAllTaggedSpans()), {
      nodes: [
        { id: 'svc:frontend', label: 'frontend', type: 'service' },
        { id: 'svc:checkout', label: 'checkout', type: 'service' },
        { id: 'db:postgresql:shop', label: 'postgresql: shop', type: 'database' },
      ],
      edges: [
        { source: 'svc:checkout', target: 'db:postgresql:shop', count: 1, errors: 0 },
        { source: 'svc:frontend', target: 'svc:checkout', count: 1, errors: 0 },
      ],
    });
  });

  it('adds queue and external nodes and counts errors', () => {
    const store = new TelemetryStore();
    addSpans(store, 'orders', [
      span({ traceId: T, spanId: 'c000000000000001', kind: 'SERVER' }),
      span({
        traceId: T,
        spanId: 'c000000000000002',
        parentSpanId: 'c000000000000001',
        kind: 'PRODUCER',
        attrs: { 'messaging.system': 'kafka', 'messaging.destination.name': 'orders' },
      }),
      span({
        traceId: T,
        spanId: 'c000000000000003',
        parentSpanId: 'c000000000000001',
        kind: 'CLIENT',
        statusCode: 'ERROR',
        attrs: { 'server.address': 'api.stripe.com' },
      }),
      span({
        traceId: T,
        spanId: 'c000000000000004',
        parentSpanId: 'c000000000000001',
        kind: 'CLIENT',
        statusCode: 'ERROR',
        attrs: { 'server.address': 'api.stripe.com' },
      }),
      span({
        traceId: T,
        spanId: 'c000000000000005',
        parentSpanId: 'c000000000000001',
        kind: 'CLIENT',
        attrs: { 'db.system': 'redis' },
      }),
    ]);
    const { nodes, edges } = buildGraph(store.getAllTaggedSpans());
    assert.deepStrictEqual(nodes, [
      { id: 'svc:orders', label: 'orders', type: 'service' },
      { id: 'queue:kafka:orders', label: 'kafka: orders', type: 'queue' },
      { id: 'ext:api.stripe.com', label: 'api.stripe.com', type: 'external' },
      { id: 'db:redis:redis', label: 'redis: redis', type: 'database' },
    ]);
    assert.deepStrictEqual(edges, [
      { source: 'svc:orders', target: 'queue:kafka:orders', count: 1, errors: 0 },
      { source: 'svc:orders', target: 'ext:api.stripe.com', count: 2, errors: 2 },
      { source: 'svc:orders', target: 'db:redis:redis', count: 1, errors: 0 },
    ]);
  });

  it('never creates self-edges or external nodes for known services', () => {
    const store = new TelemetryStore();
    addSpans(store, 'a', [
      span({ traceId: T, spanId: 'd000000000000001', kind: 'SERVER' }),
      span({
        traceId: T,
        spanId: 'd000000000000002',
        parentSpanId: 'd000000000000001',
        kind: 'CLIENT',
        attrs: { 'peer.service': 'a' },
      }),
    ]);
    const { nodes, edges } = buildGraph(store.getAllTaggedSpans());
    assert.deepStrictEqual(nodes, [{ id: 'svc:a', label: 'a', type: 'service' }]);
    assert.deepStrictEqual(edges, []);
  });

  it('counts errors on cross-service edges from the child span status', () => {
    const store = new TelemetryStore();
    addSpans(store, 'web', [span({ traceId: T, spanId: 'e000000000000001', kind: 'SERVER' })]);
    addSpans(store, 'api', [
      span({ traceId: T, spanId: 'e000000000000002', parentSpanId: 'e000000000000001', statusCode: 'ERROR' }),
      span({ traceId: T, spanId: 'e000000000000003', parentSpanId: 'e000000000000001' }),
    ]);
    assert.deepStrictEqual(buildGraph(store.getAllTaggedSpans()).edges, [
      { source: 'svc:web', target: 'svc:api', count: 2, errors: 1 },
    ]);
  });

  it('returns an empty graph for no spans', () => {
    assert.deepStrictEqual(buildGraph([]), { nodes: [], edges: [] });
  });
});
