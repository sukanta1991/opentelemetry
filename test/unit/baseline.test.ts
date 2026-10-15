// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { DEFAULT_SNAPSHOT_CAPS, Snapshot, SnapshotEntry, captureSnapshot, thinSamples } from '../../src/views/baseline';
import { buildServiceMap } from '../../src/views/serviceMapModel';
import { T0, addDistributedTrace, addFailingTrace, span } from './aiFixtures';
import { LIVE, apiCalls, capture, sid, tid } from './baselineFixtures';

const find = (s: Snapshot, target: string, source?: string, op?: string): SnapshotEntry => {
  const e = s.entries.find((x) => x.target === target && x.source === source && x.op === op);
  assert.ok(e, `missing entry ${source ?? ''} -> ${target} ${op ?? ''}`);
  return e;
};

describe('baseline snapshots', () => {
  it('returns an empty snapshot for no spans', () => {
    assert.deepStrictEqual(captureSnapshot([], LIVE), {
      source: { kind: 'window', label: 'test', realm: LIVE_REALM, fromMs: 0, toMs: 0 },
      nodes: [],
      entries: [],
      truncated: false,
    });
  });

  it('captures the same node and edge stats as the map', () => {
    const store = new TelemetryStore();
    for (let i = 0; i < 6; i++) addDistributedTrace(store, tid(100 + i), T0 + i * 1000, 100 + i * 50);
    addFailingTrace(store);
    const tagged = store.getAllTaggedSpans();
    const model = buildServiceMap(tagged, { range: 'all' });
    const snap = captureSnapshot(tagged, LIVE);
    const pick = ({ count, errors, p50, p95 }: { count: number; errors: number; p50: number | null; p95: number | null }) => ({
      count,
      errors,
      p50,
      p95,
    });
    for (const n of model.nodes.filter((x) => x.stats.count)) assert.deepStrictEqual(pick(find(snap, n.id)), pick(n.stats), n.id);
    for (const e of model.edges.filter((x) => x.stats.count)) {
      assert.deepStrictEqual(pick(find(snap, e.target, e.source)), pick(e.stats), `${e.source}->${e.target}`);
    }
    assert.deepStrictEqual(
      snap.nodes.map((n) => [n.id, n.label, n.type]),
      [
        ['db:postgresql:shop', 'postgresql: shop', 'database'],
        ['ext:api.payments.local', 'api.payments.local', 'external'],
        ['svc:checkout', 'checkout', 'service'],
        ['svc:frontend', 'frontend', 'service'],
      ]
    );
  });

  it('adds operations per node and per edge, named by operationKey', () => {
    const snap = capture(apiCalls([{ endMs: T0, route: '/a', dbMs: 4 }, { endMs: T0 + 1, route: '/b', dbMs: 6 }, { endMs: T0 + 2, route: '/b' }]));
    assert.deepStrictEqual(
      snap.entries.map((e) => [e.source ?? '', e.target, e.op ?? '', e.count]),
      [
        ['', 'db:postgresql:shop', '', 2],
        ['', 'db:postgresql:shop', 'SELECT orders', 2],
        ['', 'svc:api', '', 3],
        ['', 'svc:api', 'GET /a', 1],
        ['', 'svc:api', 'GET /b', 2],
        ['svc:api', 'db:postgresql:shop', '', 2],
        ['svc:api', 'db:postgresql:shop', 'SELECT orders', 2],
      ]
    );
  });

  it('counts spans ending inside [fromMs, toMs], both ends inclusive, and clamps to the data', () => {
    const spans = apiCalls([{ endMs: T0 }, { endMs: T0 + 1000 }, { endMs: T0 + 2000 }, { endMs: T0 + 3000 }]);
    const snap = capture(spans, { fromMs: T0 + 1000, toMs: T0 + 2000 });
    assert.strictEqual(find(snap, 'svc:api').count, 2);
    assert.deepStrictEqual([snap.source.fromMs, snap.source.toMs], [T0 + 1000, T0 + 2000]);
    const all = capture(spans, { fromMs: 0, toMs: T0 + 99_000 });
    assert.strictEqual(find(all, 'svc:api').count, 4);
    assert.deepStrictEqual([all.source.fromMs, all.source.toMs], [T0 - 10, T0 + 3000]);
    assert.strictEqual(capture(spans, { fromMs: T0 + 5000 }).entries.length, 0);
  });

  it('thins samples to evenly spaced quantiles, deterministically', () => {
    const calls = Array.from({ length: 5000 }, (_, i) => ({ endMs: T0 + i, ms: ((i * 7919) % 997) + 0.12345 }));
    const a = capture(apiCalls(calls));
    const b = capture(apiCalls(calls));
    const { samples, count, p50 } = find(a, 'svc:api');
    assert.strictEqual(count, 5000);
    assert.strictEqual(samples.length, DEFAULT_SNAPSHOT_CAPS.samplesPerKey);
    assert.strictEqual(samples[0], 0.12);
    assert.strictEqual(samples[samples.length - 1], 996.12);
    assert.ok(samples.every((v, i) => i === 0 || v >= samples[i - 1]));
    assert.ok(samples.every((v) => Math.round(v * 100) / 100 === v));
    assert.ok(Math.abs(samples[Math.floor(samples.length / 2)] - p50!) < 2);
    assert.deepStrictEqual(a, b);
  });

  it('keeps small samples whole and rounds them', () => {
    assert.deepStrictEqual(thinSamples(Float64Array.from([1.234, 2.345, 3.456]), 10), [1.23, 2.35, 3.46]);
    assert.deepStrictEqual(thinSamples(Float64Array.from([1, 2, 3, 4, 5]), 3), [1, 3, 5]);
    assert.deepStrictEqual(thinSamples(new Float64Array(0), 10), []);
  });

  it('counts calls with non-finite durations but keeps them out of samples', () => {
    const spans = apiCalls([{ endMs: T0, ms: 5 }, { endMs: T0 + 1, ms: 7 }]);
    spans.push(span({ traceId: tid(50), spanId: sid(0), kind: 'SERVER', startMs: T0, endMs: T0 + 2, durationMs: Number.NaN }));
    const e = find(capture(spans), 'svc:api');
    assert.strictEqual(e.count, 3);
    assert.deepStrictEqual(e.samples, [5, 7]);
  });

  it('keeps the busiest operations per scope and flags the scope', () => {
    const calls = ['/a', '/a', '/a', '/b', '/b', '/c'].map((route, i) => ({ endMs: T0 + i, route }));
    const snap = capture(apiCalls(calls), {}, { ...DEFAULT_SNAPSHOT_CAPS, opsPerScope: 2 });
    assert.strictEqual(find(snap, 'svc:api').opsTruncated, true);
    assert.deepStrictEqual(
      snap.entries.filter((e) => e.op).map((e) => e.op),
      ['GET /a', 'GET /b']
    );
    assert.strictEqual(capture(apiCalls(calls)).entries.some((e) => e.opsTruncated), false);
  });

  it('applies the key cap to operations first, then to the quietest nodes and edges', () => {
    const calls = Array.from({ length: 4 }, (_, i) => ({ endMs: T0 + i, dbMs: 1 }));
    const scopesOnly = capture(apiCalls(calls), {}, { ...DEFAULT_SNAPSHOT_CAPS, keys: 3 });
    assert.strictEqual(scopesOnly.truncated, false);
    assert.deepStrictEqual(
      scopesOnly.entries.map((e) => [e.source ?? '', e.target, e.op ?? '', e.opsTruncated ?? false]),
      [
        ['', 'db:postgresql:shop', '', true],
        ['', 'svc:api', '', true],
        ['svc:api', 'db:postgresql:shop', '', true],
      ]
    );
    const two = capture(apiCalls(calls), {}, { ...DEFAULT_SNAPSHOT_CAPS, keys: 2 });
    assert.strictEqual(two.truncated, true);
    assert.strictEqual(two.entries.length, 2);
  });

  it('scales the per-key sample cap to the total budget, with a floor', () => {
    const calls = Array.from({ length: 50 }, (_, i) => ({ endMs: T0 + i, ms: i + 1, dbMs: i + 1 }));
    const caps = { ...DEFAULT_SNAPSHOT_CAPS, totalSamples: 60, minSamplesPerKey: 4 };
    const snap = capture(apiCalls(calls), {}, caps);
    const perKey = Math.floor(60 / snap.entries.length);
    assert.ok(snap.entries.every((e) => e.samples.length === perKey), JSON.stringify(snap.entries.map((e) => e.samples.length)));
    const floored = capture(apiCalls(calls), {}, { ...caps, totalSamples: 1 });
    assert.ok(floored.entries.every((e) => e.samples.length === 4));
  });

  it('keeps the slowest and the latest failing trace as exemplars', () => {
    const snap = capture(
      apiCalls([
        { endMs: T0, ms: 50, error: true },
        { endMs: T0 + 1, ms: 90 },
        { endMs: T0 + 2, ms: 10, error: true },
        { endMs: T0 + 3, ms: 20 },
      ])
    );
    assert.deepStrictEqual(find(snap, 'svc:api').exemplars, [tid(1), tid(2)]);
    const same = capture(apiCalls([{ endMs: T0, ms: 90, error: true }, { endMs: T0 + 1, ms: 5 }]));
    assert.deepStrictEqual(find(same, 'svc:api').exemplars, [tid(0)]);
    const healthy = capture(apiCalls([{ endMs: T0, ms: 9 }]));
    assert.deepStrictEqual(find(healthy, 'svc:api').exemplars, [tid(0)]);
  });
});
