// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Metric } from '../../src/store/model';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { captureCardinality } from '../../src/views/cardinalityBaseline';
import { DEFAULT_PRICING } from '../../src/views/cardinalityCost';
import { buildCardinalityModel } from '../../src/views/cardinalityModel';
import {
  MAX_OTHER_SERVICES,
  MAX_TABLE_TEXT,
  OVERVIEW_OPERATIONS,
  baselineView,
  detailTables,
  detailsOf,
  findingView,
  pricingView,
  summaryOf,
  tabData,
} from '../../src/views/cardinalityPayload';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { TABS } from '../../src/views/webview/cardinalityView';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';

const S = DEFAULT_CARDINALITY_SETTINGS;
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fixture(): TelemetryStore {
  const store = new TelemetryStore();
  const spans = (svc: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      span({ ...ids(i), name: i % 2 ? `GET /orders/${1000 + i}` : 'GET /health', startMs: T0 + i * 1000, attrs: { 'user.id': uuid(i), tenant: 'acme', [`${svc}.only`]: 'x' } })
    );
  addSpans(store, 'api', spans('api', 60));
  addSpans(store, 'web', spans('web', 30));
  const longBody = `job ${'x'.repeat(600)} finished in <NUM> ms`;
  addLogs(
    store,
    'api',
    Array.from({ length: 120 }, (_, i) => log({ timeMs: T0 + i, body: i % 4 ? 'cache hit for key Bearer abcdefghijklmnop' : longBody }))
  );
  const metric: Metric = {
    name: 'http.requests',
    type: 'sum',
    monotonic: true,
    dataPoints: Array.from({ length: 40 }, (_, p) => ({ attrs: { route: `/r${p % 2}`, user: uuid(p) }, timeMs: T0 + p, value: p })),
  };
  store.ingestMetrics([{ resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} }, metrics: [metric] }]);
  return store;
}

describe('cardinality payload', () => {
  const store = fixture();
  const model = buildCardinalityModel(store.getAllInstances(), { realm: LIVE_REALM }, S);
  const sources = { pricing: () => pricingView(model, DEFAULT_PRICING, undefined), baseline: () => ({ state: 'none' as const }) };

  it('annotates model rows with the severity of their findings', () => {
    const user = model.keys.find((k) => k.service === 'api' && k.key === 'user.id')!;
    assert.strictEqual(user.severity, 'warning');
    assert.strictEqual(model.keys.find((k) => k.key === 'tenant')!.severity, undefined);
    assert.strictEqual(model.metrics[0].severity, 'critical', 'id-like metric label');
    assert.ok(model.spanNames.find((s) => s.service === 'api')!.severity);
  });

  it('summarises totals, findings and activity without samples', () => {
    const s = roundTrip(summaryOf(model));
    assert.strictEqual(s.totals.traces.count, 90);
    assert.strictEqual(s.services, 2);
    assert.strictEqual(s.findings.critical + s.findings.warning + s.findings.info, model.findingsTotal);
    assert.strictEqual(s.activity.traces.length, 60);
    assert.strictEqual(s.cost, undefined);
    assert.ok(s.firstMs !== null && s.lastMs !== null);
    const empty = summaryOf(buildCardinalityModel([], { realm: LIVE_REALM }, S));
    assert.deepStrictEqual([empty.firstMs, empty.lastMs], [null, null]);
  });

  it('sends slim rows per tab, with no samples, histories or hints', () => {
    for (const tab of TABS) {
      const data = tabData(tab, model, sources);
      assert.strictEqual(data.tab, tab);
      const json = JSON.stringify(data);
      for (const leaked of ['abcdefghijklmnop', uuid(3), '"samples"', '"history"', '"hint"']) assert.ok(!json.includes(leaked), `${tab}: ${leaked}`);
    }
    const overview = tabData('overview', model, sources) as any;
    assert.ok(overview.operations.length <= OVERVIEW_OPERATIONS);
    assert.strictEqual(overview.findings.length, model.findings.length);
    const logs = tabData('logs', model, sources) as any;
    assert.ok(logs.templates.every((t: any) => t.text.length <= MAX_TABLE_TEXT));
    assert.ok(logs.templates.some((t: any) => t.text.endsWith('…')));
    const metrics = tabData('metrics', model, sources) as any;
    assert.deepStrictEqual(metrics.metrics[0].driver, { key: 'user', distinct: 40, approx: false });
    assert.deepStrictEqual(detailTables(overview), { findings: model.findings.length });
    assert.deepStrictEqual(detailTables(tabData('pricing', model, sources)), {});
  });

  it('builds details for one row, with redacted samples and gaps as null', () => {
    const k = model.keys.findIndex((r) => r.service === 'api' && r.key === 'user.id');
    const key = roundTrip(detailsOf(model, 'keys', k)) as any;
    assert.strictEqual(key.kind, 'key');
    assert.strictEqual(key.samples.length, 3);
    assert.ok(key.hint);
    assert.strictEqual(key.history.length, 60);
    assert.ok(key.history.every((v: unknown) => v === null || typeof v === 'number'));
    assert.deepStrictEqual(key.others, [{ service: 'web', distinct: 30, approx: false }]);
    assert.ok(key.others.length <= MAX_OTHER_SERVICES);
    assert.deepStrictEqual(key.classes, [['uuid', 60]]);

    const m = detailsOf(model, 'metrics', 0) as any;
    assert.deepStrictEqual(m.labels.map((l: any) => l.key), ['user', 'route']);
    const t = model.templates.findIndex((r) => r.text.length > MAX_TABLE_TEXT);
    const tpl = detailsOf(model, 'templates', t) as any;
    assert.ok(tpl.row.text.length > MAX_TABLE_TEXT, 'details carry the full template');
    const cache = detailsOf(model, 'templates', model.templates.findIndex((r) => r.text.startsWith('cache'))) as any;
    assert.ok(!cache.sample.includes('abcdefghijklmnop'), cache.sample);
    const f = detailsOf(model, 'findings', 0) as any;
    assert.strictEqual(f.kind, 'finding');
    assert.deepStrictEqual(f.finding, findingView(model.findings[0], Infinity));
    assert.strictEqual(detailsOf(model, 'spanNames', 0)!.kind, 'spanNames');
    for (const table of ['findings', 'keys', 'metrics', 'templates', 'spanNames'] as const) {
      assert.strictEqual(detailsOf(model, table, 10_000), undefined, table);
    }
  });

  it('prices only with prices and reports overrides', () => {
    const none = pricingView(model, DEFAULT_PRICING, undefined);
    assert.deepStrictEqual([none.source, none.cost, none.overrides], ['settings', undefined, {}]);
    const priced = pricingView(model, DEFAULT_PRICING, { perMillionSpans: 2, bogus: 1 });
    assert.strictEqual(priced.source, 'workspace');
    assert.deepStrictEqual(priced.overrides, { perMillionSpans: 2 });
    assert.ok(priced.cost && priced.cost.lines.length === 1);
    assert.strictEqual(summaryOf(model, priced.cost).cost!.monthlyTotal, priced.cost.monthlyTotal);
  });

  it('compares the scope with a baseline, limited to the picked service', () => {
    const base = { name: 'main', createdMs: T0, summary: captureCardinality(fixture().getAllInstances(), { realm: LIVE_REALM })! };
    const grown = fixture();
    addSpans(grown, 'api', Array.from({ length: 300 }, (_, i) => span({ ...ids(1000 + i), name: 'GET /health', startMs: T0, attrs: { session: `s${i}` } })));
    addSpans(grown, 'batch', [span({ ...ids(5000), name: 'run', startMs: T0 })]);
    const all = baselineView(base, captureCardinality(grown.getAllInstances(), { realm: LIVE_REALM }), { realm: LIVE_REALM }, S) as any;
    assert.strictEqual(all.state, 'ready');
    assert.deepStrictEqual(
      all.changes.map((c: any) => [c.verdict, c.service, c.key]),
      [['new', 'api', 'session']]
    );
    assert.deepStrictEqual(all.addedServices, ['batch']);
    assert.ok(all.volume.some((v: any) => v.service === 'api' && v.signal === 'traces'));
    assert.ok(all.volume.every((v: any) => v.change === null || Number.isFinite(v.change)));
    const web = baselineView(base, captureCardinality(grown.getAllInstances(), { realm: LIVE_REALM, service: 'web' }), { realm: LIVE_REALM, service: 'web' }, S) as any;
    assert.deepStrictEqual([web.changes, web.missingServices], [[], []], 'other services are not "missing"');
    assert.deepStrictEqual(baselineView(base, undefined, { realm: LIVE_REALM }, S), { state: 'noData', name: 'main' });
  });
});
