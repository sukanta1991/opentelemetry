import * as assert from 'assert';
import { Span } from '../../src/store/model';
import {
  buildWaterfall,
  toAttrEntries,
} from '../../src/views/waterfall';

function span(p: Partial<Span> & { spanId: string; startMs: number }): Span {
  return {
    traceId: 't1',
    name: p.spanId,
    kind: 'INTERNAL',
    endMs: p.startMs + 10,
    durationMs: 10,
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
    ...p,
  };
}

const tag = (spans: Span[], serviceName = 'svc') => spans.map((s) => ({ span: s, serviceName }));

describe('buildWaterfall', () => {
  it('orders spans depth-first by start time with depth and offset', () => {
    const rows = buildWaterfall(
      tag([
        span({ spanId: 'c2', parentSpanId: 'root', startMs: 1030 }),
        span({ spanId: 'root', startMs: 1000 }),
        span({ spanId: 'c1', parentSpanId: 'root', startMs: 1010 }),
        span({ spanId: 'g1', parentSpanId: 'c1', startMs: 1015 }),
      ])
    );
    assert.deepStrictEqual(
      rows.map((r) => [r.spanId, r.depth, r.offsetMs]),
      [
        ['root', 0, 0],
        ['c1', 1, 10],
        ['g1', 2, 15],
        ['c2', 1, 30],
      ]
    );
  });

  it('treats a span with a missing parent as a root', () => {
    const rows = buildWaterfall(
      tag([span({ spanId: 'a', startMs: 0 }), span({ spanId: 'orphan', parentSpanId: 'gone', startMs: 5 })])
    );
    assert.deepStrictEqual(
      rows.map((r) => [r.spanId, r.depth]),
      [
        ['a', 0],
        ['orphan', 0],
      ]
    );
  });

  it('passes through status message, scope, service and error flag', () => {
    const [row] = buildWaterfall(
      tag(
        [span({ spanId: 's', startMs: 0, statusCode: 'ERROR', statusMessage: 'boom', scope: 'my.lib' })],
        'api'
      )
    );
    assert.strictEqual(row.traceId, 't1');
    assert.strictEqual(row.status, 'ERROR');
    assert.strictEqual(row.statusMessage, 'boom');
    assert.strictEqual(row.scope, 'my.lib');
    assert.strictEqual(row.service, 'api');
    assert.strictEqual(row.hasError, true);
  });

  it('maps events sorted by time with offsets relative to the span start', () => {
    const [row] = buildWaterfall(
      tag([
        span({
          spanId: 's',
          startMs: 1000,
          events: [
            { timeMs: 1007, name: 'second', attrs: { b: 2 } },
            { timeMs: 1002, name: 'first', attrs: {} },
          ],
        }),
      ])
    );
    assert.deepStrictEqual(row.events, [
      { name: 'first', offsetMs: 2, attrs: [] },
      { name: 'second', offsetMs: 7, attrs: [{ key: 'b', value: '2', structured: false }] },
    ]);
  });

  it('returns no rows for an empty trace', () => {
    assert.deepStrictEqual(buildWaterfall([]), []);
  });

  it('shows spans in a parent cycle instead of dropping them', () => {
    const rows = buildWaterfall(
      tag([
        span({ spanId: 'root', startMs: 0 }),
        span({ spanId: 'x', parentSpanId: 'y', startMs: 10 }),
        span({ spanId: 'y', parentSpanId: 'x', startMs: 5 }),
        span({ spanId: 'self', parentSpanId: 'self', startMs: 20 }),
      ])
    );
    assert.deepStrictEqual(
      rows.map((r) => [r.spanId, r.depth, r.orphan]),
      [
        ['root', 0, false],
        ['y', 0, true],
        ['x', 1, false],
        ['self', 0, true],
      ]
    );
  });

  it('flags a missing parent as orphan', () => {
    const rows = buildWaterfall(tag([span({ spanId: 'o', parentSpanId: 'gone', startMs: 0 })]));
    assert.strictEqual(rows[0].orphan, true);
  });

  it('collapses duplicate span ids to the latest-ending copy', () => {
    const rows = buildWaterfall(
      tag([span({ spanId: 'd', startMs: 0, endMs: 5, name: 'partial' }), span({ spanId: 'd', startMs: 0, endMs: 9, name: 'full' })])
    );
    assert.deepStrictEqual(
      rows.map((r) => r.name),
      ['full']
    );
  });

  it('handles very deep traces without recursion', () => {
    const chain = Array.from({ length: 20000 }, (_, i) =>
      span({ spanId: `s${i}`, parentSpanId: i ? `s${i - 1}` : undefined, startMs: i })
    );
    const rows = buildWaterfall(tag(chain));
    assert.strictEqual(rows.length, 20000);
    assert.strictEqual(rows[19999].depth, 19999);
  });

  it('passes through instance, links and code location', () => {
    const [row] = buildWaterfall(
      [
        {
          serviceName: 'api',
          instanceId: 'api::1',
          span: span({
            spanId: 's',
            startMs: 0,
            links: [{ traceId: 'T2', spanId: 'S2', traceState: 'k=v', attrs: { a: 1 } }, { traceId: 'T3', spanId: 'S3', attrs: {} }],
            codeLocation: { filepath: 'src/a.ts', line: 3, function: 'f' },
          }),
        },
      ],
      { linkAvailable: (t) => t === 'T2' }
    );
    assert.strictEqual(row.instanceId, 'api::1');
    assert.deepStrictEqual(row.links, [
      { traceId: 'T2', spanId: 'S2', traceState: 'k=v', attrs: [{ key: 'a', value: '1', structured: false }], available: true },
      { traceId: 'T3', spanId: 'S3', traceState: undefined, attrs: [], available: false },
    ]);
    assert.deepStrictEqual(row.code, { filepath: 'src/a.ts', line: 3, function: 'f' });
    assert.strictEqual(row.logCount, 0);
  });
});

describe('toAttrEntries', () => {
  it('sorts by key and stringifies scalars and structured values', () => {
    assert.deepStrictEqual(
      toAttrEntries({
        'z.str': 'hello',
        'a.num': 3.5,
        'm.bool': false,
        'n.null': null,
        'b.arr': [1, 'x'],
        'c.obj': { role: 'user', parts: [{ text: 'hi' }] },
      }),
      [
        { key: 'a.num', value: '3.5', structured: false },
        { key: 'b.arr', value: JSON.stringify([1, 'x'], null, 2), structured: true },
        {
          key: 'c.obj',
          value: JSON.stringify({ role: 'user', parts: [{ text: 'hi' }] }, null, 2),
          structured: true,
        },
        { key: 'm.bool', value: 'false', structured: false },
        { key: 'n.null', value: 'null', structured: false },
        { key: 'z.str', value: 'hello', structured: false },
      ]
    );
  });
});
