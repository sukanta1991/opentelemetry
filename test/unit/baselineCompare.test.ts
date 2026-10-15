// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import {
  BaselineSettings,
  ComparisonResult,
  DEFAULT_BASELINE_SETTINGS,
  KeyComparison,
  SIGNIFICANCE,
  compareSnapshots,
  compareToCurrent,
  sanitizeBaselineSettings,
} from '../../src/views/baselineCompare';
import { DEFAULT_SNAPSHOT_CAPS } from '../../src/views/baseline';
import { collectCalls, prepare } from '../../src/views/serviceMapModel';
import { T0 } from './aiFixtures';
import { Call, apiCalls, capture, collectAll, storeWith } from './baselineFixtures';

const N = 60;
// Spread latencies so the rank test has a distribution to work with.
const calls = (n: number, f: (i: number) => Partial<Call>): Call[] =>
  Array.from({ length: n }, (_, i) => ({ endMs: T0 + i * 100, ...f(i) }));

function compare(base: Call[], current: Call[], settings: Partial<BaselineSettings> = {}, caps = DEFAULT_SNAPSHOT_CAPS): ComparisonResult {
  return compareToCurrent(capture(apiCalls(base), {}, caps), collectAll(apiCalls(current, 10_000)), {
    ...DEFAULT_BASELINE_SETTINGS,
    ...settings,
  });
}

const key = (r: ComparisonResult, target: string, source?: string, op?: string): KeyComparison => {
  const k = r.keys.find((x) => x.target === target && x.source === source && x.op === op);
  assert.ok(k, `missing key ${source ?? ''} -> ${target} ${op ?? ''}`);
  return k;
};
const API = 'svc:api';
const DB = 'db:postgresql:shop';

describe('baseline comparison', () => {
  describe('sanitizeBaselineSettings', () => {
    it('falls back to defaults for missing or non-numeric values', () => {
      assert.deepStrictEqual(sanitizeBaselineSettings(undefined), DEFAULT_BASELINE_SETTINGS);
      assert.deepStrictEqual(sanitizeBaselineSettings({ minSamples: '7', minLatencyChangeMs: Number.NaN, coverageWarnPct: null }), DEFAULT_BASELINE_SETTINGS);
    });

    it('clamps to each range and rounds the sample minimum', () => {
      assert.deepStrictEqual(
        sanitizeBaselineSettings({
          minSamples: 2.6,
          minLatencyChangePct: 5000,
          minLatencyChangeMs: -1,
          minErrorRateChangePp: 101,
          minFanoutChange: 0.5,
          coverageWarnPct: 150,
        }),
        {
          minSamples: 5,
          minLatencyChangePct: 1000,
          minLatencyChangeMs: 0,
          minErrorRateChangePp: 100,
          minFanoutChange: 0.5,
          coverageWarnPct: 100,
        }
      );
      assert.strictEqual(sanitizeBaselineSettings({ minSamples: 33.4 }).minSamples, 33);
    });
  });

  describe('latency', () => {
    it('flags a significant slowdown on the node, its operation and the edge', () => {
      const r = compare(
        calls(N, (i) => ({ ms: 10 + (i % 7), dbMs: 4 + (i % 3) })),
        calls(N, (i) => ({ ms: 40 + (i % 7), dbMs: 30 + (i % 3) }))
      );
      for (const k of [key(r, API), key(r, API, undefined, 'GET /a'), key(r, DB, API), key(r, DB, API, 'SELECT orders')]) {
        assert.strictEqual(k.verdict, 'regressed', JSON.stringify(k));
        assert.strictEqual(k.p50.change, 'regressed');
        assert.ok(k.p50.q! < SIGNIFICANCE);
        assert.ok(k.p50.delta! > 0);
      }
      assert.strictEqual(key(r, API).p50.delta, 30);
    });

    it('flags a significant speed-up as improved', () => {
      const r = compare(
        calls(N, (i) => ({ ms: 40 + (i % 7) })),
        calls(N, (i) => ({ ms: 10 + (i % 7) }))
      );
      assert.strictEqual(key(r, API).verdict, 'improved');
      assert.strictEqual(key(r, API).p50.change, 'improved');
    });

    it('catches a tail-only slowdown on p95 that a rank test misses', () => {
      const r = compare(
        calls(200, (i) => ({ ms: i % 20 === 0 ? 50 : 10 + (i % 3) })),
        calls(200, (i) => ({ ms: i % 5 === 0 ? 200 : 10 + (i % 3) }))
      );
      const k = key(r, API);
      assert.strictEqual(k.p50.change, 'unchanged');
      assert.strictEqual(k.p95.change, 'regressed');
      assert.ok(k.p95.q! < SIGNIFICANCE && k.p95.q !== k.p50.q, 'p95 has its own test');
      assert.strictEqual(k.verdict, 'regressed');
    });

    it('needs enough calls to call a tail improvement', () => {
      const tail = (n: number) =>
        compare(
          calls(n, (i) => ({ ms: i % 10 === 0 ? 80 : 10 + (i % 3) })),
          calls(n, (i) => ({ ms: i % 40 === 0 ? 80 : 10 + (i % 3) }))
        );
      assert.strictEqual(key(tail(N), API).p95.change, 'unchanged');
      assert.strictEqual(key(tail(400), API).p95.change, 'improved');
    });

    it('ignores significant shifts below the ms floor or the percent floor', () => {
      const belowMs = compare(
        calls(N, (i) => ({ ms: 10 + (i % 3) })),
        calls(N, (i) => ({ ms: 13 + (i % 3) }))
      );
      assert.ok(key(belowMs, API).p50.q! < SIGNIFICANCE);
      assert.strictEqual(key(belowMs, API).verdict, 'unchanged');
      const belowPct = compare(
        calls(N, (i) => ({ ms: 100 + (i % 3) })),
        calls(N, (i) => ({ ms: 110 + (i % 3) }))
      );
      assert.ok(key(belowPct, API).p50.q! < SIGNIFICANCE);
      assert.strictEqual(key(belowPct, API).verdict, 'unchanged');
      const lowered = compare(
        calls(N, (i) => ({ ms: 100 + (i % 3) })),
        calls(N, (i) => ({ ms: 110 + (i % 3) })),
        { minLatencyChangePct: 5 }
      );
      assert.strictEqual(key(lowered, API).verdict, 'regressed');
    });

    it('stays unchanged for the same distribution', () => {
      const same = calls(N, (i) => ({ ms: 10 + (i % 7) }));
      const r = compare(same, same);
      assert.strictEqual(key(r, API).verdict, 'unchanged');
      assert.strictEqual(key(r, API).p50.delta, 0);
    });
  });

  describe('errors', () => {
    it('flags a significant rise and fall in error rate', () => {
      const up = compare(
        calls(100, () => ({})),
        calls(100, (i) => ({ error: i % 5 === 0 }))
      );
      assert.strictEqual(key(up, API).errorRate.change, 'regressed');
      assert.strictEqual(key(up, API).verdict, 'regressed');
      assert.ok(Math.abs(key(up, API).errorRate.delta! - 0.2) < 1e-12);
      const down = compare(
        calls(100, (i) => ({ error: i % 5 === 0 })),
        calls(100, () => ({}))
      );
      assert.strictEqual(key(down, API).verdict, 'improved');
    });

    it('needs the percentage-point floor as well as significance', () => {
      const r = compare(
        calls(2000, () => ({})),
        calls(2000, (i) => ({ error: i % 100 === 0 })),
        {},
        DEFAULT_SNAPSHOT_CAPS
      );
      assert.ok(key(r, API).errorRate.q! < SIGNIFICANCE);
      assert.strictEqual(key(r, API).errorRate.change, 'unchanged');
    });

    it('lets the worse change win when latency improves but errors rise', () => {
      const r = compare(
        calls(100, (i) => ({ ms: 40 + (i % 7) })),
        calls(100, (i) => ({ ms: 10 + (i % 7), error: i % 4 === 0 }))
      );
      const k = key(r, API);
      assert.strictEqual(k.p50.change, 'improved');
      assert.strictEqual(k.errorRate.change, 'regressed');
      assert.strictEqual(k.verdict, 'regressed');
    });
  });

  describe('calls per request', () => {
    it('flags an N+1 on the edge without a significance test', () => {
      const r = compare(
        calls(N, (i) => ({ ms: 10 + (i % 7), dbMs: 3 })),
        calls(N, (i) => ({ ms: 10 + (i % 7), dbMs: 3, dbCalls: 3 }))
      );
      const edge = key(r, DB, API);
      assert.deepStrictEqual([edge.fanout!.base, edge.fanout!.current, edge.fanout!.change], [1, 3, 'regressed']);
      assert.strictEqual(edge.verdict, 'regressed');
      assert.strictEqual(key(r, API).fanout, undefined);
      assert.strictEqual(key(r, API).verdict, 'unchanged');
    });

    it('ignores changes below the floor', () => {
      const r = compare(
        calls(N, (i) => ({ dbMs: 3, dbCalls: i % 2 ? 1 : 2 })),
        calls(N, (i) => ({ dbMs: 3, dbCalls: i % 2 ? 2 : 2 }))
      );
      assert.strictEqual(key(r, DB, API).fanout!.change, 'unchanged');
    });
  });

  describe('states', () => {
    it('marks keys with too few calls on either side as insufficient, keeping deltas', () => {
      const r = compare(
        calls(10, () => ({ ms: 10 })),
        calls(10, () => ({ ms: 90 }))
      );
      const k = key(r, API);
      assert.strictEqual(k.verdict, 'insufficient');
      assert.strictEqual(k.p50.delta, 80);
      assert.strictEqual(k.p50.q, undefined);
      assert.strictEqual(compare(calls(10, () => ({})), calls(10, () => ({})), { minSamples: 5 }).keys[0].verdict, 'unchanged');
    });

    it('marks keys only in current as new and keys only in the baseline as removed', () => {
      const r = compare(
        calls(N, (i) => ({ dbMs: 3 + (i % 3) })),
        calls(N, (i) => ({ route: i % 2 ? '/a' : '/b' }))
      );
      assert.strictEqual(key(r, API, undefined, 'GET /b').verdict, 'new');
      assert.strictEqual(key(r, DB, API).verdict, 'removed');
      assert.strictEqual(key(r, DB).verdict, 'removed');
      assert.deepStrictEqual(key(r, DB).current, undefined);
      assert.ok(r.nodes.some((n) => n.id === DB), 'removed nodes stay drawable');
    });

    it('treats a vanished key with few baseline calls as insufficient', () => {
      const r = compare(
        calls(N, (i) => ({ dbMs: i < 3 ? 2 : undefined })),
        calls(N, () => ({}))
      );
      assert.strictEqual(key(r, DB, API).verdict, 'insufficient');
    });

    it('marks operations cut by the baseline caps as untracked, not new', () => {
      const base = calls(N, (i) => ({ route: i % 3 ? '/a' : '/b' }));
      const r = compare(base, calls(N, (i) => ({ route: i % 2 ? '/a' : '/c' })), {}, { ...DEFAULT_SNAPSHOT_CAPS, opsPerScope: 1 });
      assert.strictEqual(key(r, API, undefined, 'GET /c').verdict, 'untracked');
      assert.strictEqual(key(r, API, undefined, 'GET /a').verdict, 'unchanged');
    });

    it('marks nodes and edges missing from a truncated baseline as untracked', () => {
      const base = calls(N, (i) => ({ dbMs: 3 + (i % 3) }));
      const r = compare(base, base, {}, { ...DEFAULT_SNAPSHOT_CAPS, keys: 2 });
      assert.ok(r.keys.some((k) => k.verdict === 'untracked'));
      assert.strictEqual(r.summary.new, 0);
    });
  });

  describe('coverage', () => {
    // Current has api and db; the baseline only api, so half the current nodes are missing.
    const run = (coverageWarnPct: number) =>
      compare(
        calls(N, () => ({})),
        calls(N, () => ({ dbMs: 3 })),
        { coverageWarnPct }
      ).coverage;

    it('warns when the missing share reaches the threshold', () => {
      assert.deepStrictEqual(run(50), { currentNodes: 2, missingFromBase: 1, ratio: 0.5, warn: true });
      assert.strictEqual(run(51).warn, false);
      assert.strictEqual(run(0).warn, false);
      assert.strictEqual(run(30).warn, true);
    });
  });

  it('compares two snapshots the same way as snapshot vs current', () => {
    const base = calls(N, (i) => ({ ms: 10 + (i % 7), dbMs: 4 }));
    const cur = calls(N, (i) => ({ ms: 40 + (i % 7), dbMs: 4, dbCalls: 2 }));
    const live = compare(base, cur);
    const snaps = compareSnapshots(capture(apiCalls(base)), capture(apiCalls(cur, 10_000)), DEFAULT_BASELINE_SETTINGS);
    const verdicts = (r: ComparisonResult) => r.keys.map((k) => [k.source ?? '', k.target, k.op ?? '', k.verdict]);
    assert.deepStrictEqual(verdicts(snaps), verdicts(live));
  });

  it('orders keys deterministically and summarises every key once', () => {
    const r = compare(
      calls(N, (i) => ({ route: i % 2 ? '/b' : '/a', dbMs: 4 })),
      calls(N, (i) => ({ route: i % 2 ? '/c' : '/a', ms: 50, dbMs: 4 }))
    );
    assert.deepStrictEqual(
      r.keys.map((k) => [k.source ?? '', k.target, k.op ?? '']),
      [
        ['', DB, ''],
        ['', DB, 'SELECT orders'],
        ['', API, ''],
        ['', API, 'GET /a'],
        ['', API, 'GET /b'],
        ['', API, 'GET /c'],
        [API, DB, ''],
        [API, DB, 'SELECT orders'],
      ]
    );
    assert.strictEqual(
      Object.values(r.summary).reduce((a, b) => a + b, 0),
      r.keys.length
    );
  });

  it('keeps the current side strictly after the cut-off', () => {
    const spans = apiCalls(calls(10, () => ({})));
    const tagged = storeWith(spans).getAllTaggedSpans();
    const cutoff = T0 + 400;
    const snap = capture(spans, { toMs: cutoff });
    const current = collectCalls(tagged, prepare(tagged), { inWindow: (endMs) => endMs > snap.source.toMs, ops: true });
    const r = compareToCurrent(snap, current, { ...DEFAULT_BASELINE_SETTINGS, minSamples: 5 });
    assert.deepStrictEqual([key(r, API).base!.count, key(r, API).current!.count], [5, 5]);
  });
});
