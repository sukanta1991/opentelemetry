import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import {
  TraceSummaryCache,
  collectRootAttrKeys,
  rootAttrValue,
  summarizeTrace,
} from '../../src/views/traceSummary';

const TRACE = 'a'.repeat(32);
const resource = (svc: string) => ({ serviceName: svc, serviceInstanceId: 'i', attrs: {} });

function span(spanId: string, startMs: number, over: Partial<Span> = {}): Span {
  return {
    traceId: TRACE,
    spanId,
    name: `op-${spanId}`,
    kind: 'INTERNAL',
    startMs,
    endMs: startMs + 10,
    durationMs: 10,
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
    ...over,
  };
}

describe('traceSummary', () => {
  it('merges a trace across instances', () => {
    const store = new TelemetryStore();
    store.ingestSpans([{ resource: resource('front'), spans: [span('1', 100, { name: 'GET /' })] }]);
    store.ingestSpans([
      {
        resource: resource('back'),
        spans: [span('2', 110, { parentSpanId: '1', statusCode: 'ERROR' }), span('3', 150, { parentSpanId: '2' })],
      },
    ]);
    const { row, root } = summarizeTrace(TRACE, store.getTraceParts(TRACE));
    assert.strictEqual(root?.spanId, '1');
    assert.deepStrictEqual(row, {
      traceId: TRACE,
      rootName: 'GET /',
      rootService: 'front',
      startMs: 100,
      durationMs: 60,
      spanCount: 3,
      errorCount: 1,
      services: ['back', 'front'],
    });
  });

  it('falls back to a span whose parent is missing, then to the earliest span', () => {
    const store = new TelemetryStore();
    store.ingestSpans([
      { resource: resource('svc'), spans: [span('2', 50, { parentSpanId: 'gone' }), span('3', 40, { parentSpanId: '2' })] },
    ]);
    assert.strictEqual(summarizeTrace(TRACE, store.getTraceParts(TRACE)).root?.spanId, '2');

    const cyclic = new TelemetryStore();
    cyclic.ingestSpans([
      { resource: resource('svc'), spans: [span('4', 30, { parentSpanId: '5' }), span('5', 20, { parentSpanId: '4' })] },
    ]);
    assert.strictEqual(summarizeTrace(TRACE, cyclic.getTraceParts(TRACE)).root?.spanId, '5');
  });

  it('reports an unknown root for an empty trace', () => {
    const { row } = summarizeTrace(TRACE, []);
    assert.strictEqual(row.rootName, '(unknown)');
    assert.strictEqual(row.spanCount, 0);
  });

  it('caches until the trace changes and prunes dead entries', () => {
    const store = new TelemetryStore();
    store.ingestSpans([{ resource: resource('svc'), spans: [span('1', 0)] }]);
    const cache = new TraceSummaryCache();
    const first = cache.get(TRACE, store.getTraceParts(TRACE));
    assert.strictEqual(cache.get(TRACE, store.getTraceParts(TRACE)), first, 'cache hit');

    store.ingestSpans([{ resource: resource('svc'), spans: [span('2', 5, { parentSpanId: '1' })] }]);
    const second = cache.get(TRACE, store.getTraceParts(TRACE));
    assert.notStrictEqual(second, first, 'invalidated by a new span');
    assert.strictEqual(second.row.spanCount, 2);

    cache.prune(new Set());
    assert.strictEqual(cache.size, 0);
  });

  it('formats root attribute values', () => {
    const s = span('1', 0, { attrs: { a: 'x', n: 5, o: { k: [1] }, long: 'y'.repeat(300) } });
    assert.strictEqual(rootAttrValue(s, 'a'), 'x');
    assert.strictEqual(rootAttrValue(s, 'n'), '5');
    assert.strictEqual(rootAttrValue(s, 'o'), '{"k":[1]}');
    assert.strictEqual(rootAttrValue(s, 'long')?.length, 201);
    assert.strictEqual(rootAttrValue(s, 'missing'), undefined);
    assert.strictEqual(rootAttrValue(undefined, 'a'), undefined);
  });

  it('collects sorted root attribute keys up to a cap', () => {
    const mk = (attrs: Record<string, string>) => ({ row: {} as never, root: span('1', 0, { attrs }) });
    assert.deepStrictEqual(collectRootAttrKeys([mk({ b: '1', a: '1' }), mk({ c: '1' }), { row: {} as never }]), [
      'a',
      'b',
      'c',
    ]);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    assert.strictEqual(collectRootAttrKeys([mk(many)], 10).length, 10);
  });
});
