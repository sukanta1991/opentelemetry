// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { BUCKETS, LIVE_BUCKET_MS } from '../../src/store/cardinality/tracker';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { DEFAULT_CARDINALITY_SETTINGS, growthOf } from '../../src/views/cardinalityRules';
import { MAX_ROWS, buildCardinalityModel, dailyUsage, findingsFor, scopeInstances } from '../../src/views/cardinalityModel';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';

const S = DEFAULT_CARDINALITY_SETTINGS;
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

function users(from: number, to: number, extra: (i: number) => Record<string, string> = () => ({})) {
  return Array.from({ length: to - from }, (_, j) => {
    const i = from + j;
    return span({ ...ids(i), name: 'GET /users/{id}', startMs: T0 + i * 1000, attrs: { 'user.id': uuid(i), tenant: 'acme', ...extra(i) } });
  });
}

describe('cardinality model', () => {
  let store: TelemetryStore;
  let sessionId: string;

  beforeEach(() => {
    store = new TelemetryStore();
    addSpans(store, 'a', users(0, 60), 'i1');
    addSpans(store, 'a', users(30, 90), 'i2');
    addSpans(store, 'b', users(0, 10), 'i1');
    ({ sessionId } = store.importSession({
      sourceLabel: 'c.json',
      traces: [{ resource: { serviceName: 'c', attrs: {} }, spans: users(0, 5) }],
      logs: [],
      metrics: [],
    }));
  });

  it('filters by realm, service and instance', () => {
    const all = store.getAllInstances();
    const svc = (scope: Parameters<typeof scopeInstances>[1]) => [...new Set(scopeInstances(all, scope).map((i) => i.serviceName))].sort();
    assert.deepStrictEqual(svc({ realm: LIVE_REALM }), ['a', 'b']);
    assert.deepStrictEqual(svc({ realm: LIVE_REALM, service: 'a' }), ['a']);
    assert.deepStrictEqual(scopeInstances(all, { realm: LIVE_REALM, instanceId: 'a::i2' }).map((i) => i.id), ['a::i2']);
    assert.deepStrictEqual(svc({ realm: sessionId }), ['c']);
    store.setCardinality(false);
    assert.strictEqual(scopeInstances(store.getAllInstances(), { realm: LIVE_REALM }).length, 0, 'instances without counters are skipped');
  });

  it('merges instances of a service as a union of unique values', () => {
    const m = buildCardinalityModel(store.getAllInstances(), { realm: LIVE_REALM, service: 'a' }, S);
    const user = m.keys.find((k) => k.key === 'user.id')!;
    assert.deepStrictEqual([user.distinct, user.occurrences, user.approx], [90, 120, false]);
    assert.strictEqual(user.valueClass, 'uuid');
    assert.strictEqual(user.samples.length, 3);
    assert.strictEqual(new Set(user.samples).size, 3);
    assert.deepStrictEqual(m.services.map((s) => [s.service, s.instances]), [['a', 2]]);
    assert.strictEqual(m.services[0].totals.traces.count, 120);
    assert.strictEqual(m.totals.traces.count, 120);
    const tenant = m.keys.find((k) => k.key === 'tenant')!;
    assert.strictEqual(tenant.distinct, 1);
  });

  it('turns findings into per-service counts and matches findingsFor', () => {
    const m = buildCardinalityModel(store.getAllInstances(), { realm: LIVE_REALM }, S);
    assert.deepStrictEqual(
      m.findings.map((f) => [f.service, f.rule, f.key]),
      [['a', 'R2', 'user.id']]
    );
    assert.deepStrictEqual(m.services.find((s) => s.service === 'a')!.findings, { critical: 0, warning: 1, info: 0 });
    assert.deepStrictEqual(m.services.find((s) => s.service === 'b')!.findings, { critical: 0, warning: 0, info: 0 });
    const live = scopeInstances(store.getAllInstances(), { realm: LIVE_REALM });
    assert.deepStrictEqual(
      findingsFor(live, S)
        .map((f) => f.id)
        .sort(),
      m.findings.map((f) => f.id).sort()
    );
  });

  it('computes rates over the observed window and aligns buckets', () => {
    const s = new TelemetryStore();
    const start = T0 - (T0 % LIVE_BUCKET_MS);
    addLogs(s, 'svc', Array.from({ length: 50 }, (_, i) => log({ timeMs: start + i * 6000, body: `tick ${i}` })));
    const m = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM }, S);
    assert.strictEqual(m.windowMinutes, (49 * 6000) / 60_000);
    assert.ok(Math.abs(m.perMinute.logs.count - 50 / 4.9) < 1e-9);
    assert.strictEqual(m.buckets.logs.count.reduce((a, b) => a + b, 0), 50);
    assert.deepStrictEqual(m.buckets.logs.count.slice(BUCKETS - 5), [10, 10, 10, 10, 10]);
    assert.strictEqual(m.head, Math.floor((start + 49 * 6000) / LIVE_BUCKET_MS));
    const daily = dailyUsage(m);
    assert.ok(Math.abs(daily.logs - m.perMinute.logs.count * 1440) < 1e-6);
    assert.ok(Math.abs(daily.bytes.protobuf - (m.perMinute.traces.proto + m.perMinute.logs.proto + m.perMinute.metrics.proto) * 1440) < 1e-6);
    assert.strictEqual(daily.windowMinutes, 4.9);
    assert.strictEqual(m.services[0].perMinute.logs.count, m.perMinute.logs.count);
  });

  it('lists templates, span names and metrics with labels', () => {
    const s = new TelemetryStore();
    addLogs(s, 'svc', Array.from({ length: 120 }, (_, i) => log({ timeMs: T0 + i, body: `Cache miss for key ${i}` })));
    addSpans(s, 'svc', Array.from({ length: 30 }, (_, i) => span({ ...ids(i), name: `GET /users/${i}` })));
    s.ingestMetrics([
      {
        resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} },
        metrics: [
          {
            name: 'orders',
            type: 'sum',
            monotonic: true,
            dataPoints: Array.from({ length: 40 }, (_, i) => ({ attrs: { 'user.id': uuid(i), tenant: 'acme' }, timeMs: T0, value: i })),
          },
        ],
      },
    ]);
    const m = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM }, S);
    assert.deepStrictEqual(
      m.templates.map((t) => [t.text, t.count, t.share]),
      [['Cache miss for key <NUM>', 120, 1]]
    );
    assert.deepStrictEqual(
      m.spanNames.map((n) => [n.service, n.distinct, n.withIds]),
      [['svc', 30, 30]]
    );
    const orders = m.metrics[0];
    assert.deepStrictEqual([orders.name, orders.series, orders.points], ['orders', 40, 40]);
    assert.deepStrictEqual(
      orders.labels.map((l) => [l.key, l.distinct, l.valueClass]),
      [
        ['user.id', 40, 'uuid'],
        ['tenant', 1, 'other'],
      ]
    );
    assert.strictEqual(m.activeSeries, 40);
    assert.deepStrictEqual(
      m.findings.map((f) => f.rule).sort(),
      ['R2', 'R4', 'R6']
    );
  });

  it('caps rows and adds an (other) operation row', () => {
    const s = new TelemetryStore();
    for (const inst of ['i1', 'i2']) {
      addSpans(s, 'svc', Array.from({ length: 520 }, (_, i) => span({ ...ids(i), name: `op-${inst}-${i}` })), inst);
    }
    const m = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM }, S);
    assert.strictEqual(m.operations.length, MAX_ROWS);
    assert.strictEqual(m.rowsTruncated, true);
    const full = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM, instanceId: 'svc::i1' }, S);
    const other = full.operations.find((o) => o.other)!;
    assert.deepStrictEqual([other.name, other.count], ['(other)', 20]);
  });

  it('applies the output redactor to every sample', () => {
    const s = new TelemetryStore();
    addSpans(s, 'svc', users(0, 30));
    addLogs(s, 'svc', [log({ timeMs: T0, body: 'hello world' })]);
    const m = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM }, S, { redact: (k, t) => `<${k}|${t.length}>` });
    assert.ok(m.keys.every((k) => k.samples.every((x) => x.startsWith(`<${k.key}|`))));
    assert.ok(m.findings.every((f) => f.samples.every((x) => x.startsWith('<'))));
    assert.strictEqual(m.templates[0].sample, '<|11>');
  });

  it('gives findings the same growth as their aligned history, across idle instances and gaps', () => {
    const s = new TelemetryStore();
    const minute = (m: number, extra = 0) => T0 - (T0 % LIVE_BUCKET_MS) + m * LIVE_BUCKET_MS + extra;
    let n = 0;
    // growing: new values every minute; saturating: values stop after minute 4; idle: last data at minute 6.
    for (let m = 0; m < 12; m++) {
      const batch = [];
      for (let j = 0; j < 30; j++) {
        batch.push(span({ ...ids(n++), startMs: minute(m, j), attrs: { growing: `g${m}-${j}`, saturating: `s${Math.min(m, 4)}-${j}` } }));
      }
      addSpans(s, 'busy', batch);
      if (m === 1 || m === 3 || m === 6) addSpans(s, 'idle', users(m * 40, m * 40 + 40).map((x) => ({ ...x, startMs: minute(m, 1) })));
    }
    const m = buildCardinalityModel(s.getAllInstances(), { realm: LIVE_REALM }, S);
    assert.ok(m.findings.length >= 3);
    for (const f of m.findings.filter((x) => x.kind === 'attribute')) {
      const row = m.keys.find((k) => k.service === f.service && k.key === f.key)!;
      assert.strictEqual(f.growth, growthOf(row.history), `${f.service} ${f.key}`);
    }
    const growth = (svc: string, key: string) => m.findings.find((f) => f.service === svc && f.key === key)!.growth;
    assert.strictEqual(growth('busy', 'growing'), 'growing');
    assert.strictEqual(growth('busy', 'saturating'), 'saturated');
  });

  it('handles an empty scope', () => {
    const m = buildCardinalityModel([], { realm: LIVE_REALM }, S);
    assert.strictEqual(m.head, -Infinity);
    assert.strictEqual(m.windowMinutes, 0);
    assert.deepStrictEqual([m.services, m.keys, m.metrics, m.operations, m.templates, m.findings], [[], [], [], [], [], []]);
    assert.deepStrictEqual(m.perMinute.traces, { count: 0, proto: 0, json: 0 });
    assert.strictEqual(dailyUsage(m).spans, 0);
  });

  it('rates imported sessions over their last bucket', () => {
    const s = new TelemetryStore();
    const resource = { serviceName: 'imp', attrs: {} };
    const hours = 6;
    const { sessionId: id } = s.importSession({
      sourceLabel: 'long.json',
      traces: [{ resource, spans: Array.from({ length: 361 }, (_, i) => span({ ...ids(i), startMs: T0 + i * 60_000 })) }],
      logs: [],
      metrics: [],
    });
    const m = buildCardinalityModel(s.getAllInstances(), { realm: id }, S);
    assert.ok(m.bucketMs > LIVE_BUCKET_MS);
    // The 15-minute window spans as many whole (wider) buckets as it needs.
    const buckets = Math.ceil((15 * 60_000) / m.bucketMs);
    assert.ok(m.windowMinutes > 0 && m.windowMinutes <= (buckets * m.bucketMs) / 60_000);
    assert.ok(Math.abs(m.perMinute.traces.count - 1) < 0.2, `${m.perMinute.traces.count} spans/min over ${hours} h`);
  });
});
