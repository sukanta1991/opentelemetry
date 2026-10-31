// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Metric } from '../../src/store/model';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { DEFAULT_BASELINE_SETTINGS, compareToCurrent } from '../../src/views/baselineCompare';
import { buildBaselineReport } from '../../src/views/baselineReport';
import { VOLUME_CHANGE, captureCardinality, compareCardinality } from '../../src/views/cardinalityBaseline';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { CardinalitySummary, ServiceSummary, SummaryKey, SummaryMetric } from '../../src/views/cardinalitySummary';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';
import { apiCalls, capture, collectAll } from './baselineFixtures';

const S = DEFAULT_CARDINALITY_SETTINGS;
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

const vol = (count: number, proto: number) => ({ count, proto, json: proto * 2 });
const vols = (traces = 0, logs = 0, metrics = 0) => ({ traces: vol(traces, traces * 100), logs: vol(logs, logs * 50), metrics: vol(metrics, metrics * 20) });

function svc(service: string, p: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    service,
    totals: vols(),
    perMinute: vols(),
    observedMs: 60_000,
    spanNames: 1,
    templates: 0,
    keys: [],
    keysTruncated: false,
    metrics: [],
    metricsTruncated: false,
    ...p,
  };
}

const key = (name: string, distinct: number, p: Partial<SummaryKey> = {}): SummaryKey => ({
  scope: 'span',
  key: name,
  distinct,
  approx: false,
  occurrences: distinct,
  proto: distinct * 10,
  ...p,
});
const metric = (name: string, series: number, driver?: string): SummaryMetric => ({ name, series, approx: false, points: series, ...(driver ? { driver } : {}) });
const summary = (services: ServiceSummary[], truncated = false): CardinalitySummary => ({ fromMs: T0, toMs: T0 + 60_000, windowMinutes: 1, services, truncated });
const verdicts = (base: CardinalitySummary, cur: CardinalitySummary) =>
  compareCardinality(base, cur, S).changes.map((c) => [c.verdict, c.service, c.key, c.base ?? null, c.current ?? null]);

describe('cardinality baseline summary', () => {
  it('is undefined when nothing has been counted', () => {
    const store = new TelemetryStore();
    assert.strictEqual(captureCardinality(store.getAllInstances(), { realm: LIVE_REALM }), undefined);
    addSpans(store, 'a', [span({ ...ids(0), name: 'x', startMs: T0 })]);
    store.setCardinality(false);
    assert.strictEqual(captureCardinality(store.getAllInstances(), { realm: LIVE_REALM }), undefined);
  });

  it('summarises keys, metrics and volume per service without values or samples', () => {
    const store = new TelemetryStore();
    const spans = Array.from({ length: 100 }, (_, i) =>
      span({ ...ids(i), name: 'GET /users/{id}', startMs: T0 + i * 100, attrs: { 'user.id': uuid(i), tenant: 'acme' } })
    );
    addSpans(store, 'api', spans.slice(0, 60), 'i1');
    addSpans(store, 'api', spans.slice(60), 'i2');
    addLogs(store, 'worker', [log({ timeMs: T0, body: 'job secret-token-123 done', attrs: { 'job.id': 'j-1' } })]);
    const m: Metric = {
      name: 'http.requests',
      type: 'sum',
      monotonic: true,
      dataPoints: Array.from({ length: 30 }, (_, p) => ({ attrs: { route: `/r${p % 3}`, user: `u${p}` }, timeMs: T0 + p, value: p })),
    };
    store.ingestMetrics([{ resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} }, metrics: [m] }]);

    const sum = captureCardinality(store.getAllInstances(), { realm: LIVE_REALM })!;
    assert.deepStrictEqual(
      sum.services.map((s) => s.service),
      ['api', 'worker'],
      'largest service first'
    );
    const api = sum.services[0];
    assert.deepStrictEqual(
      api.keys.map((k) => [k.scope, k.key, k.distinct, k.occurrences, k.cls]),
      [
        ['span', 'user.id', 100, 100, 'uuid'],
        ['span', 'tenant', 1, 100, 'other'],
      ]
    );
    assert.deepStrictEqual(api.metrics.map((x) => [x.name, x.series, x.driver]), [['http.requests', 30, 'user']]);
    assert.strictEqual(api.totals.traces.count, 100);
    assert.strictEqual(api.totals.metrics.count, 30);
    assert.ok(api.perMinute.traces.count > 0);
    assert.strictEqual(api.spanNames, 1);
    assert.deepStrictEqual([api.keysTruncated, api.metricsTruncated, sum.truncated], [false, false, false]);
    assert.strictEqual(sum.services[1].keys[0].scope, 'log');
    assert.strictEqual(sum.services[1].templates, 1);
    assert.ok(sum.fromMs <= sum.toMs);

    const json = JSON.stringify(sum);
    for (const leaked of [uuid(7), 'acme', 'secret-token-123', 'j-1', '/r1', 'u3']) assert.ok(!json.includes(leaked), leaked);
  });

  it('keeps only the realm asked for', () => {
    const store = new TelemetryStore();
    addSpans(store, 'live', [span({ ...ids(0), name: 'x', startMs: T0 })]);
    const { sessionId } = store.importSession({
      sourceLabel: 's.json',
      traces: [{ resource: { serviceName: 'old', attrs: {} }, spans: [span({ ...ids(1), name: 'y', startMs: T0 })] }],
      logs: [],
      metrics: [],
    });
    assert.deepStrictEqual(captureCardinality(store.getAllInstances(), { realm: sessionId })!.services.map((s) => s.service), ['old']);
  });
});

describe('cardinality baseline comparison', () => {
  it('reports new, grown and resolved attributes', () => {
    const base = summary([
      svc('a', {
        keys: [
          key('user.id', 50, { cls: 'uuid' }),
          key('order.id', 30, { cls: 'numericId' }),
          key('cart', 400),
          key('gone', 300),
          key('steady', 1000),
          key('quiet', 5),
        ],
      }),
    ]);
    const cur = summary([
      svc('a', {
        keys: [
          key('user.id', 400, { cls: 'uuid' }),
          key('order.id', 40, { cls: 'numericId' }),
          key('cart', 400, { occurrences: 100_000 }),
          key('steady', 1500),
          key('quiet', 500),
          key('fresh', 200),
        ],
      }),
    ]);
    assert.deepStrictEqual(verdicts(base, cur), [
      ['new', 'a', 'quiet', 5, 500],
      ['new', 'a', 'fresh', null, 200],
      ['grown', 'a', 'user.id', 50, 400],
      ['resolved', 'a', 'cart', 400, 400],
      ['resolved', 'a', 'gone', 300, null],
    ]);
    const r = compareCardinality(base, cur, S);
    assert.deepStrictEqual(r.summary, { new: 2, grown: 1, resolved: 2 });
    assert.strictEqual(r.changes.find((c) => c.key === 'user.id')!.cls, 'uuid');
  });

  it('does not guess when a side was truncated', () => {
    const base = summary([svc('a', { keys: [key('gone', 300)], keysTruncated: true })]);
    const cur = summary([svc('a', { keys: [key('fresh', 300)], keysTruncated: true })]);
    assert.deepStrictEqual(verdicts(base, cur), [], 'absence may only mean the key was cut');
    const cutServices = compareCardinality(summary([], true), summary([svc('b', { keys: [key('x', 300)] })]), S);
    assert.deepStrictEqual([cutServices.changes.length, cutServices.addedServices], [0, []]);
    const cutCurrent = compareCardinality(summary([svc('gone')]), summary([], true), S);
    assert.deepStrictEqual(cutCurrent.missingServices, []);
  });

  it('reports metrics by series and keeps the driving label', () => {
    const base = summary([svc('m', { metrics: [metric('rpc', 100), metric('big', 600), metric('wide', 600)] })]);
    const cur = summary([svc('m', { metrics: [metric('rpc', 900, 'user'), metric('big', 2000, 'route'), metric('wide', 650)] })]);
    const r = compareCardinality(base, cur, S);
    assert.deepStrictEqual(
      r.changes.map((c) => [c.verdict, c.kind, c.signal, c.key, c.driver ?? null]),
      [
        ['new', 'metric', 'metrics', 'rpc', 'user'],
        ['grown', 'metric', 'metrics', 'big', 'route'],
      ]
    );
  });

  it('lists added and missing services and treats keys of new services as new', () => {
    const r = compareCardinality(summary([svc('old', { keys: [key('k', 300)] })]), summary([svc('new', { keys: [key('k', 300), key('q', 2)] })]), S);
    assert.deepStrictEqual([r.addedServices, r.missingServices], [['new'], ['old']]);
    assert.deepStrictEqual(
      r.changes.map((c) => [c.verdict, c.service, c.key]),
      [['new', 'new', 'k']],
      'a missing service is not "resolved"'
    );
  });

  it(`reports per-minute volume changes of at least ${VOLUME_CHANGE * 100}%`, () => {
    const base = summary([svc('a', { perMinute: vols(100, 10, 0) }), svc('b', { perMinute: vols(100, 0, 0) })]);
    const cur = summary([svc('a', { perMinute: vols(300, 11, 5) }), svc('b', { perMinute: vols(80, 0, 0) })]);
    const r = compareCardinality(base, cur, S);
    assert.deepStrictEqual(
      r.volume.map((v) => [v.service, v.signal, v.base, v.current, v.change]),
      [
        ['a', 'metrics', 0, 5, Infinity],
        ['a', 'traces', 100, 300, 2],
      ]
    );
    assert.deepStrictEqual([r.volume[1].baseBytes, r.volume[1].currentBytes], [10_000, 30_000]);
  });
});

describe('cardinality section of the baseline report', () => {
  const label = { name: 'main', createdMs: 0, sourceKind: 'mark' as const, sourceLabel: 'live' };
  const same = apiCalls(Array.from({ length: 40 }, (_, i) => ({ endMs: T0 + i * 100 })));
  const result = compareToCurrent(capture(same, { realm: 'other' }), collectAll(same), DEFAULT_BASELINE_SETTINGS);

  it('is omitted without counters and lists escaped changes with them', () => {
    const meta = { baseline: label, against: 'live calls', time: (ms: number) => `T${ms}` };
    assert.ok(!buildBaselineReport(result, meta).includes('### Cardinality'));
    const cardinality = compareCardinality(
      summary([svc('a|b', { perMinute: vols(100) })]),
      summary([svc('a|b', { perMinute: vols(200), keys: [key('user`id', 500, { cls: 'uuid' }), key('evt', 300, { scope: 'span.event' })], metrics: [metric('m', 900, 'user*')] })]),
      S
    );
    const text = buildBaselineReport(result, { ...meta, cardinality });
    assert.ok(text.includes('### Cardinality'), text);
    assert.ok(text.includes('**✚ 3 new · ⬆ 0 grown · ✔ 0 resolved**'), text);
    assert.ok(text.includes('| ✚ | a\\|b | m (metric, by user\\*) | – → 900 |'), text);
    assert.ok(text.includes('| ✚ | a\\|b | user\\`id (span) | – → 500 |'), text);
    assert.ok(text.includes('evt (span event)'), text);
    assert.ok(text.includes('| a\\|b | traces | 100 → 200 (+100%) | 9.8 KB → 19.5 KB |'), text);
    for (const line of text.split('\n').filter((l) => l.startsWith('| ✚'))) assert.strictEqual(line.split(/(?<!\\)\|/).length, 6, line);
    const capped = buildBaselineReport(result, { ...meta, cardinality }, 1);
    assert.ok(capped.includes('…and 2 more.'), capped);
  });
});
