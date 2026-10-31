// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { CardinalityBudget } from '../../src/store/cardinality/budget';
import { LIVE_BUCKET_MS, bucketMsForRange } from '../../src/store/cardinality/tracker';
import { ResourceInfo, ResourceMetrics } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';

const budgetOf = (store: TelemetryStore) => (store as unknown as { cardinalityBudget: CardinalityBudget }).cardinalityBudget;
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const tagged = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => span({ ...ids(i + offset), attrs: { 'user.id': `u${i + offset}` } }));

describe('TelemetryStore usage tracking', () => {
  it('tracks live instances by default and counts past retention', () => {
    const store = new TelemetryStore(10, 5);
    addLogs(store, 'svc', Array.from({ length: 100 }, (_, i) => log({ timeMs: T0 + i, body: `n ${i}`, attrs: { i } })));
    const id = addSpans(store, 'svc', tagged(50));
    const inst = store.getInstance(id)!;
    assert.strictEqual(store.getLogs(id).length, 10);
    assert.strictEqual(inst.traces.size, 5);
    assert.strictEqual(inst.usage!.totals.logs.count, 100);
    assert.strictEqual(inst.usage!.totals.traces.count, 50);
    assert.strictEqual(inst.usage!.logKeys.get('i')!.distinct.estimate(), 100);
    assert.strictEqual(inst.usage!.spanKeys.get('user.id')!.distinct.estimate(), 50);
  });

  it('tracks metrics per export', () => {
    const store = new TelemetryStore();
    const batch = (i: number): ResourceMetrics => ({
      resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} },
      metrics: [{ name: 'm', type: 'gauge', dataPoints: [{ attrs: { user: `u${i}` }, timeMs: T0 + i, value: i }] }],
    });
    for (let i = 0; i < 5; i++) store.ingestMetrics([batch(i)]);
    const usage = store.getInstance('svc::i1')!.usage!;
    assert.strictEqual(usage.totals.metrics.count, 5);
    assert.strictEqual(usage.metrics.get('m')!.series.estimate(), 5);
  });

  it('releases budgets on clear, instance removal and session removal', () => {
    const store = new TelemetryStore();
    addSpans(store, 'a', tagged(3));
    addSpans(store, 'b', tagged(3));
    assert.strictEqual(budgetOf(store).keys.used, 2);
    store.removeInstance('a::i1');
    assert.strictEqual(budgetOf(store).keys.used, 1);
    store.clear();
    assert.strictEqual(budgetOf(store).keys.used, 0);

    const { sessionId } = store.importSession({
      sourceLabel: 'file.json',
      traces: [{ resource: { serviceName: 'c', attrs: {} }, spans: tagged(4) }],
      logs: [],
      metrics: [],
    });
    assert.strictEqual(budgetOf(store).keys.used, 1);
    store.clear();
    assert.strictEqual(budgetOf(store).keys.used, 1, 'clear keeps imported data');
    store.removeSession(sessionId);
    assert.strictEqual(budgetOf(store).keys.used, 0);
  });

  it('frees counters when turned off and counts afresh when turned back on', () => {
    const store = new TelemetryStore();
    const id = addSpans(store, 'svc', tagged(5));
    store.setCardinality(false);
    assert.strictEqual(store.isCardinalityEnabled(), false);
    assert.strictEqual(store.getInstance(id)!.usage, undefined);
    assert.strictEqual(budgetOf(store).keys.used, 0);
    addSpans(store, 'svc', tagged(5, 5));
    assert.strictEqual(store.getInstance(id)!.usage, undefined);
    assert.strictEqual(store.getInstance(id)!.spanCount, 10);
    store.setCardinality(true);
    addSpans(store, 'svc', tagged(2, 10));
    assert.strictEqual(store.getInstance(id)!.usage!.totals.traces.count, 2);
  });

  it('notifies listeners when tracking is turned off', async () => {
    const store = new TelemetryStore();
    addSpans(store, 'svc', tagged(1));
    await new Promise((r) => setTimeout(r, 200));
    let fired = 0;
    store.onDidChange(() => fired++);
    store.setCardinality(true);
    store.setCardinality(false);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(fired, 1);
  });

  it('tracks imported sessions with buckets sized to the file and without clock substitution', () => {
    const store = new TelemetryStore();
    const resource: ResourceInfo = { serviceName: 'imp', attrs: {} };
    const far = T0 + 3 * 86_400_000;
    const { instanceIds } = store.importSession({
      sourceLabel: 'old.json',
      traces: [{ resource, spans: [span({ ...ids(0), startMs: T0 }), span({ ...ids(1), startMs: far })] }],
      logs: [{ resource, logs: [log({ timeMs: T0 + 1000, body: 'hello' })] }],
      metrics: [
        { resource, metrics: [{ name: 'm', type: 'gauge', dataPoints: [{ attrs: {}, timeMs: T0, value: 1 }] }] },
        { resource, metrics: [{ name: 'm', type: 'gauge', dataPoints: [{ attrs: {}, timeMs: T0 + 10, value: 2 }] }] },
      ],
    });
    const usage = store.getInstance(instanceIds[0])!.usage!;
    assert.strictEqual(usage.bucketMs, bucketMsForRange(T0, far));
    assert.ok(usage.bucketMs > LIVE_BUCKET_MS);
    assert.deepStrictEqual([usage.firstMs, usage.lastMs], [T0, far]);
    assert.deepStrictEqual(
      [usage.totals.traces.count, usage.totals.logs.count, usage.totals.metrics.count],
      [2, 1, 2],
      'each metric export counts before batches are merged'
    );
  });

  it('tracks imported logs', () => {
    const store = new TelemetryStore();
    const id = store.importLogs({
      serviceName: 'svc',
      resourceAttrs: {},
      logs: [log({ timeMs: T0, body: 'a 1' }), log({ timeMs: T0 + 1, body: 'a 2' })],
      sourceLabel: 'x.jsonl',
    });
    const usage = store.getInstance(id)!.usage!;
    assert.strictEqual(usage.totals.logs.count, 2);
    assert.strictEqual(usage.templates.templates()[0].text, 'a <NUM>');
  });

  it('does not track imports while turned off', () => {
    const store = new TelemetryStore();
    store.setCardinality(false);
    const { instanceIds } = store.importSession({
      sourceLabel: 'x.json',
      traces: [{ resource: { serviceName: 's', attrs: {} }, spans: tagged(1) }],
      logs: [],
      metrics: [],
    });
    assert.strictEqual(store.getInstance(instanceIds[0])!.usage, undefined);
  });
});
