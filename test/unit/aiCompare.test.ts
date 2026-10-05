// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { compareTraces } from '../../src/ai/analysis/compare';
import { createRedactor } from '../../src/ai/redact';
import { parseCompareTracesInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import {
  DB_SPAN,
  DIST_TRACE,
  ODD_TRACE,
  T0,
  addBaselineTraces,
  addDistributedTrace,
  addFailingTrace,
  addOrphanAndSkewTrace,
  addSpans,
  baselineTraceId,
  span,
} from './aiFixtures';

const ctx = { now: T0 + 90_000, redactor: createRedactor(), maxItems: 25 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseCompareTracesInput(raw);
  if ('error' in input) throw new Error(input.error);
  return compareTraces(store, input.value, ctx);
}

function build(): TelemetryStore {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addFailingTrace(store);
  addOrphanAndSkewTrace(store);
  addBaselineTraces(store);
  return store;
}

describe('ai compareTraces', () => {
  const store = build();

  it('compares against the median of peers with the same root', () => {
    const { result, refs } = run(store, { traceId: DIST_TRACE });
    assert.deepStrictEqual(result.target, {
      traceId: DIST_TRACE,
      rootName: 'GET /checkout',
      rootService: 'frontend',
      durationMs: 1000,
      errorCount: 0,
    });
    // Baseline durations are 250–258 ms, six of each; the one closest to the 254 ms median wins.
    assert.deepStrictEqual(result.baseline, { mode: 'median', durationMs: 254, traceId: baselineTraceId(2) });
    assert.strictEqual(result.baselineCount, 30);
    assert.strictEqual(result.durationRatio, 3.937);
    assert.strictEqual(result.durationDiffMs, 746);
    assert.deepStrictEqual(result.deltas, [
      { service: 'checkout', name: 'SELECT orders', targetSelfMs: 800, baselineSelfMs: 54, diffMs: 746, ratio: 14.815 },
    ]);
    assert.deepStrictEqual(result.newInTarget, []);
    assert.deepStrictEqual(result.missingInTarget, []);
    assert.deepStrictEqual(result.errors, { targetErrorSpans: 0, baselineErrorSpans: 0, newErrorGroups: [] });
    assert.deepStrictEqual(
      refs.map((r: any) => [r.kind, r.traceId, r.spanId]),
      [
        ['trace', DIST_TRACE, undefined],
        ['trace', baselineTraceId(2), undefined],
        ['span', DIST_TRACE, DB_SPAN],
      ]
    );
  });

  it('uses an explicit baseline', () => {
    const { result } = run(store, { traceId: DIST_TRACE, baselineTraceId: baselineTraceId(0) });
    assert.deepStrictEqual(result.baseline, { mode: 'explicit', durationMs: 250, traceId: baselineTraceId(0) });
    assert.strictEqual(result.baselineCount, 1);
    assert.strictEqual(result.durationRatio, 4);
    assert.deepStrictEqual(
      result.deltas.map((d: any) => [d.name, d.diffMs, d.ratio]),
      [['SELECT orders', 750, 16]]
    );
    assert.match(run(store, { traceId: DIST_TRACE, baselineTraceId: DIST_TRACE }).result.error, /must differ/);
    assert.match(run(store, { traceId: DIST_TRACE, baselineTraceId: 'f'.repeat(32) }).result.error, /^baseline: /);
  });

  it('errors when there is nothing comparable', () => {
    assert.strictEqual(run(store, { traceId: ODD_TRACE }).result.error, "no comparable traces with root 'job'");
    assert.match(run(store, { traceId: 'deadbeef' }).result.error, /evicted/);
  });

  it('prefers healthy peers for the automatic baseline', () => {
    const s = new TelemetryStore();
    addDistributedTrace(s);
    addBaselineTraces(s, 2);
    const failing = 'fa11fa11fa11fa11fa11fa11fa11fa11';
    addSpans(s, 'frontend', [
      span({ traceId: failing, spanId: 'a000000000000001', name: 'GET /checkout', kind: 'SERVER', statusCode: 'ERROR', startMs: T0 + 500, durationMs: 9000 }),
    ]);
    assert.strictEqual(run(s, { traceId: DIST_TRACE }).result.baselineCount, 2);
  });

  it('reports new, missing and newly failing groups, with a null ratio for a zero baseline', () => {
    const s = build();
    const target = 'c0ffeec0ffeec0ffeec0ffeec0ffee00';
    addSpans(s, 'frontend', [
      span({ traceId: target, spanId: 'c000000000000001', name: 'GET /checkout', kind: 'SERVER', startMs: T0 + 95_000, durationMs: 400 }),
      span({
        traceId: target,
        spanId: 'c000000000000002',
        parentSpanId: 'c000000000000001',
        name: 'cache lookup',
        statusCode: 'ERROR',
        startMs: T0 + 95_010,
        durationMs: 300,
      }),
    ]);
    const { result, refs } = run(s, { traceId: target });
    assert.strictEqual(result.baselineCount, 31, 'DIST_TRACE and the 30 baselines');
    assert.deepStrictEqual(
      result.deltas.map((d: any) => [d.name, d.targetSelfMs, d.baselineSelfMs, d.ratio]),
      [
        ['cache lookup', 300, 0, null],
        ['GET /checkout', 100, 50, 2],
      ]
    );
    assert.deepStrictEqual(result.newInTarget, [{ service: 'frontend', name: 'cache lookup', selfMs: 300 }]);
    assert.deepStrictEqual(
      result.missingInTarget.map((m: any) => [m.service, m.name]),
      [
        ['checkout', 'POST /pay'],
        ['checkout', 'SELECT orders'],
        ['frontend', 'POST checkout'],
      ]
    );
    assert.deepStrictEqual(result.errors.newErrorGroups, [{ service: 'frontend', name: 'cache lookup', errorSpans: 1 }]);
    assert.strictEqual(refs[2].spanId, 'c000000000000002');
  });
});
