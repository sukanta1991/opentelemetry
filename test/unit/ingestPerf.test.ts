// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { ResourceLogs, ResourceMetrics, ResourceSpans } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import {
  INGEST_SERVICES,
  LOGS_PER_SERVICE,
  METRIC_CYCLES,
  POINTS_PER_CYCLE,
  SPANS_PER_TRACE,
  TRACES_PER_SERVICE,
  buildLogBatches,
  buildMetricBatches,
  buildSpanBatches,
  freshMetricBatches,
} from './ingestFixtures';
import { CI_FACTOR, timeIt } from './perfFixtures';

// P2 guard: store-only ingest with the analyzer off. Phase 0 medians: ~28 ms spans, ~1 ms logs, ~49 ms metrics.
const OFF_BUDGET_MS = { spans: 100, logs: 10, metrics: 150 };
// P1: tracking cost per record (on minus off), 1.4x the targets derived from the receive path.
const TRACKING_BUDGET_US = { spans: 1.8 * 1.4, logs: 2.0 * 1.4, metrics: 1.1 * 1.4 };

const SPANS = INGEST_SERVICES * TRACES_PER_SERVICE * SPANS_PER_TRACE;
const LOGS = INGEST_SERVICES * LOGS_PER_SERVICE;
const POINTS = INGEST_SERVICES * METRIC_CYCLES * POINTS_PER_CYCLE;

function newStore(tracking: boolean): TelemetryStore {
  const store = new TelemetryStore();
  store.setCardinality(tracking);
  return store;
}

function checkCost(kind: keyof typeof OFF_BUDGET_MS, records: number, run: (tracking: boolean) => void): void {
  const off = timeIt(() => run(false));
  const on = timeIt(() => run(true));
  const offBudget = OFF_BUDGET_MS[kind] * CI_FACTOR;
  assert.ok(off.median < offBudget, `off: median ${off.median.toFixed(1)} ms, budget ${offBudget} ms`);
  const perRecord = ((on.median - off.median) * 1000) / records;
  const budget = TRACKING_BUDGET_US[kind] * CI_FACTOR;
  assert.ok(
    perRecord <= budget,
    `tracking +${perRecord.toFixed(2)} µs/record (off ${off.median.toFixed(1)} ms, on ${on.median.toFixed(1)} ms), budget ${budget.toFixed(2)} µs`
  );
}

describe('ingest performance (full buffers)', function () {
  this.timeout(180_000);
  let spans: ResourceSpans[] | undefined;
  let logs: ResourceLogs[] | undefined;
  let metrics: ResourceMetrics[] | undefined;

  before(() => {
    spans = buildSpanBatches();
    logs = buildLogBatches();
    metrics = buildMetricBatches();
  });

  after(() => {
    spans = logs = metrics = undefined;
  });

  const ingestMetrics = (store: TelemetryStore) => {
    // One export per call, as the receiver delivers them.
    for (const b of freshMetricBatches(metrics!)) store.ingestMetrics([b]);
    return store;
  };

  it(`ingestSpans (200k spans x 10 attrs): tracking within ${TRACKING_BUDGET_US.spans.toFixed(2)} µs/span`, () => {
    const store = newStore(true);
    store.ingestSpans(spans!);
    const instances = store.getAllInstances();
    assert.strictEqual(instances.reduce((n, i) => n + i.spanCount, 0), SPANS);
    assert.strictEqual(instances.reduce((n, i) => n + i.usage!.totals.traces.count, 0), SPANS);
    checkCost('spans', SPANS, (tracking) => newStore(tracking).ingestSpans(spans!));
  });

  it(`ingestLogs (50k logs): tracking within ${TRACKING_BUDGET_US.logs.toFixed(2)} µs/log`, () => {
    const store = newStore(true);
    store.ingestLogs(logs!);
    const instances = store.getAllInstances();
    assert.strictEqual(instances.reduce((n, i) => n + i.logCount, 0), LOGS);
    assert.strictEqual(instances.reduce((n, i) => n + i.usage!.totals.logs.count, 0), LOGS);
    checkCost('logs', LOGS, (tracking) => newStore(tracking).ingestLogs(logs!));
  });

  it(`ingestMetrics (20k points): tracking within ${TRACKING_BUDGET_US.metrics.toFixed(2)} µs/point`, () => {
    const store = ingestMetrics(newStore(true));
    const instances = store.getAllInstances();
    assert.strictEqual(instances.length, INGEST_SERVICES);
    assert.strictEqual(instances.reduce((n, i) => n + i.usage!.totals.metrics.count, 0), POINTS);
    checkCost('metrics', POINTS, (tracking) => ingestMetrics(newStore(tracking)));
  });
});
