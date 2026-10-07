// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  CallStats,
  DEFAULT_THRESHOLDS,
  classifyHealth,
  sanitizeThresholds,
  buildServiceMap,
} from '../../src/views/serviceMapModel';
import { TelemetryStore } from '../../src/store/store';
import { T0, addSpans, span } from './aiFixtures';

const T = DEFAULT_THRESHOLDS;
const stats = (p: Partial<CallStats>): CallStats => {
  const count = p.count ?? 100;
  const errors = p.errors ?? 0;
  return { count, errors, errorRate: count ? errors / count : 0, p50: p.p95 ?? 10, p95: 10, ...p };
};

describe('serviceMap health', () => {
  describe('sanitizeThresholds', () => {
    it('returns defaults for missing or non-object input', () => {
      assert.deepStrictEqual(sanitizeThresholds(undefined), { ...T });
      assert.deepStrictEqual(sanitizeThresholds('x'), { ...T });
      assert.deepStrictEqual(sanitizeThresholds({}), { ...T });
    });

    it('replaces non-finite, negative and non-number values with defaults', () => {
      assert.deepStrictEqual(
        sanitizeThresholds({ latencyWarnMs: NaN, latencyCriticalMs: -1, errorRateWarn: '0.5', errorRateCritical: Infinity }),
        { ...T }
      );
    });

    it('keeps valid values, including zero', () => {
      assert.deepStrictEqual(
        sanitizeThresholds({ latencyWarnMs: 0, latencyCriticalMs: 50, errorRateWarn: 0, errorRateCritical: 0.2 }),
        { latencyWarnMs: 0, latencyCriticalMs: 50, errorRateWarn: 0, errorRateCritical: 0.2 }
      );
    });

    it('clamps error rates to 1 and lowers warn to critical', () => {
      assert.deepStrictEqual(
        sanitizeThresholds({ latencyWarnMs: 2000, latencyCriticalMs: 500, errorRateWarn: 3, errorRateCritical: 7 }),
        { latencyWarnMs: 500, latencyCriticalMs: 500, errorRateWarn: 1, errorRateCritical: 1 }
      );
    });

    it('is not affected by a __proto__ key', () => {
      assert.deepStrictEqual(sanitizeThresholds(JSON.parse('{"__proto__":{"latencyWarnMs":1}}')), { ...T });
    });
  });

  describe('classifyHealth', () => {
    it('is idle without calls', () => {
      assert.strictEqual(classifyHealth(stats({ count: 0, p95: null }), T), 'idle');
    });

    it('is ok under every threshold', () => {
      assert.strictEqual(classifyHealth(stats({ p95: 299, errors: 0 }), T), 'ok');
    });

    it('treats latency boundaries as breached', () => {
      assert.strictEqual(classifyHealth(stats({ p95: 300 }), T), 'warn');
      assert.strictEqual(classifyHealth(stats({ p95: 999.9 }), T), 'warn');
      assert.strictEqual(classifyHealth(stats({ p95: 1000 }), T), 'critical');
    });

    it('treats error-rate boundaries as breached', () => {
      assert.strictEqual(classifyHealth(stats({ errors: 1 }), T), 'warn');
      assert.strictEqual(classifyHealth(stats({ errors: 4 }), T), 'warn');
      assert.strictEqual(classifyHealth(stats({ errors: 5 }), T), 'critical');
    });

    it('takes the worse of latency and errors', () => {
      assert.strictEqual(classifyHealth(stats({ p95: 1500, errors: 1 }), T), 'critical');
      assert.strictEqual(classifyHealth(stats({ p95: 10, errors: 50 }), T), 'critical');
    });

    it('never flags zero errors, even with a zero error threshold', () => {
      const zero = { ...T, errorRateWarn: 0, errorRateCritical: 0 };
      assert.strictEqual(classifyHealth(stats({ errors: 0 }), zero), 'ok');
      assert.strictEqual(classifyHealth(stats({ errors: 1 }), zero), 'critical');
    });

    it('caps low-volume calls at warn', () => {
      assert.strictEqual(classifyHealth(stats({ count: 4, errors: 4, p95: 5000 }), T), 'warn');
      assert.strictEqual(classifyHealth(stats({ count: 5, errors: 5 }), T), 'critical');
    });
  });

  it('attaches health to model nodes and edges', () => {
    const store = new TelemetryStore();
    const spans = Array.from({ length: 6 }, (_, i) =>
      span({
        traceId: (i + 1).toString(16).padStart(32, '0'),
        spanId: (i + 1).toString(16).padStart(16, '0'),
        kind: 'CLIENT',
        startMs: T0 + i,
        durationMs: 1200,
        attrs: { 'db.system': 'postgresql' },
      })
    );
    addSpans(store, 'api', spans);
    const m = buildServiceMap(store.getAllTaggedSpans(), { range: 'all' });
    assert.deepStrictEqual(
      m.nodes.map((n) => [n.id, n.health]),
      [
        ['svc:api', 'critical'],
        ['db:postgresql:postgresql', 'critical'],
      ]
    );
    assert.strictEqual(m.edges[0].health, 'critical');
    const relaxed = buildServiceMap(store.getAllTaggedSpans(), {
      range: 'all',
      thresholds: { ...T, latencyWarnMs: 5000, latencyCriticalMs: 5000 },
    });
    assert.strictEqual(relaxed.edges[0].health, 'ok');
  });

  it('package.json defaults match DEFAULT_THRESHOLDS', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    for (const key of Object.keys(T) as (keyof typeof T)[]) {
      assert.strictEqual(props[`otel.serviceMap.${key}`].default, T[key], key);
      assert.strictEqual(props[`otel.serviceMap.${key}`].scope, 'resource', key);
    }
  });
});
