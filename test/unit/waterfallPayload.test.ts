import * as assert from 'assert';
import { Span, StoredLogRecord } from '../../src/store/model';
import { TraceLog } from '../../src/store/store';
import { buildWaterfallPayload, truncateMessage } from '../../src/views/waterfallPayload';

const TRACE = 'a'.repeat(32);

function span(spanId: string, startMs: number, durationMs: number, parentSpanId?: string): Span {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId,
    name: spanId,
    kind: 'INTERNAL',
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
  };
}

function log(seq: number, timeMs: number, spanId?: string, body = `m${seq}`): TraceLog {
  const l: StoredLogRecord = {
    seq,
    timeMs,
    severityNumber: 9,
    severityText: 'INFO',
    body,
    attrs: {},
    traceId: TRACE,
    spanId,
  };
  return { instanceId: 'svc::1', log: l };
}

const tagged = [
  { span: span('root', 1000, 100), serviceName: 'svc', instanceId: 'svc::1' },
  { span: span('child', 1020, 30, 'root'), serviceName: 'svc', instanceId: 'svc::1' },
];
const resources = new Map([['svc::1', { serviceName: 'svc', attrs: { 'host.name': 'box' } }]]);

describe('waterfallPayload', () => {
  it('groups logs by span and counts them on the row', () => {
    const p = buildWaterfallPayload(TRACE, tagged, [log(1, 1010, 'root'), log(2, 1030, 'child'), log(3, 1040, 'child')], resources);
    assert.deepStrictEqual(Object.keys(p.logsBySpan).sort(), ['child', 'root']);
    assert.strictEqual(p.logsBySpan.child.length, 2);
    assert.strictEqual(p.rows.find((r) => r.spanId === 'child')?.logCount, 2);
    assert.strictEqual(p.logsBySpan.root[0].offsetMs, 10);
    assert.strictEqual(p.totalMs, 100);
    assert.deepStrictEqual(p.traceLogs, []);
  });

  it('sends logs without a known span to the trace-level list', () => {
    const p = buildWaterfallPayload(TRACE, tagged, [log(1, 1000), log(2, 1001, 'ffffffffffffffff')], resources);
    assert.deepStrictEqual(
      p.traceLogs.map((l) => l.seq),
      [1, 2]
    );
  });

  it('flags logs outside their span as skewed', () => {
    const p = buildWaterfallPayload(TRACE, tagged, [log(1, 1010, 'child'), log(2, 1060, 'child'), log(3, 1030, 'child')], resources);
    assert.deepStrictEqual(
      p.logsBySpan.child.map((l) => l.skew),
      ['before', 'after', undefined]
    );
  });

  it('caps logs to the newest and reports truncation', () => {
    const many = Array.from({ length: 10 }, (_, i) => log(i, 1000 + i, 'root'));
    const p = buildWaterfallPayload(TRACE, tagged, many, resources, { maxLogs: 4 });
    assert.deepStrictEqual(
      p.logsBySpan.root.map((l) => l.seq),
      [6, 7, 8, 9]
    );
    assert.strictEqual(p.truncated, true);
    assert.strictEqual(buildWaterfallPayload(TRACE, tagged, many, resources, { truncated: true }).truncated, true);
    assert.strictEqual(buildWaterfallPayload(TRACE, tagged, many, resources).truncated, false);
  });

  it('truncates and flattens long messages', () => {
    const p = buildWaterfallPayload(TRACE, tagged, [log(1, 1000, 'root', `line1\n  ${'x'.repeat(400)}`)], resources);
    const msg = p.logsBySpan.root[0].message;
    assert.ok(msg.startsWith('line1 x'));
    assert.strictEqual(msg.length, 301);
    assert.strictEqual(truncateMessage('short'), 'short');
  });

  it('includes each participating instance resource once', () => {
    const p = buildWaterfallPayload(TRACE, tagged, [], resources);
    assert.deepStrictEqual(p.resources, {
      'svc::1': { serviceName: 'svc', attrs: [{ key: 'host.name', value: 'box', structured: false }] },
    });
  });
});
