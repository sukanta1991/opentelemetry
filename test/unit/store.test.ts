import * as assert from 'assert';
import { TelemetryStore } from '../../src/store/store';
import { LogRecord, Metric, ResourceMetrics, Span } from '../../src/store/model';

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

describe('store trace ↔ log correlation', () => {
  const T1 = 'a'.repeat(32);
  const T2 = 'b'.repeat(32);
  const resource = (svc: string) => ({ serviceName: svc, serviceInstanceId: 'i1', attrs: {} });

  function span(spanId: string, startMs: number, parentSpanId?: string, traceId = T1): Span {
    return {
      traceId,
      spanId,
      parentSpanId,
      name: spanId,
      kind: 'INTERNAL',
      startMs,
      endMs: startMs + 10,
      durationMs: 10,
      statusCode: 'UNSET',
      attrs: {},
      events: [],
      links: [],
    };
  }

  function log(timeMs: number, traceId?: string, spanId?: string): LogRecord {
    return { timeMs, severityNumber: 9, severityText: 'INFO', body: `m${timeMs}`, attrs: {}, traceId, spanId };
  }

  function seeded(): TelemetryStore {
    const store = new TelemetryStore();
    store.ingestSpans([{ resource: resource('front'), spans: [span('1111111111111111', 100)] }]);
    store.ingestSpans([
      { resource: resource('back'), spans: [span('2222222222222222', 110, '1111111111111111')] },
    ]);
    store.ingestLogs([
      { resource: resource('front'), logs: [log(105, T1, '1111111111111111'), log(1, T2), log(2)] },
    ]);
    store.ingestLogs([
      { resource: resource('back'), logs: [log(115, T1, '2222222222222222'), log(101, T1)] },
    ]);
    return store;
  }

  it('tags spans with their instance', () => {
    const tagged = seeded().getSpansForTrace(T1);
    assert.deepStrictEqual(
      tagged.map((t) => [t.span.spanId, t.serviceName, t.instanceId]),
      [
        ['1111111111111111', 'front', 'front::i1'],
        ['2222222222222222', 'back', 'back::i1'],
      ]
    );
  });

  it('finds every instance holding a trace', () => {
    const store = seeded();
    assert.deepStrictEqual(store.findTraceInstances(T1), ['front::i1', 'back::i1']);
    assert.deepStrictEqual(store.findTraceInstances(T2), []);
  });

  it('collects logs for a trace across instances, oldest first', () => {
    const { items, truncated } = seeded().getLogsForTrace(T1);
    assert.strictEqual(truncated, false);
    assert.deepStrictEqual(
      items.map((i) => [i.instanceId, i.log.timeMs]),
      [
        ['back::i1', 101],
        ['front::i1', 105],
        ['back::i1', 115],
      ]
    );
  });

  it('filters logs by span', () => {
    const { items } = seeded().getLogsForTrace(T1, { spanId: '2222222222222222' });
    assert.deepStrictEqual(
      items.map((i) => i.log.timeMs),
      [115]
    );
  });

  it('caps logs to the newest and flags truncation', () => {
    const { items, truncated } = seeded().getLogsForTrace(T1, { limit: 2 });
    assert.strictEqual(truncated, true);
    assert.deepStrictEqual(
      items.map((i) => i.log.timeMs),
      [105, 115]
    );
  });

  it('counts correlated logs per instance and per trace', () => {
    const store = seeded();
    assert.deepStrictEqual([...store.countLogsByInstance(T1)], [
      ['front::i1', 1],
      ['back::i1', 2],
    ]);
    assert.deepStrictEqual([...store.countLogsByInstance(T1, '1111111111111111')], [['front::i1', 1]]);
    const byTrace = store.countLogsByTrace();
    assert.strictEqual(byTrace.get(T1), 3);
    assert.strictEqual(byTrace.get(T2), 1);
    assert.strictEqual(byTrace.size, 2);
  });

  it('picks the earliest parentless span as root regardless of arrival order', () => {
    const store = new TelemetryStore();
    store.ingestSpans([
      {
        resource: resource('svc'),
        spans: [span('3333333333333333', 50), span('4444444444444444', 10), span('5555555555555555', 30)],
      },
    ]);
    const trace = store.getInstance('svc::i1')!.traces.get(T1)!;
    assert.strictEqual(trace.rootSpanId, '4444444444444444');
  });
});

describe('store application ordering', () => {
  const logsFor = (serviceInstanceId: string) => [
    {
      resource: { serviceName: 'svc', serviceInstanceId, attrs: {} },
      logs: [{ timeMs: 1, severityNumber: 9, severityText: 'INFO', body: 'x', attrs: {} } as LogRecord],
    },
  ];

  it('orders instances by name, not by most recent activity', () => {
    const store = new TelemetryStore();
    store.ingestLogs(logsFor('b'));
    store.ingestLogs(logsFor('a'));
    const order = () => store.getApplications()[0].instances.map((i) => i.serviceInstanceId);
    assert.deepStrictEqual(order(), ['a', 'b']);
    store.ingestLogs(logsFor('b'));
    assert.deepStrictEqual(order(), ['a', 'b']);
  });
});
