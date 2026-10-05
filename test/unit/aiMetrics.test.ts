// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { queryMetrics } from '../../src/ai/analysis/metrics';
import { REDACTED, createRedactor } from '../../src/ai/redact';
import { parseQueryMetricsInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import { T0, addMetrics } from './aiFixtures';

const ctx = { now: T0 + 60_000, redactor: createRedactor(), maxItems: 25 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseQueryMetricsInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return queryMetrics(store, input.value, ctx);
}

describe('ai queryMetrics', () => {
  const store = new TelemetryStore();
  addMetrics(store);

  it('lists metrics per instance', () => {
    const { result, refs } = run(store, {});
    assert.deepStrictEqual(result, {
      totalMetrics: 2,
      metrics: [
        {
          instanceId: 'checkout::i1',
          service: 'checkout',
          name: 'http.server.requests',
          type: 'sum',
          unit: '{request}',
          description: undefined,
          monotonic: true,
          seriesCount: 2,
        },
        {
          instanceId: 'checkout::i1',
          service: 'checkout',
          name: 'process.memory',
          type: 'gauge',
          unit: 'By',
          description: 'Resident memory',
          monotonic: undefined,
          seriesCount: 1,
        },
      ],
    });
    assert.deepStrictEqual(refs, []);
  });

  it('summarizes each series of a gauge', () => {
    const { result } = run(store, { name: 'process.memory' });
    assert.strictEqual(result.type, 'gauge');
    assert.strictEqual(result.totalSeries, 1);
    const [s] = result.series;
    assert.deepStrictEqual(
      { points: s.points, last: s.last, min: s.min, max: s.max, avg: s.avg, p50: s.p50, p95: s.p95, delta: s.delta },
      { points: 3, last: 200, min: 100, max: 300, avg: 200, p50: 200, p95: 290, delta: 100 }
    );
    assert.strictEqual(s.from, new Date(T0).toISOString());
    assert.strictEqual(s.to, new Date(T0 + 20_000).toISOString());
    assert.strictEqual(s.ratePerSec, undefined, 'no rate for a gauge');
  });

  it('computes a per-second rate for counters, null when no time elapsed', () => {
    const { result } = run(store, { name: 'http.server.requests' });
    assert.strictEqual(result.monotonic, true);
    const [health, pay] = result.series;
    assert.deepStrictEqual(pay.attrs, { route: '/pay' });
    assert.strictEqual(pay.delta, 60);
    assert.strictEqual(pay.ratePerSec, 3);
    assert.strictEqual(health.points, 1);
    assert.strictEqual(health.delta, 0);
    assert.strictEqual(health.ratePerSec, null);
    assert.deepStrictEqual(health.attrs, { 'api.token': REDACTED, route: '/health' });
  });

  it('suggests known names for an unknown metric', () => {
    assert.strictEqual(
      run(store, { name: 'cpu' }).result.error,
      'metric "cpu" not found; known metrics: http.server.requests, process.memory'
    );
    assert.match(run(store, { service: 'nope' }).result.error, /known services: checkout/);
  });

  it('honours limit', () => {
    const { result } = run(store, { name: 'http.server.requests', limit: 1 });
    assert.strictEqual(result.totalSeries, 2);
    assert.strictEqual(result.series.length, 1);
  });
});
