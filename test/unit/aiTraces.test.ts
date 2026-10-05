// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { searchTraces, summaryCache } from '../../src/ai/analysis/traces';
import { createRedactor } from '../../src/ai/redact';
import { parseSearchTracesInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import {
  DIST_TRACE,
  FAIL_TRACE,
  ODD_TRACE,
  T0,
  addBaselineTraces,
  addDistributedTrace,
  addFailingTrace,
  addOrphanAndSkewTrace,
  baselineTraceId,
} from './aiFixtures';

const ctx = { now: T0 + 90_000, redactor: createRedactor(), maxItems: 50 };

function build(): TelemetryStore {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addFailingTrace(store);
  addOrphanAndSkewTrace(store);
  addBaselineTraces(store);
  return store;
}

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseSearchTracesInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return searchTraces(store, input.value, ctx);
}

describe('ai searchTraces', () => {
  const store = build();

  it('lists the newest traces first with stats over all matches', () => {
    const { result } = run(store, { limit: 5 });
    assert.strictEqual(result.scannedTraces, 33);
    assert.strictEqual(result.matched, 33);
    assert.deepStrictEqual(
      result.rows.map((r: any) => r.traceId),
      [29, 28, 27, 26, 25].map(baselineTraceId)
    );
    assert.deepStrictEqual(result.stats, {
      count: 33,
      errorTraces: 1,
      errorRate: 0.03,
      p50Ms: 254,
      // Linear interpolation between the 31st (258) and 32nd (300) of 33 sorted durations.
      p95Ms: 274.8,
      maxMs: 1000,
    });
    const row = result.rows[0];
    assert.strictEqual(row.rootName, 'GET /checkout');
    assert.strictEqual(row.rootService, 'frontend');
    assert.strictEqual(row.start, new Date(T0 + 89_000).toISOString());
    assert.deepStrictEqual(row.services, ['checkout', 'frontend']);
    assert.strictEqual(row.spanCount, 4);
  });

  it('filters with the trace query syntax and the structured fields', () => {
    assert.deepStrictEqual(
      run(store, { query: 'status=error' }).result.rows.map((r: any) => r.traceId),
      [FAIL_TRACE]
    );
    assert.deepStrictEqual(
      run(store, { query: 'service=checkout dur>500ms' }).result.rows.map((r: any) => r.traceId),
      [DIST_TRACE]
    );
    assert.deepStrictEqual(
      run(store, { status: 'error', service: 'checkout' }).result.rows.map((r: any) => r.traceId),
      [FAIL_TRACE]
    );
    assert.deepStrictEqual(
      run(store, { minDurationMs: 290 }).result.rows.map((r: any) => r.traceId),
      [FAIL_TRACE, DIST_TRACE]
    );
    assert.strictEqual(run(store, { query: 'http.route=/pay' }).result.matched, 1);
  });

  it('returns parser errors for bad queries', () => {
    const { result } = run(store, { query: 'dur>abc status=nope' });
    assert.deepStrictEqual(
      result.queryErrors.map((e: any) => e.token),
      ['dur>abc', 'status=nope']
    );
    assert.match(result.queryErrors[0].message, /expected a duration/);
  });

  it('sorts by duration and errors with a deterministic trace id tiebreak', () => {
    const byDuration = run(store, { sort: 'duration', limit: 5 }).result.rows.map((r: any) => r.traceId);
    // Baselines 4, 9, 14 … share the slowest baseline duration (258 ms): id order breaks the tie.
    assert.deepStrictEqual(byDuration, [DIST_TRACE, FAIL_TRACE, ...[4, 9, 14].map(baselineTraceId)]);
    assert.deepStrictEqual(run(store, { sort: 'duration', limit: 5 }).result.rows.map((r: any) => r.traceId), byDuration);
    const byErrors = run(store, { sort: 'errors', limit: 2 }).result.rows.map((r: any) => r.traceId);
    assert.deepStrictEqual(byErrors, [FAIL_TRACE, DIST_TRACE]);
  });

  it('applies the sinceMinutes window against ctx.now', () => {
    // now = T0+90s, so 1 minute reaches back to T0+30s: only the baseline traces.
    const { result } = run(store, { sinceMinutes: 1 });
    assert.strictEqual(result.matched, 30);
    assert.strictEqual(result.sinceMinutes, 1);
  });

  it('groups by root name and root service', () => {
    const { result, refs } = run(store, { groupBy: 'rootName' });
    assert.deepStrictEqual(
      result.groups.map((g: any) => [g.key, g.count, g.errorCount]),
      [
        ['GET /checkout', 31, 0],
        ['POST /pay', 1, 1],
        ['job', 1, 0],
      ]
    );
    const checkout = result.groups[0];
    assert.strictEqual(checkout.exampleTraceId, DIST_TRACE, 'slowest trace is the example');
    assert.strictEqual(checkout.maxMs, 1000);
    assert.strictEqual(checkout.errorRate, 0);
    assert.strictEqual(result.groups[1].exampleTraceId, FAIL_TRACE);
    assert.deepStrictEqual(
      refs.map((r: any) => r.traceId),
      [DIST_TRACE, FAIL_TRACE, ODD_TRACE]
    );

    const services = run(store, { groupBy: 'rootService', sort: 'errors' }).result.groups;
    assert.deepStrictEqual(
      services.map((g: any) => g.key),
      ['checkout', 'frontend', 'worker']
    );
  });

  it('groups by a root-span attribute, sorted by p95 for sort=duration', () => {
    const { result } = run(store, { groupBy: 'http.route', sort: 'duration' });
    assert.deepStrictEqual(
      result.groups.map((g: any) => [g.key, g.count, g.p95Ms]),
      [
        ['/pay', 1, 300],
        ['/checkout', 31, 258],
        ['(missing)', 1, 150],
      ]
    );
  });

  it('groups by time into 12 ordered buckets', () => {
    const { result } = run(store, { groupBy: 'time' });
    assert.strictEqual(result.groups.length, 12);
    const starts = result.groups.map((g: any) => Date.parse(g.key));
    assert.deepStrictEqual(starts, [...starts].sort((a, b) => a - b));
    assert.strictEqual(starts[0], T0);
    assert.strictEqual(
      result.groups.reduce((n: number, g: any) => n + g.count, 0),
      33
    );
    assert.strictEqual(result.groups[0].count, 2, 'DIST and FAIL fall in the first bucket');
    assert.strictEqual(result.groups[5].count, 0);
    assert.strictEqual(result.groups[5].p50Ms, null);

    const windowed = run(store, { groupBy: 'time', sinceMinutes: 2 }).result.groups;
    assert.strictEqual(Date.parse(windowed[0].key), ctx.now - 120_000);
  });

  it('emits a trace ref for each row with the preferred instance', () => {
    const { refs } = run(store, { query: 'dur>500ms' });
    assert.deepStrictEqual(refs, [
      { kind: 'trace', traceId: DIST_TRACE, instanceId: 'frontend::i1', label: 'GET /checkout' },
    ]);
  });

  it('prunes the summary cache to the traces still in the store', () => {
    run(store, {});
    assert.strictEqual(summaryCache.size, 33);
    const small = new TelemetryStore();
    addDistributedTrace(small);
    run(small, {});
    assert.strictEqual(summaryCache.size, 1);
  });
});
