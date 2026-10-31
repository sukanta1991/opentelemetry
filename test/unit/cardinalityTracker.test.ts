// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { CardinalityBudget, DEFAULT_CARDINALITY_CAPS, MAX_KEY_CHARS } from '../../src/store/cardinality/budget';
import { MAX_COUNTER_BYTES } from '../../src/store/cardinality/distinct';
import { DEFAULT_DRAIN_OPTIONS } from '../../src/store/cardinality/drain';
import { Size, logSize, metricSize, pointSize, requestSize, spanSize } from '../../src/store/cardinality/sizes';
import { BUCKETS, LIVE_BUCKET_MS, UsageTracker, bucketMsForRange } from '../../src/store/cardinality/tracker';
import { byScope } from '../../src/store/encode';
import { LogRecord, Metric, MetricDataPoint, ResourceInfo, Span } from '../../src/store/model';
import { T0, log, span } from './aiFixtures';

const RESOURCE: ResourceInfo = { serviceName: 'checkout', serviceInstanceId: 'i1', attrs: { 'host.name': 'box' } };
const SEED = 99;

const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const traceId = (i: number) => (i + 1).toString(16).padStart(32, '0');
const spanId = (i: number) => (i + 1).toString(16).padStart(16, '0');

function tracker(opts: Partial<ConstructorParameters<typeof UsageTracker>[0]> = {}): UsageTracker {
  return new UsageTracker({ budget: new CardinalityBudget(), seed: SEED, clock: () => T0, ...opts });
}

function spans(n: number, make: (i: number) => Partial<Span> = () => ({})): Span[] {
  return Array.from({ length: n }, (_, i) => span({ traceId: traceId(i), spanId: spanId(i), startMs: T0 + i, ...make(i) }));
}

const sum = (sizes: Size[]): Size => sizes.reduce((a, b) => ({ proto: a.proto + b.proto, json: a.json + b.json }), { proto: 0, json: 0 });

describe('UsageTracker', () => {
  describe('bytes', () => {
    it('totals each batch at its exact request size', () => {
      const t = tracker();
      const batch = spans(20, (i) => ({ attrs: { n: i, tenant: 'acme' }, scope: i % 2 ? '@a' : undefined }));
      t.addSpans(RESOURCE, batch);
      const groups = byScope(batch).map((g) => ({
        scope: (g.scope as { name?: string }).name,
        size: sum(g.items.map((s) => spanSize(s))),
        count: g.items.length,
      }));
      const expected = requestSize('traces', RESOURCE, groups);
      assert.deepStrictEqual(
        { proto: t.totals.traces.proto, json: t.totals.traces.json, count: t.totals.traces.count },
        { ...expected, count: 20 }
      );

      const logs: LogRecord[] = Array.from({ length: 5 }, (_, i) => log({ timeMs: T0 + i, body: `hello ${i}`, attrs: { k: i } }));
      t.addLogs(RESOURCE, logs);
      assert.strictEqual(
        t.totals.logs.proto,
        requestSize('logs', RESOURCE, [{ size: sum(logs.map((l) => logSize(l))), count: logs.length }]).proto
      );

      const metrics: Metric[] = [
        { name: 'm', type: 'gauge', dataPoints: [{ attrs: { a: 1 }, timeMs: T0, value: 1 }] },
        { name: 'u', type: 'unknown', dataPoints: [{ attrs: { a: 1 }, timeMs: T0, value: 1 }] },
      ];
      t.addMetrics(RESOURCE, metrics);
      const metricSizes = metrics.map((m) =>
        metricSize(m, m.type === 'unknown' ? { proto: 0, json: 0 } : sum(m.dataPoints.map((dp) => pointSize(m.type, dp))), m.type === 'unknown' ? 0 : m.dataPoints.length)
      );
      assert.deepStrictEqual(
        { proto: t.totals.metrics.proto, json: t.totals.metrics.json },
        requestSize('metrics', RESOURCE, [{ size: sum(metricSizes), count: 2 }])
      );
      assert.strictEqual(t.totals.metrics.count, 1, 'points of an unknown type are not counted');
    });

    it('skips spans without ids, like the store', () => {
      const t = tracker();
      t.addSpans(RESOURCE, [...spans(2), span({ traceId: '', spanId: spanId(9) })]);
      assert.strictEqual(t.totals.traces.count, 2);
    });
  });

  describe('attribute keys', () => {
    it('counts unique values, occurrences and bytes per key and scope', () => {
      const t = tracker();
      t.addSpans(
        RESOURCE,
        spans(100, (i) => ({
          attrs: { tenant: ['a', 'b', 'c'][i % 3], 'user.id': uuid(i) },
          events: [{ timeMs: T0, name: 'exception', attrs: { 'exception.type': 'Boom' } }],
          links: [{ traceId: traceId(1), spanId: spanId(1), attrs: { 'link.only': i } }],
        }))
      );
      const tenant = t.spanKeys.get('tenant')!;
      assert.strictEqual(tenant.distinct.estimate(), 3);
      assert.strictEqual(tenant.occurrences, 100);
      assert.ok(tenant.proto > 0 && tenant.json > tenant.proto);
      const user = t.spanKeys.get('user.id')!;
      assert.strictEqual(user.distinct.estimate(), 100);
      assert.strictEqual(user.classes.dominant(), 'uuid');
      assert.strictEqual(user.samples.length, DEFAULT_CARDINALITY_CAPS.samplesPerKey);
      assert.deepStrictEqual([...t.spanEventKeys.keys()], ['exception.type']);
      assert.ok(!t.spanKeys.has('link.only') && !t.spanEventKeys.has('link.only'));
      assert.strictEqual(t.trackedKeys, 3);
    });

    it('keeps redacted, truncated samples', () => {
      const t = tracker();
      const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(3000)}\n-----END PRIVATE KEY-----`;
      t.addSpans(
        RESOURCE,
        spans(1, () => ({
          attrs: {
            authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
            note: 'retry with token=supersecretvalue1234',
            long: 'x'.repeat(1000),
            key: pem,
            obj: { password: 'hunter2', ok: 1 },
          },
        }))
      );
      const sample = (k: string) => t.spanKeys.get(k)!.samples[0];
      assert.strictEqual(sample('authorization'), '[REDACTED]');
      assert.ok(sample('note').includes('[REDACTED]') && !sample('note').includes('supersecret'), sample('note'));
      assert.strictEqual(sample('long'), `${'x'.repeat(DEFAULT_CARDINALITY_CAPS.sampleChars)}…`);
      assert.ok(!sample('key').includes('AAAA'), sample('key'));
      assert.ok(!sample('obj').includes('hunter2'), sample('obj'));
    });

    it('drops keys beyond the per-instance cap or name length and counts them', () => {
      const t = tracker({ caps: { ...DEFAULT_CARDINALITY_CAPS, keysPerInstance: 2 } });
      t.addSpans(RESOURCE, spans(3, () => ({ attrs: { a: 1, b: 2, c: 3, ['k'.repeat(MAX_KEY_CHARS + 1)]: 4 } })));
      assert.deepStrictEqual([...t.spanKeys.keys()], ['a', 'b']);
      assert.strictEqual(t.droppedKeyOccurrences, 6);
    });

    it('treats prototype-named keys as plain keys', () => {
      const t = tracker();
      const attrs = JSON.parse('{"__proto__": "x", "constructor": "y"}');
      t.addSpans(RESOURCE, spans(2, () => ({ attrs })));
      assert.deepStrictEqual([...t.spanKeys.keys()].sort(), ['__proto__', 'constructor']);
      assert.strictEqual(t.spanKeys.get('__proto__')!.occurrences, 2);
    });

    it('shares the store-wide budget and releases it on dispose', () => {
      const budget = new CardinalityBudget({ keysTotal: 3, metricsTotal: 1, templatesTotal: 2 });
      const a = new UsageTracker({ budget, seed: SEED });
      const b = new UsageTracker({ budget, seed: SEED });
      a.addSpans(RESOURCE, spans(1, () => ({ attrs: { x: 1, y: 2 } })));
      b.addSpans(RESOURCE, spans(1, () => ({ attrs: { x: 1, y: 2 } })));
      assert.strictEqual(budget.keys.used, 3);
      assert.strictEqual(b.droppedKeyOccurrences, 1);
      b.addMetrics(RESOURCE, [{ name: 'm', type: 'gauge', dataPoints: [] }]);
      b.addLogs(RESOURCE, [log({ timeMs: T0, body: 'one' }), log({ timeMs: T0, body: 'two words' })]);
      assert.deepStrictEqual([budget.metrics.used, budget.templates.used], [1, 2]);
      a.dispose();
      assert.strictEqual(budget.keys.used, 1);
      b.dispose();
      b.dispose();
      assert.deepStrictEqual([budget.keys.used, budget.metrics.used, budget.templates.used], [0, 0, 0]);
      b.addSpans(RESOURCE, spans(1, () => ({ attrs: { z: 1 } })));
      assert.strictEqual(budget.keys.used, 0, 'a disposed tracker ignores new data');
    });
  });

  describe('spans', () => {
    it('ranks operations with errors and folds the rest into other at the cap', () => {
      const t = tracker({ caps: { ...DEFAULT_CARDINALITY_CAPS, operationsPerInstance: 2 } });
      t.addSpans(
        RESOURCE,
        spans(6, (i) => ({ name: ['GET /a', 'GET /b', 'GET /c'][i % 3], statusCode: i === 0 ? 'ERROR' : 'UNSET' }))
      );
      assert.deepStrictEqual(
        [...t.operations.entries()].map(([k, v]) => [k, v.count, v.errors]),
        [
          ['GET /a', 2, 1],
          ['GET /b', 2, 0],
        ]
      );
      assert.strictEqual(t.otherOperations.count, 2);
      assert.ok(t.otherOperations.proto > 0);
    });

    it('counts unique span names and those embedding ids', () => {
      const t = tracker();
      t.addSpans(RESOURCE, spans(30, (i) => ({ name: i < 20 ? `GET /users/${i}` : `op${i % 5}` })));
      assert.strictEqual(t.spanNames.estimate(), 25);
      assert.strictEqual(t.spanNamesClassified, 25);
      assert.strictEqual(t.spanNamesWithIds, 20);
      assert.deepStrictEqual(t.idNameSamples, ['GET /users/0', 'GET /users/1', 'GET /users/2']);
    });
  });

  describe('logs', () => {
    it('templates bodies and tracks log attributes', () => {
      const t = tracker();
      t.addLogs(
        RESOURCE,
        Array.from({ length: 10 }, (_, i) => log({ timeMs: T0 + i, body: `User ${i} logged in`, attrs: { 'user.id': uuid(i) } }))
      );
      const [tpl] = t.templates.templates();
      assert.strictEqual(tpl.text, 'User <NUM> logged in');
      assert.strictEqual(tpl.count, 10);
      assert.strictEqual(t.logKeys.get('user.id')!.distinct.estimate(), 10);
    });
  });

  describe('metrics', () => {
    const point = (attrs: MetricDataPoint['attrs'], i = 0): MetricDataPoint => ({ attrs, timeMs: T0 + i, value: i });

    it('counts series by attribute set, regardless of key order, and unique values per label', () => {
      const t = tracker();
      const dps = [point({ a: 1, b: 2 }), point({ b: 2, a: 1 }), point({ a: 1 }), point({}), point({})];
      for (let i = 0; i < 50; i++) dps.push(point({ 'user.id': uuid(i), tenant: 'acme' }, i));
      t.addMetrics(RESOURCE, [{ name: 'orders', type: 'sum', monotonic: true, dataPoints: dps }]);
      const m = t.metrics.get('orders')!;
      assert.strictEqual(m.series.estimate(), 53);
      assert.strictEqual(m.points, 55);
      assert.strictEqual(m.labels.get('user.id')!.distinct.estimate(), 50);
      assert.strictEqual(m.labels.get('tenant')!.distinct.estimate(), 1);
      assert.ok(m.proto > 0 && m.json > 0);
    });

    it('tells apart series that swap values between labels', () => {
      const t = tracker();
      t.addMetrics(RESOURCE, [{ name: 'm', type: 'gauge', dataPoints: [point({ a: 'x', b: 'y' }), point({ a: 'y', b: 'x' })] }]);
      assert.strictEqual(t.metrics.get('m')!.series.estimate(), 2);
    });

    it('counts metrics beyond the cap as other', () => {
      const t = tracker({ caps: { ...DEFAULT_CARDINALITY_CAPS, metricsPerInstance: 1 } });
      t.addMetrics(RESOURCE, [
        { name: 'kept', type: 'gauge', dataPoints: [point({ a: 1 })] },
        { name: 'other', type: 'gauge', dataPoints: [point({ a: 1 }), point({ a: 2 })] },
        { name: 'n'.repeat(MAX_KEY_CHARS + 1), type: 'gauge', dataPoints: [point({})] },
      ]);
      assert.deepStrictEqual([...t.metrics.keys()], ['kept']);
      assert.strictEqual(t.otherMetrics.count, 3);
      assert.strictEqual(t.totals.metrics.count, 4);
    });
  });

  describe('time buckets', () => {
    const at = (min: number, extra = 0) => T0 - (T0 % LIVE_BUCKET_MS) + min * LIVE_BUCKET_MS + extra;

    it('counts records per bucket and closes buckets with the unique-value estimate', () => {
      const t = tracker();
      const s = (min: number, id: number) => spans(1, () => ({ startMs: at(min, 5), attrs: { k: `v${id}` } }));
      t.addSpans(RESOURCE, [...s(0, 1), ...s(0, 2)]);
      t.addSpans(RESOURCE, s(1, 3));
      t.addSpans(RESOURCE, s(4, 4));
      const slot = (min: number) => Math.floor(at(min) / LIVE_BUCKET_MS) % BUCKETS;
      const counts = t.buckets.traces.count;
      assert.deepStrictEqual([0, 1, 2, 3, 4].map((m) => counts[slot(m)]), [2, 1, 0, 0, 1]);
      const h = t.spanKeys.get('k')!.history;
      assert.deepStrictEqual([0, 1, 2, 3].map((m) => h[slot(m)]), [2, 3, 3, 3]);
      assert.ok(Number.isNaN(h[slot(4)]), 'the open bucket has no closing estimate yet');
      assert.strictEqual(t.head, Math.floor(at(4) / LIVE_BUCKET_MS));
      assert.deepStrictEqual([t.firstMs, t.lastMs], [at(0, 5), at(4, 5)]);
    });

    it('puts late records in their bucket and leaves too-old ones out of the ring', () => {
      const t = tracker();
      t.addSpans(RESOURCE, spans(1, () => ({ startMs: at(100) })));
      t.addSpans(RESOURCE, spans(1, () => ({ startMs: at(98) })));
      t.addSpans(RESOURCE, spans(1, () => ({ startMs: at(100 - BUCKETS) })));
      const slot = (min: number) => Math.floor(at(min) / LIVE_BUCKET_MS) % BUCKETS;
      assert.strictEqual(t.buckets.traces.count[slot(98)], 1);
      assert.strictEqual(t.buckets.traces.count[slot(100)], 1);
      assert.strictEqual(t.totals.traces.count, 3);
      assert.strictEqual(t.buckets.traces.count.reduce((a, b) => a + b, 0), 2);
    });

    it('clears ring slots reused after a long gap', () => {
      const t = tracker();
      t.addSpans(RESOURCE, spans(3, () => ({ startMs: at(0) })));
      t.addSpans(RESOURCE, spans(1, () => ({ startMs: at(BUCKETS) })));
      assert.strictEqual(t.buckets.traces.count.reduce((a, b) => a + b, 0), 1);
    });

    it('uses the clock for missing or far-future times on live data only', () => {
      const live = tracker();
      live.addSpans(RESOURCE, spans(1, () => ({ startMs: 0 })));
      live.addSpans(RESOURCE, spans(1, () => ({ startMs: T0 + 2 * 86_400_000 })));
      assert.deepStrictEqual([live.firstMs, live.lastMs], [T0, T0]);
      const imported = tracker({ live: false });
      imported.addSpans(RESOURCE, spans(1, () => ({ startMs: T0 + 2 * 86_400_000 })));
      assert.strictEqual(imported.lastMs, T0 + 2 * 86_400_000);
    });

    it('sizes imported buckets so the whole range fits the ring', () => {
      assert.strictEqual(bucketMsForRange(T0, T0), LIVE_BUCKET_MS);
      assert.strictEqual(bucketMsForRange(Infinity, -Infinity), LIVE_BUCKET_MS);
      assert.strictEqual(bucketMsForRange(T0, T0 + 30 * 60_000), LIVE_BUCKET_MS);
      for (const hours of [2, 24, 24 * 30]) {
        const w = bucketMsForRange(T0, T0 + hours * 3_600_000);
        assert.strictEqual(w % LIVE_BUCKET_MS, 0);
        assert.ok(Math.floor((T0 + hours * 3_600_000) / w) - Math.floor(T0 / w) < BUCKETS, `${hours} h`);
      }
    });
  });

  describe('memory (P6)', () => {
    it('stays within 32 MiB at every store-wide cap', () => {
      const caps = DEFAULT_CARDINALITY_CAPS;
      const history = BUCKETS * 4;
      const keyWorst = 200 + MAX_COUNTER_BYTES + history + MAX_KEY_CHARS * 2 + caps.samplesPerKey * (caps.sampleChars + 1) * 2;
      const metricWorst = 200 + MAX_COUNTER_BYTES + history + MAX_KEY_CHARS * 2;
      // Template tokens hold at most maxBodyChars characters, plus string headers and the sample.
      const templateWorst = 400 + DEFAULT_DRAIN_OPTIONS.maxBodyChars * 2 + DEFAULT_DRAIN_OPTIONS.maxTokens * 16 + (caps.sampleChars + 1) * 2;
      const total = caps.keysTotal * keyWorst + caps.metricsTotal * metricWorst + caps.templatesTotal * templateWorst;
      assert.ok(total <= 32 * 1024 * 1024, `${(total / 1048576).toFixed(1)} MiB`);
    });

    it('reports its own size within the per-key bound', () => {
      const t = tracker();
      const attrs: Record<string, string> = {};
      for (let k = 0; k < 20; k++) attrs[`key.${k}`] = '';
      t.addSpans(RESOURCE, spans(500, (i) => ({ name: 'op', attrs: Object.fromEntries(Object.keys(attrs).map((k) => [k, `${k}-${i}`])) })));
      const fixed = 3 * 3 * BUCKETS * 8 + t.spanNames.approxBytes() + 120;
      const perKey = (t.approxBytes() - fixed) / t.trackedKeys;
      assert.ok(perKey <= 200 + MAX_COUNTER_BYTES + BUCKETS * 4 + 2 * 64 + 3 * 121 * 2, `${perKey.toFixed(0)} bytes per key`);
    });
  });
});
