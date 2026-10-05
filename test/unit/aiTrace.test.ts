// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { getTraceDetail } from '../../src/ai/analysis/trace';
import { REDACTED, createRedactor } from '../../src/ai/redact';
import { parseGetTraceInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import {
  DB_SPAN,
  DIST_TRACE,
  FAIL_CHILD,
  FAIL_ROOT,
  FAIL_TRACE,
  ODD_TRACE,
  SECRET_BEARER,
  SECRET_KEY,
  T0,
  addDistributedTrace,
  addFailingTrace,
  addOrphanAndSkewTrace,
  addTraceLogs,
} from './aiFixtures';

const ctx = { now: T0 + 90_000, redactor: createRedactor(), maxItems: 25 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseGetTraceInput(raw);
  if ('error' in input) throw new Error(input.error);
  return getTraceDetail(store, input.value, ctx);
}

function build(): TelemetryStore {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addTraceLogs(store);
  addFailingTrace(store);
  addOrphanAndSkewTrace(store);
  return store;
}

describe('ai getTraceDetail', () => {
  const store = build();

  it('follows the critical path to the slow DB span', () => {
    const { result } = run(store, { traceId: DIST_TRACE });
    assert.deepStrictEqual(
      result.criticalPath.map((s: any) => [s.name, s.service, s.durationMs, s.selfMs, s.pctOfTrace]),
      [
        ['GET /checkout', 'frontend', 1000, 50, 100],
        ['POST checkout', 'frontend', 950, 20, 95],
        ['POST /pay', 'checkout', 930, 130, 93],
        ['SELECT orders', 'checkout', 800, 800, 80],
      ]
    );
    assert.strictEqual(result.criticalPath.at(-1).spanId, DB_SPAN);
    assert.strictEqual(result.criticalPathTruncated, undefined);
  });

  it('summarizes the trace, self-time and services', () => {
    const { result } = run(store, { traceId: '4bf92f35' });
    assert.deepStrictEqual(result.trace, {
      traceId: DIST_TRACE,
      rootName: 'GET /checkout',
      rootService: 'frontend',
      start: new Date(T0).toISOString(),
      durationMs: 1000,
      spanCount: 4,
      errorCount: 0,
      services: ['checkout', 'frontend'],
      orphanCount: 0,
    });
    assert.deepStrictEqual(
      result.topSelfTime.map((s: any) => [s.name, s.selfMs, s.pctOfTrace]),
      [
        ['SELECT orders', 800, 80],
        ['POST /pay', 130, 13],
        ['GET /checkout', 50, 5],
        ['POST checkout', 20, 2],
      ]
    );
    assert.deepStrictEqual(result.byService, [
      { service: 'checkout', selfMs: 930, pct: 93 },
      { service: 'frontend', selfMs: 70, pct: 7 },
    ]);
    assert.deepStrictEqual(result.errors, []);
  });

  it('includes correlated logs with seq, oldest first and redacted', () => {
    const { result } = run(store, { traceId: DIST_TRACE });
    assert.deepStrictEqual(
      result.logs.map((l: any) => [l.severity, l.spanId, l.instanceId]),
      [
        ['INFO', 'a000000000000001', 'frontend::i1'],
        ['INFO', 'b000000000000001', 'checkout::i1'],
        ['INFO', DB_SPAN, 'checkout::i1'],
        ['WARN', DB_SPAN, 'checkout::i1'],
      ]
    );
    assert.ok(result.logs.every((l: any) => Number.isInteger(l.seq)));
    assert.strictEqual(result.logs[3].body, `slow query, dsn postgres://app:${REDACTED}@db:5432/shop`);
    assert.strictEqual(result.logs[0].time, new Date(T0 + 5).toISOString());
    assert.strictEqual(run(store, { traceId: DIST_TRACE, includeLogs: false }).result.logs, undefined);
  });

  it('emits trace, bottleneck span, logs and source refs', () => {
    const { refs } = run(store, { traceId: DIST_TRACE });
    assert.deepStrictEqual(refs, [
      { kind: 'trace', traceId: DIST_TRACE, instanceId: 'frontend::i1', label: 'GET /checkout' },
      { kind: 'span', traceId: DIST_TRACE, spanId: DB_SPAN, instanceId: 'checkout::i1', label: 'SELECT orders' },
      { kind: 'logs', traceId: DIST_TRACE, spanId: undefined, instanceId: undefined, label: 'View Logs' },
      {
        kind: 'source',
        traceId: DIST_TRACE,
        spanId: DB_SPAN,
        code: { filepath: '/srv/checkout/orders.py', line: 17, column: undefined, function: 'load_orders' },
        label: 'SELECT orders',
      },
    ]);
  });

  it('reports error spans with redacted status and exception details', () => {
    const { result, refs } = run(store, { traceId: FAIL_TRACE });
    assert.deepStrictEqual(
      result.errors.map((e: any) => e.spanId),
      [FAIL_ROOT, FAIL_CHILD]
    );
    assert.strictEqual(result.errors[0].statusMessage, `payment failed (Bearer ${REDACTED})`);
    assert.deepStrictEqual(result.errors[1].exceptions, [
      {
        'exception.message': `card declined, api_key=${REDACTED}`,
        'exception.stacktrace': 'at charge (pay.py:42)',
        'exception.type': 'CardError',
      },
    ]);
    assert.deepStrictEqual(result.errors[1].eventNames, ['exception']);
    const text = JSON.stringify(result);
    assert.ok(!text.includes(SECRET_KEY) && !text.includes(SECRET_BEARER.slice(7)));
    assert.ok(!text.includes('must never be sent'));
    assert.deepStrictEqual(
      refs.filter((r: any) => r.kind === 'span').map((r: any) => r.spanId),
      [FAIL_CHILD, FAIL_ROOT],
      'bottleneck first, then the first error span'
    );
    assert.ok(refs.some((r: any) => r.kind === 'source' && r.code.filepath === '/srv/checkout/pay.py'));
  });

  it('counts orphans and clips skewed children', () => {
    const { result } = run(store, { traceId: ODD_TRACE });
    assert.strictEqual(result.trace.orphanCount, 1);
    const self = Object.fromEntries(result.topSelfTime.map((s: any) => [s.name, s.selfMs]));
    assert.deepStrictEqual(self, { skewed: 150, lost: 30, job: 0 });
    assert.deepStrictEqual(
      result.criticalPath.map((s: any) => s.name),
      ['job', 'skewed'],
      'starts from the longest root'
    );
  });

  it('defaults to the latest trace', () => {
    assert.strictEqual(run(store, {}).result.trace.traceId, ODD_TRACE);
    const empty = run(new TelemetryStore(), {});
    assert.match(empty.result.error, /no traces/);
  });

  it('zooms into a span subtree', () => {
    const { result, refs } = run(store, { traceId: DIST_TRACE, spanId: 'b000000000000001' });
    assert.deepStrictEqual(result.zoom, { spanId: 'b000000000000001', name: 'POST /pay', service: 'checkout', spanCount: 2 });
    assert.deepStrictEqual(
      result.criticalPath.map((s: any) => s.name),
      ['POST /pay', 'SELECT orders']
    );
    assert.deepStrictEqual(
      result.topSelfTime.map((s: any) => s.name),
      ['SELECT orders', 'POST /pay']
    );
    assert.deepStrictEqual(
      result.logs.map((l: any) => l.spanId),
      ['b000000000000001']
    );
    assert.strictEqual(result.trace.spanCount, 4, 'summary still covers the whole trace');
    const logsRef = refs.find((r: any) => r.kind === 'logs');
    assert.deepStrictEqual(logsRef, {
      kind: 'logs',
      traceId: DIST_TRACE,
      spanId: 'b000000000000001',
      instanceId: 'checkout::i1',
      label: 'View Logs',
    });
  });

  it('returns actionable errors for unknown ids', () => {
    assert.match(run(store, { traceId: 'f'.repeat(32) }).result.error, /evicted/);
    assert.match(run(store, { traceId: DIST_TRACE, spanId: 'ffffffffffffffff' }).result.error, /not found/);
    assert.deepStrictEqual(run(store, { traceId: 'nope' }).refs, []);
  });
});
