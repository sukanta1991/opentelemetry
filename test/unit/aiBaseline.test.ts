// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { BaselineCandidate, BaselineLookup, compareBaseline, matchBaseline } from '../../src/ai/analysis/baseline';
import { AnalysisContext } from '../../src/ai/analysis/common';
import { createRedactor } from '../../src/ai/redact';
import { parseCompareBaselineInput } from '../../src/ai/toolInputs';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { Snapshot, captureSnapshot } from '../../src/views/baseline';
import { DEFAULT_BASELINE_SETTINGS } from '../../src/views/baselineCompare';
import { T0, addDistributedTrace, span } from './aiFixtures';

const tid = (i: number) => (i + 1).toString(16).padStart(32, '0');

function traces(n: number, dbMs: number, from = 0, store = new TelemetryStore(10, 10_000)): TelemetryStore {
  for (let i = 0; i < n; i++) addDistributedTrace(store, tid(from + i), T0 + (from + i) * 2000, dbMs + (i % 5));
  return store;
}

const snap = (store: TelemetryStore, realm = 'other'): Snapshot =>
  captureSnapshot(store.getAllTaggedSpans(), { kind: 'session', label: 'before.json', realm });

function candidate(id: string, name: string, p: Partial<BaselineCandidate> = {}): BaselineCandidate {
  return { id, name, createdMs: T0, sourceKind: 'session', sourceLabel: 'before.json', saved: true, active: false, ...p };
}

function run(store: TelemetryStore, raw: unknown, baselines?: BaselineLookup) {
  const parsed = parseCompareBaselineInput(raw, 25);
  assert.ok('value' in parsed, JSON.stringify(parsed));
  const ctx: AnalysisContext = { now: T0, redactor: createRedactor([]), maxItems: 25, baselines };
  return compareBaseline(store, parsed.value, ctx);
}

const lookup = (entries: [BaselineCandidate, Snapshot | undefined][]): BaselineLookup => ({
  list: entries.map(([c]) => c),
  bodies: new Map(entries.filter(([, s]) => s).map(([c, s]) => [c.id, s!])),
  settings: DEFAULT_BASELINE_SETTINGS,
});

describe('ai compareBaseline', () => {
  const before = snap(traces(30, 100));
  const live = traces(30, 800, 100);

  it('explains how to get a baseline when there is none, or none active', () => {
    assert.match(String(run(live, {}).result.error), /No baselines exist yet/);
    assert.match(String(run(live, {}, lookup([])).result.error), /No baselines exist yet/);
    const l = lookup([[candidate('a', 'main'), before]]);
    assert.match(String(run(live, {}, l).result.error), /no baseline is active; pass "baseline" with one of: main/);
    assert.match(String(run(live, { baseline: 'nope' }, l).result.error), /no baseline named "nope"; known baselines: main/);
    assert.match(String(run(live, { baseline: 'gone' }, lookup([[candidate('g', 'gone'), undefined]])).result.error), /could not be read/);
  });

  it('lists significant changes against live data, most significant first, with trace refs', () => {
    const out = run(live, {}, lookup([[candidate('a', 'main', { active: true }), before]]));
    const r = out.result as any;
    assert.deepStrictEqual(r.baseline.name, 'main');
    assert.deepStrictEqual(r.against, { kind: 'live', name: 'live' });
    assert.ok(r.summary.regressed > 0, JSON.stringify(r.summary));
    const db = r.changes.find((c: any) => c.kind === 'call' && c.to === 'postgresql: shop');
    assert.strictEqual(db.verdict, 'regressed');
    assert.strictEqual(db.from, 'checkout');
    assert.deepStrictEqual(db.calls, [30, 30]);
    assert.ok(db.p95Ms[1] > db.p95Ms[0] * 5);
    assert.ok(db.changed.includes('p95'));
    assert.ok(r.changes.every((c: any) => ['regressed', 'improved', 'new', 'removed'].includes(c.verdict)));
    assert.strictEqual(out.listKey, 'changes');
    assert.ok(out.refs.length > 0 && out.refs.every((x) => x.kind === 'trace' && live.findTraceInstances(x.traceId!).length));
  });

  it('filters by scope and honours the limit', () => {
    const l = lookup([[candidate('a', 'main', { active: true }), before]]);
    const kinds = (scope: string) => new Set((run(live, { scope }, l).result as any).changes.map((c: any) => c.kind));
    assert.deepStrictEqual([...kinds('services')], ['service']);
    assert.deepStrictEqual([...kinds('calls')], ['call']);
    assert.deepStrictEqual([...kinds('operations')], ['operation']);
    assert.strictEqual((run(live, { limit: 1 }, l).result as any).changes.length, 1);
  });

  it('compares two baselines, and treats against "current" as live data', () => {
    const after = snap(live, 'other2');
    const l = lookup([
      [candidate('a', 'main', { active: true }), before],
      [candidate('b', 'Feature', { createdMs: T0 + 1 }), after],
    ]);
    const r = run(live, { against: 'feature' }, l).result as any;
    assert.deepStrictEqual([r.against.kind, r.against.name], ['baseline', 'Feature']);
    assert.ok(r.summary.regressed > 0);
    assert.strictEqual((run(live, { against: 'CURRENT' }, l).result as any).against.kind, 'live');
    assert.match(String(run(live, { against: 'main' }, l).result.error), /different baseline/);
    assert.match(String(run(live, { against: 'x' }, l).result.error), /no baseline named "x"/);
  });

  it('compares with a loaded session by file name', () => {
    const store = traces(30, 100);
    const { sessionId } = store.importSession({
      sourceLabel: 'yesterday.json',
      traces: [
        {
          resource: { serviceName: 'legacy', attrs: {} },
          spans: Array.from({ length: 25 }, (_, i) => span({ traceId: tid(500 + i), spanId: 'a'.repeat(16), kind: 'SERVER', startMs: T0 + i, durationMs: 10 })),
        },
      ],
      logs: [],
      metrics: [],
    });
    const l = lookup([[candidate('a', 'main', { active: true }), before]]);
    const r = run(store, { session: 'Yesterday.json' }, l).result as any;
    assert.deepStrictEqual(r.against, { kind: 'session', name: 'yesterday.json' });
    assert.ok(r.changes.some((c: any) => c.service === 'legacy' && c.verdict === 'new'));
    assert.ok(r.changes.some((c: any) => c.service === 'checkout' && c.verdict === 'removed'));
    assert.match(String(run(store, { session: 'nope' }, l).result.error), /loaded sessions: yesterday.json/);
    assert.ok(sessionId);
  });

  it('reports waiting when no calls arrived after a same-realm cut-off', () => {
    const store = traces(30, 100);
    const mark = snap(store, LIVE_REALM);
    const r = run(store, {}, lookup([[candidate('m', 'mark', { active: true }), mark]])).result as any;
    assert.strictEqual(r.waiting, true);
    assert.strictEqual(r.against.after, new Date(mark.source.toMs).toISOString());
  });

  it('matches baselines by id, then case-insensitive name, newest first', () => {
    const list = [candidate('1', 'Main'), candidate('2', 'main', { createdMs: T0 + 5 }), candidate('3', 'other')];
    assert.strictEqual(matchBaseline(list, '3')?.id, '3');
    assert.strictEqual(matchBaseline(list, 'MAIN')?.id, '2');
    assert.strictEqual(matchBaseline(list, 'mai'), undefined);
  });

  it('parses scope case-insensitively and rejects unknown scopes', () => {
    assert.deepStrictEqual(parseCompareBaselineInput({ scope: 'Calls' }, 25), {
      value: { baseline: undefined, against: undefined, session: undefined, scope: 'calls', limit: 25 },
    });
    assert.deepStrictEqual(parseCompareBaselineInput({ scope: 'edges' }, 25), { error: 'scope must be one of: all, services, calls, operations' });
  });
});
