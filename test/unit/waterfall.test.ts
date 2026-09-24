import * as assert from 'assert';
import { Span } from '../../src/store/model';
import {
  buildWaterfall,
  parseAttrFilter,
  toAttrEntries,
  traceMatchesAttrFilter,
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

describe('parseAttrFilter', () => {
  it('returns undefined for blank or keyless input', () => {
    assert.strictEqual(parseAttrFilter(''), undefined);
    assert.strictEqual(parseAttrFilter('   '), undefined);
    assert.strictEqual(parseAttrFilter('=v'), undefined);
  });

  it('parses presence and key=value filters', () => {
    assert.deepStrictEqual(parseAttrFilter('gen_ai.system'), { key: 'gen_ai.system' });
    assert.deepStrictEqual(parseAttrFilter('k='), { key: 'k' });
    assert.deepStrictEqual(parseAttrFilter(' k = Val '), { key: 'k', value: 'val' });
    assert.deepStrictEqual(parseAttrFilter('url=a=b'), { key: 'url', value: 'a=b' });
  });
});

describe('traceMatchesAttrFilter', () => {
  const spans = [
    span({ spanId: 'a', startMs: 0, attrs: { 'gen_ai.system': 'OpenAI', tokens: 42 } }),
    span({ spanId: 'b', startMs: 1, attrs: { tags: ['Alpha', 'beta'], flag: null } }),
  ];
  const match = (text: string) => traceMatchesAttrFilter(spans, parseAttrFilter(text)!);

  it('matches on attribute presence in any span', () => {
    assert.strictEqual(match('gen_ai.system'), true);
    assert.strictEqual(match('tags'), true);
    assert.strictEqual(match('flag'), true);
    assert.strictEqual(match('missing'), false);
  });

  it('matches value substrings case-insensitively', () => {
    assert.strictEqual(match('gen_ai.system=openai'), true);
    assert.strictEqual(match('gen_ai.system=AI'), true);
    assert.strictEqual(match('gen_ai.system=anthropic'), false);
    assert.strictEqual(match('tokens=42'), true);
    assert.strictEqual(match('tags=alpha'), true);
  });

  it('matches keys exactly', () => {
    assert.strictEqual(match('GEN_AI.SYSTEM'), false);
    assert.strictEqual(match('gen_ai'), false);
  });
});
