// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { LIVE_REALM } from '../../src/store/store';
import { DEFAULT_BASELINE_SETTINGS } from '../../src/views/baselineCompare';
import {
  applyComparison,
  baselineInfo,
  buildComparedMap,
  buildSnapshotMap,
  compareDetails,
  snapshotDetails,
} from '../../src/views/baselineMap';
import { buildNodeDetails, buildServiceMap } from '../../src/views/serviceMapModel';
import { bucketEndMs } from '../../src/views/webview/serviceMapView';
import { T0 } from './aiFixtures';
import { Call, apiCalls, capture, storeWith } from './baselineFixtures';

const N = 40;
const API = 'svc:api';
const DB = 'db:postgresql:shop';
const calls = (n: number, f: (i: number) => Partial<Call>, from = 0): Call[] =>
  Array.from({ length: n }, (_, i) => ({ endMs: T0 + (from + i) * 100, ...f(i) }));
const OTHER = { realm: 'other' };
const label = { name: 'main', createdMs: 1, sourceKind: 'window' as const, sourceLabel: 'live' };

function compared(base: Call[], current: Call[], baseReq = OTHER, maxNodes?: number) {
  const snapshot = capture(apiCalls(base), baseReq);
  const tagged = storeWith(apiCalls(current, 10_000)).getAllTaggedSpans();
  return { snapshot, tagged, ...buildComparedMap(tagged, { range: 'all', maxNodes }, snapshot, DEFAULT_BASELINE_SETTINGS, LIVE_REALM) };
}

describe('baseline map', () => {
  it('attaches deltas and counts changed operations per node and edge', () => {
    const { model } = compared(
      calls(N, (i) => ({ route: i % 2 ? '/a' : '/b', dbMs: 4 + (i % 3) })),
      calls(N, (i) => ({ route: i % 2 ? '/a' : '/b', ms: 60 + (i % 3), dbMs: 40 + (i % 3) }))
    );
    const api = model.nodes.find((n) => n.id === API)!;
    assert.strictEqual(api.cmp?.verdict, 'regressed');
    assert.deepStrictEqual(api.opChanges, { regressed: 2, improved: 0 });
    const edge = model.edges.find((e) => e.target === DB)!;
    assert.deepStrictEqual(edge.cmp?.verdict, 'regressed');
    assert.deepStrictEqual(edge.cmp?.changed, ['p50', 'p95']);
    assert.deepStrictEqual(api.cmp, { verdict: 'regressed', p95: api.cmp!.p95, changed: ['p50', 'p95'] }, 'map deltas stay slim');
    assert.ok(api.cmp!.p95[1]! > api.cmp!.p95[0]!);
  });

  it('puts full deltas for the selected scope in the details', () => {
    const { model, comparison, tagged } = compared(
      calls(N, (i) => ({ dbMs: 4 + (i % 3) })),
      calls(N, (i) => ({ dbMs: 4 + (i % 3), dbCalls: 3 }))
    );
    const d = compareDetails(buildNodeDetails(tagged, model, { kind: 'edge', source: API, target: DB })!, comparison!, () => false);
    assert.deepStrictEqual([d.cmp?.verdict, d.cmp?.fanout?.base, d.cmp?.fanout?.current, d.cmp?.fanout?.change], ['regressed', 1, 3, 'regressed']);
    assert.deepStrictEqual(model.edges.find((e) => e.target === DB)!.cmp?.changed, ['fanout']);
  });

  it('adds baseline-only nodes and edges as ghosts, within the node cap', () => {
    const { model } = compared(
      calls(N, (i) => ({ dbMs: 4 + (i % 3) })),
      calls(N, () => ({}))
    );
    const db = model.nodes.find((n) => n.id === DB)!;
    assert.deepStrictEqual([db.ghost, db.cmp?.verdict, db.health, db.stats.count], [true, 'removed', 'idle', 0]);
    const edge = model.edges.find((e) => e.target === DB)!;
    assert.deepStrictEqual([edge.ghost, edge.cmp?.verdict], [true, 'removed']);

    const capped = compared(
      calls(N, (i) => ({ dbMs: 4 + (i % 3) })),
      calls(N, () => ({})),
      OTHER,
      1
    ).model;
    assert.deepStrictEqual(
      capped.nodes.map((n) => n.id),
      [API]
    );
    assert.strictEqual(capped.hiddenNodes, 1);
    assert.deepStrictEqual(capped.edges, []);
  });

  it('never re-adds nodes the cap hid from the current map', () => {
    const { model } = compared(
      calls(N, (i) => ({ dbMs: 4 + (i % 3) })),
      calls(N, (i) => ({ dbMs: 4 + (i % 3) })),
      OTHER,
      1
    );
    assert.deepStrictEqual(
      model.nodes.map((n) => [n.id, n.ghost]),
      [[API, undefined]]
    );
    assert.strictEqual(model.hiddenNodes, 1);
  });

  it('applies the cut-off only within the baseline realm, and waits for calls after it', () => {
    const before = apiCalls(calls(N, (i) => ({ dbMs: 4 + (i % 3) })));
    const store = storeWith(before);
    const snapshot = capture(before, { realm: LIVE_REALM });
    const tagged = store.getAllTaggedSpans();
    const waiting = buildComparedMap(tagged, { range: 'all' }, snapshot, DEFAULT_BASELINE_SETTINGS, LIVE_REALM);
    assert.strictEqual(waiting.comparison, null);
    assert.strictEqual(waiting.model.cutoffMs, snapshot.source.toMs);
    assert.strictEqual(waiting.model.nodes.find((n) => n.id === API)!.stats.count, 0);
    assert.strictEqual(waiting.model.partial, false);

    const other = buildComparedMap(tagged, { range: 'all' }, snapshot, DEFAULT_BASELINE_SETTINGS, 'session-1');
    assert.strictEqual(other.model.cutoffMs, undefined);
    assert.strictEqual(other.comparison?.keys.find((k) => k.target === API && !k.op)?.verdict, 'unchanged');
  });

  it('keeps details to calls after the cut-off', () => {
    const spans = apiCalls(calls(N, (i) => ({ ms: 10 + (i % 3) })));
    const tagged = storeWith(spans).getAllTaggedSpans();
    const cutoffMs = T0 + 1900;
    const model = buildServiceMap(tagged, { range: 'all', cutoffMs });
    assert.strictEqual(model.nodes[0].stats.count, 20);
    const d = buildNodeDetails(tagged, model, { kind: 'node', id: API })!;
    assert.strictEqual(d.operations[0].count, 20);
    assert.ok(d.slowTraces.every((t) => t.startMs + t.durationMs > cutoffMs));
  });

  it('lists compared operations most significant first, including vanished ones', () => {
    const { model, comparison, tagged } = compared(
      calls(N * 2, (i) => ({ route: ['/a', '/b', '/gone', '/same'][i % 4], ms: 10 + (i % 3) })),
      calls(N * 2, (i) => ({ route: ['/a', '/b', '/new', '/same'][i % 4], ms: (i % 4 === 0 ? 60 : i % 4 === 1 ? 2 : 10) + (i % 3) }))
    );
    const base = buildNodeDetails(tagged, model, { kind: 'node', id: API })!;
    const d = compareDetails(base, comparison!, () => false);
    assert.deepStrictEqual(
      d.operations.map((o) => [o.name, o.cmp?.verdict, o.count]),
      [
        ['GET /a', 'regressed', 20],
        ['GET /b', 'improved', 20],
        ['GET /new', 'new', 20],
        ['GET /gone', 'removed', 0],
        ['GET /same', 'unchanged', 20],
      ]
    );
    assert.deepStrictEqual(compareDetails(base, comparison!, () => false, { operations: 2, traces: 5, sources: 10 }).operations.length, 2);
  });

  it('offers only baseline example traces that are still in the store', () => {
    const { model, comparison, tagged, snapshot } = compared(calls(N, () => ({})), calls(N, () => ({})));
    const exemplars = snapshot.entries.find((e) => e.target === API && !e.op)!.exemplars;
    const d = compareDetails(buildNodeDetails(tagged, model, { kind: 'node', id: API })!, comparison!, (id) => id === exemplars[0]);
    assert.deepStrictEqual(d.baselineTraces, [exemplars[0]]);
  });

  it('builds a read-only map of one snapshot against another', () => {
    const a = capture(apiCalls(calls(N, (i) => ({ dbMs: 4 + (i % 3) }))), OTHER);
    const b = capture(apiCalls(calls(N, (i) => ({ ms: 60 + (i % 3) }))), OTHER);
    const { model, comparison } = buildSnapshotMap(a, b, DEFAULT_BASELINE_SETTINGS);
    assert.deepStrictEqual([model.range, model.partial, model.anchorMs], ['all', false, b.source.toMs]);
    const api = model.nodes.find((n) => n.id === API)!;
    assert.deepStrictEqual([api.stats.count, api.stats.p50, api.cmp?.verdict, api.health], [N, 61, 'regressed', 'ok']);
    assert.strictEqual(model.nodes.find((n) => n.id === DB)?.ghost, true);
    const d = snapshotDetails(model, comparison!, { kind: 'node', id: API }, () => true)!;
    assert.deepStrictEqual([d.operations[0].name, d.slowTraces, d.sources, d.instanceIds], ['GET /a', [], [], []]);
    assert.strictEqual(snapshotDetails(model, comparison!, { kind: 'node', id: 'svc:nope' }, () => true), undefined);
  });

  it('summarises nodes and edges only, and marks waiting maps', () => {
    const { comparison, snapshot } = compared(
      calls(N, (i) => ({ route: i % 2 ? '/a' : '/b', dbMs: 4 + (i % 3) })),
      calls(N, (i) => ({ route: i % 2 ? '/a' : '/b', ms: 60 + (i % 3), dbMs: 4 + (i % 3) }))
    );
    const info = baselineInfo(label, snapshot, comparison, { cutoffMs: 5, against: 'b' });
    assert.deepStrictEqual(info.summary, { regressed: 1, improved: 0, unchanged: 2, insufficient: 0, new: 0, removed: 0, untracked: 0 });
    assert.deepStrictEqual([info.name, info.cutoffMs, info.against, info.waiting, info.truncated], ['main', 5, 'b', false, false]);
    const waiting = baselineInfo(label, snapshot, null);
    assert.deepStrictEqual([waiting.waiting, waiting.summary, waiting.coverage, 'cutoffMs' in waiting], [true, null, null, false]);
  });

  it('maps a sparkline bucket to the end of its slice of the window', () => {
    const model = buildServiceMap(storeWith(apiCalls(calls(N, () => ({})))).getAllTaggedSpans(), { range: 'all' });
    assert.strictEqual(bucketEndMs(model, 29), model.fromMs + model.effectiveWindowMs);
    assert.strictEqual(bucketEndMs(model, 0), model.fromMs + model.effectiveWindowMs / 30);
  });

  it('leaves the model untouched when nothing compares', () => {
    const model = buildServiceMap(storeWith(apiCalls(calls(N, () => ({})))).getAllTaggedSpans(), { range: 'all' });
    const out = applyComparison(model, { keys: [], summary: { regressed: 0, improved: 0, unchanged: 0, insufficient: 0, new: 0, removed: 0, untracked: 0 }, coverage: { currentNodes: 0, missingFromBase: 0, ratio: 0, warn: false }, nodes: [] });
    assert.deepStrictEqual(out, model);
  });
});
