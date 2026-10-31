// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Instance, LIVE_REALM, TelemetryStore } from '../../src/store/store';
import {
  CardinalityEvaluator,
  CardinalityOverview,
  STATUS_SERVICES,
  TOOLTIP_FINDINGS,
  decorationBadge,
  decorationTooltip,
  emptyOverview,
  evaluateOverview,
  instanceKey,
  serviceKey,
  tooltipMarkdown,
} from '../../src/views/cardinalityEvaluator';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { T0, addSpans, span } from './aiFixtures';

const S = DEFAULT_CARDINALITY_SETTINGS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const users = (service: string, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => span({ ...ids(from + i), name: 'GET /u', startMs: T0 + i, attrs: { 'user.id': uuid(from + i), [`${service}.k`]: 'x' } }));

function store(): TelemetryStore {
  const s = new TelemetryStore();
  addSpans(s, 'api', users('api', 30), 'i1');
  addSpans(s, 'api', users('api', 30, 30), 'i2');
  addSpans(s, 'quiet', [span({ ...ids(900), name: 'GET /' })]);
  s.importSession({ sourceLabel: 'old.json', traces: [{ resource: { serviceName: 'api', attrs: {} }, spans: users('api', 25, 2000) }], logs: [], metrics: [] });
  return s;
}

describe('cardinality evaluator: overview', () => {
  it('summarises findings per service within its realm and per instance', () => {
    const s = store();
    const o = evaluateOverview(s.getAllInstances(), S);
    const session = s.getImportedSessions()[0].session.id;
    const live = o.nodes.get(serviceKey(LIVE_REALM, 'api'))!;
    assert.deepStrictEqual([live.critical, live.warning, live.info], [0, 1, 0]);
    assert.deepStrictEqual(live.top, ['▲ user.id (span): ID-like values']);
    assert.ok(o.nodes.get(serviceKey(session, 'api')), 'loaded services are not merged with live ones');
    assert.ok(o.nodes.get(instanceKey('api::i1')) && o.nodes.get(instanceKey('api::i2')));
    assert.strictEqual(o.nodes.get(serviceKey(LIVE_REALM, 'quiet')), undefined);
    assert.deepStrictEqual([o.noisyServices, o.live.noisyServices, o.live.services, o.live.findings], [2, 1, ['api'], { critical: 0, warning: 1, info: 0 }]);
  });

  it('lists the most severe findings first and caps tooltips and status names', () => {
    const s = new TelemetryStore();
    for (let svc = 0; svc < STATUS_SERVICES + 2; svc++) {
      const attrs = (i: number) => Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`id${k}`, uuid(i * 10 + k)]));
      addSpans(s, `svc${svc}`, Array.from({ length: 30 }, (_, i) => span({ ...ids(svc * 1000 + i), name: 'x', attrs: attrs(i) })));
    }
    const o = evaluateOverview(s.getAllInstances(), S);
    const node = o.nodes.get(serviceKey(LIVE_REALM, 'svc0'))!;
    assert.strictEqual(node.warning, 7);
    assert.strictEqual(node.top.length, TOOLTIP_FINDINGS);
    assert.deepStrictEqual(o.live.services, ['svc0', 'svc1', 'svc2', 'svc3', 'svc4']);
    assert.strictEqual(o.live.noisyServices, STATUS_SERVICES + 2);
  });

  it('escapes untrusted names in tooltips and keeps badges to two characters', () => {
    const md = tooltipMarkdown({ critical: 1, warning: 0, info: 0, top: ['✖ [x](command:otel.clear) *y* <img src=x>: ID-like values'] });
    assert.ok(md.startsWith('**Cardinality:** 1 critical, 0 warning, 0 info'));
    assert.ok(!md.includes('](command:'), md);
    assert.ok(md.includes('\\[x\\]\\(command:otel\\.clear\\)') && md.includes('\\<img'), md);
    const n = (critical: number, warning: number) => ({ critical, warning, info: 3, top: [] });
    assert.deepStrictEqual([n(0, 0), n(1, 2), n(4, 6)].map(decorationBadge), [undefined, '3', '9+']);
    assert.strictEqual(decorationTooltip(n(1, 0)), 'Cardinality: 1 critical finding');
    assert.strictEqual(decorationTooltip(n(2, 3)), 'Cardinality: 2 critical, 3 warning findings');
  });
});

describe('cardinality evaluator: scheduling', () => {
  function fakeSource(instances: Instance[] = store().getAllInstances()) {
    const listeners = new Set<() => void>();
    return {
      enabled: true,
      listeners,
      fire: () => listeners.forEach((l) => l()),
      onDidChange: (l: () => void) => (listeners.add(l), { dispose: () => listeners.delete(l) }),
      getAllInstances: () => instances,
      isCardinalityEnabled(): boolean {
        return this.enabled;
      },
    };
  }

  function counting() {
    const calls = { n: 0 };
    const evaluate = (i: readonly Instance[], s: typeof S) => {
      calls.n++;
      return evaluateOverview(i, s);
    };
    return { calls, evaluate };
  }

  it('does no work until data changes, then at most once per interval', async () => {
    const src = fakeSource();
    const { calls, evaluate } = counting();
    const ev = new CardinalityEvaluator(src, () => S, { intervalMs: 100, evaluate });
    const seen: [CardinalityOverview, string[]][] = [];
    ev.onDidChange((o, keys) => seen.push([o, keys]));
    await sleep(150);
    assert.strictEqual(calls.n, 0, 'idle at start');
    for (let i = 0; i < 20; i++) src.fire();
    await sleep(20);
    assert.strictEqual(calls.n, 1, 'a burst runs once');
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0][1].includes(serviceKey(LIVE_REALM, 'api')));
    src.fire();
    src.fire();
    await sleep(40);
    assert.strictEqual(calls.n, 1, 'throttled within the interval');
    await sleep(100);
    assert.strictEqual(calls.n, 2);
    assert.strictEqual(seen.length, 1, 'unchanged results are not re-announced');
    ev.dispose();
  });

  it('skips evaluation while disabled and clears what was shown', async () => {
    const src = fakeSource();
    const { calls, evaluate } = counting();
    const ev = new CardinalityEvaluator(src, () => S, { intervalMs: 10, evaluate });
    const seen: string[][] = [];
    ev.onDidChange((_, keys) => seen.push(keys));
    src.fire();
    await sleep(30);
    assert.ok(ev.current.nodes.size > 0);
    src.enabled = false;
    src.fire();
    await sleep(30);
    assert.strictEqual(calls.n, 1, 'no evaluation while off');
    assert.deepStrictEqual(ev.current, emptyOverview());
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(new Set(seen[1]), new Set(seen[0]), 'every decorated key is cleared');
    ev.dispose();
  });

  it('re-evaluates when settings change and keeps notifying after a listener throws', async () => {
    const src = fakeSource();
    let settings = S;
    const ev = new CardinalityEvaluator(src, () => settings, { intervalMs: 10 });
    const seen: string[] = [];
    ev.onDidChange(() => {
      throw new Error('surface failed');
    });
    ev.onDidChange((o) => seen.push(o.nodes.get(serviceKey(LIVE_REALM, 'api'))!.top[0]));
    src.fire();
    await sleep(30);
    settings = { ...S, minDistinct: 10, minDistinctRatio: 0 };
    ev.invalidate();
    await sleep(30);
    assert.deepStrictEqual(seen, ['▲ user.id (span): ID-like values', '▲ user.id (span): Many unique values'], 'lower thresholds report R1');
    ev.dispose();
  });

  it('stops after dispose', async () => {
    const src = fakeSource();
    const { calls, evaluate } = counting();
    const ev = new CardinalityEvaluator(src, () => S, { intervalMs: 10, evaluate });
    src.fire();
    ev.dispose();
    src.fire();
    ev.invalidate();
    await sleep(40);
    assert.strictEqual(calls.n, 0);
    assert.strictEqual(src.listeners.size, 0);
  });
});
