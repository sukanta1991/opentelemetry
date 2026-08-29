import * as assert from 'assert';
import { TelemetryStore } from '../../src/store/store';
import { Metric, ResourceMetrics } from '../../src/store/model';

function batch(metrics: Metric[]): ResourceMetrics[] {
  return [{ resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} }, metrics }];
}

function gauge(name: string, timeMs: number, value: number): Metric {
  return { name, type: 'gauge', dataPoints: [{ attrs: {}, timeMs, value }] };
}

describe('store metric series', () => {
  const instanceId = 'svc::i1';

  it('accumulates history across ingests', () => {
    const store = new TelemetryStore();
    store.ingestMetrics(batch([gauge('cpu', 1000, 10)]));
    store.ingestMetrics(batch([gauge('cpu', 2000, 20)]));
    store.ingestMetrics(batch([gauge('cpu', 3000, 30)]));
    const series = store.getMetricSeries(instanceId, 'cpu');
    assert.strictEqual(series.length, 1);
    assert.deepStrictEqual(
      series[0].data.map((p) => [p.timeMs, p.value]),
      [
        [1000, 10],
        [2000, 20],
        [3000, 30],
      ]
    );
  });

  it('dedupes duplicate and out-of-order timestamps', () => {
    const store = new TelemetryStore();
    store.ingestMetrics(batch([gauge('cpu', 2000, 20)]));
    store.ingestMetrics(batch([gauge('cpu', 2000, 99)])); // same timeMs -> ignored
    store.ingestMetrics(batch([gauge('cpu', 1000, 5)])); // older -> ignored
    const [series] = store.getMetricSeries(instanceId, 'cpu');
    assert.deepStrictEqual(
      series.data.map((p) => p.value),
      [20]
    );
  });

  it('separates series by attribute set', () => {
    const store = new TelemetryStore();
    const m = (core: string, v: number): Metric => ({
      name: 'load',
      type: 'gauge',
      dataPoints: [{ attrs: { core }, timeMs: 1000, value: v }],
    });
    store.ingestMetrics(batch([m('0', 1)]));
    store.ingestMetrics(batch([m('1', 2)]));
    const series = store.getMetricSeries(instanceId, 'load');
    assert.strictEqual(series.length, 2);
  });

  it('caps points per series to retention', () => {
    const store = new TelemetryStore(5000, 2000, 3);
    for (let i = 0; i < 10; i++) {
      store.ingestMetrics(batch([gauge('cpu', 1000 + i, i)]));
    }
    const [series] = store.getMetricSeries(instanceId, 'cpu');
    assert.strictEqual(series.data.length, 3);
    assert.deepStrictEqual(
      series.data.map((p) => p.value),
      [7, 8, 9]
    );
  });

  it('caps total number of series (cardinality guard)', () => {
    const store = new TelemetryStore(5000, 2000, 500, 2);
    const m = (id: number): Metric => ({
      name: 'req',
      type: 'gauge',
      dataPoints: [{ attrs: { id: String(id) }, timeMs: 1000, value: id }],
    });
    store.ingestMetrics(batch([m(1)]));
    store.ingestMetrics(batch([m(2)]));
    store.ingestMetrics(batch([m(3)])); // evicts oldest series
    const series = store.getMetricSeries(instanceId, 'req');
    assert.strictEqual(series.length, 2);
  });

  it('records a series per summary quantile', () => {
    const store = new TelemetryStore();
    const m: Metric = {
      name: 'rt',
      type: 'summary',
      dataPoints: [
        {
          attrs: {},
          timeMs: 1000,
          count: 3,
          sum: 30,
          quantiles: [
            { quantile: 0.5, value: 8 },
            { quantile: 0.99, value: 20 },
          ],
        },
      ],
    };
    store.ingestMetrics(batch([m]));
    const fields = store
      .getMetricSeries(instanceId, 'rt')
      .map((s) => s.field)
      .sort();
    assert.deepStrictEqual(fields, ['count', 'q0.5', 'q0.99']);
  });

  it('setRetention re-caps existing series buffers', () => {
    const store = new TelemetryStore();
    for (let i = 0; i < 10; i++) {
      store.ingestMetrics(batch([gauge('cpu', 1000 + i, i)]));
    }
    store.setRetention(5000, 2000, 2);
    const [series] = store.getMetricSeries(instanceId, 'cpu');
    assert.strictEqual(series.data.length, 2);
  });

  it('records count and sum series for histograms', () => {
    const store = new TelemetryStore();
    const hist = (timeMs: number, count: number, sum: number): Metric => ({
      name: 'lat',
      type: 'histogram',
      dataPoints: [{ attrs: {}, timeMs, count, sum, bucketBounds: [1, 2], bucketCounts: [1, 1, 1] }],
    });
    store.ingestMetrics(batch([hist(1000, 3, 30)]));
    store.ingestMetrics(batch([hist(2000, 6, 60)]));
    const series = store.getMetricSeries(instanceId, 'lat');
    const byField = new Map(series.map((s) => [s.field, s.data.map((p) => p.value)]));
    assert.deepStrictEqual([...byField.keys()].sort(), ['count', 'sum']);
    assert.deepStrictEqual(byField.get('count'), [3, 6]);
    assert.deepStrictEqual(byField.get('sum'), [30, 60]);
  });

  it('labels gauge and sum series with the value field', () => {
    const store = new TelemetryStore();
    store.ingestMetrics(batch([gauge('cpu', 1000, 10)]));
    store.ingestMetrics(
      batch([{ name: 'reqs', type: 'sum', dataPoints: [{ attrs: {}, timeMs: 1000, value: 5 }] }])
    );
    assert.strictEqual(store.getMetricSeries(instanceId, 'cpu')[0].field, 'value');
    assert.strictEqual(store.getMetricSeries(instanceId, 'reqs')[0].field, 'value');
  });

  it('ignores data points without a value', () => {
    const store = new TelemetryStore();
    store.ingestMetrics(batch([{ name: 'cpu', type: 'gauge', dataPoints: [{ attrs: {}, timeMs: 1000 }] }]));
    assert.deepStrictEqual(store.getMetricSeries(instanceId, 'cpu'), []);
  });

  it('creates a series per data point in a single batch', () => {
    const store = new TelemetryStore();
    const load: Metric = {
      name: 'load',
      type: 'gauge',
      dataPoints: [
        { attrs: { core: '0' }, timeMs: 1000, value: 1 },
        { attrs: { core: '1' }, timeMs: 1000, value: 2 },
      ],
    };
    store.ingestMetrics(batch([load]));
    assert.strictEqual(store.getMetricSeries(instanceId, 'load').length, 2);
  });

  it('returns empty history for unknown instance or metric', () => {
    const store = new TelemetryStore();
    store.ingestMetrics(batch([gauge('cpu', 1000, 10)]));
    assert.deepStrictEqual(store.getMetricSeries('does::not-exist', 'cpu'), []);
    assert.deepStrictEqual(store.getMetricSeries(instanceId, 'unknown-metric'), []);
  });
});
