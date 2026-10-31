// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { ValueClass } from '../../src/store/cardinality/valueClass';
import {
  CRITICAL_BYTES_SHARE,
  DEFAULT_CARDINALITY_SETTINGS,
  ID_LIKE_MIN_DISTINCT,
  KeyFacts,
  MetricFacts,
  NOISY_TEMPLATE_MIN_LOGS,
  ServiceFacts,
  dominantClass,
  evaluateFindings,
  growthOf,
  sanitizeCardinalitySettings,
} from '../../src/views/cardinalityRules';

const S = DEFAULT_CARDINALITY_SETTINGS;
const flat = (v: number) => new Array<number>(60).fill(NaN).map((_, i) => (i < 10 ? v : NaN));

function key(p: Omit<Partial<KeyFacts>, 'classes'> & { key: string; classes?: [ValueClass, number][] }): KeyFacts {
  const classes = p.classes ?? [];
  return {
    scope: 'span',
    distinct: 1,
    approx: false,
    occurrences: 1000,
    proto: 100,
    json: 200,
    samples: [],
    history: () => flat(1),
    ...p,
    growth: () => growthOf((p.history ?? (() => flat(1)))()),
    valueClass: dominantClass(classes),
    classes: () => classes,
  };
}

function metric(p: Partial<MetricFacts> & { name: string }): MetricFacts {
  const history = p.history ?? (() => flat(1));
  return { type: 'sum', series: 1, approx: false, points: 100, proto: 100, json: 200, labels: [], ...p, history, growth: () => growthOf(history()) };
}

function service(p: Partial<ServiceFacts> = {}): ServiceFacts {
  return {
    service: 'svc',
    bytes: { traces: 10_000, logs: 10_000, metrics: 10_000 },
    logs: 0,
    keys: [],
    metrics: [],
    spanNames: { distinct: 1, approx: false, classified: 1, withIds: 0, samples: [] },
    templates: [],
    ...p,
  };
}

const ids: [ValueClass, number][] = [['uuid', 64]];

describe('cardinality rules', () => {
  describe('R1 high-cardinality attributes', () => {
    it('needs both the unique count and the unique ratio', () => {
      const run = (distinct: number, occurrences: number) =>
        evaluateFindings([service({ keys: [key({ key: 'k', distinct, occurrences })] })], S);
      assert.strictEqual(run(S.minDistinct - 1, S.minDistinct).length, 0, 'below minDistinct');
      assert.strictEqual(run(S.minDistinct, Math.ceil(S.minDistinct / S.minDistinctRatio) + 1).length, 0, 'below ratio');
      const [f] = run(S.minDistinct, S.minDistinct);
      assert.deepStrictEqual([f.rule, f.kind, f.severity, f.signal], ['R1', 'attribute', 'warning', 'traces']);
    });

    it('is critical only at 10x and with a large share of bytes', () => {
      const run = (proto: number) =>
        evaluateFindings([service({ keys: [key({ key: 'k', distinct: 10 * S.minDistinct, occurrences: 10 * S.minDistinct, proto })] })], S)[0];
      assert.strictEqual(run(CRITICAL_BYTES_SHARE * 10_000).severity, 'critical');
      assert.strictEqual(run(CRITICAL_BYTES_SHARE * 10_000 - 1).severity, 'warning');
      assert.ok(Math.abs(run(2000).bytesShare - 0.2) < 1e-12);
    });

    it('maps scopes to signals and shares', () => {
      const [f] = evaluateFindings([service({ keys: [key({ key: 'k', scope: 'log', distinct: 500, occurrences: 500, proto: 2500 })] })], S);
      assert.deepStrictEqual([f.signal, f.scope, f.bytesShare], ['logs', 'log', 0.25]);
    });
  });

  describe('R2 id-like values', () => {
    it('flags id classes and known keys from 20 unique values', () => {
      const run = (k: KeyFacts) => evaluateFindings([service({ keys: [k] })], S);
      assert.strictEqual(run(key({ key: 'x', classes: ids, distinct: ID_LIKE_MIN_DISTINCT - 1 })).length, 0);
      const [byClass] = run(key({ key: 'x', classes: ids, distinct: ID_LIKE_MIN_DISTINCT }));
      assert.deepStrictEqual([byClass.rule, byClass.severity, byClass.valueClass], ['R2', 'warning', 'uuid']);
      assert.ok(byClass.hint?.includes('identifiers'));
      const [byKey] = run(key({ key: 'url.full', classes: [['other', 64]], distinct: ID_LIKE_MIN_DISTINCT }));
      assert.deepStrictEqual(byKey.prefer, ['http.route', 'url.template']);
    });

    it('ignores mixed classes below the dominant share', () => {
      assert.strictEqual(dominantClass([['uuid', 7], ['other', 3]]), undefined);
      assert.strictEqual(dominantClass([['uuid', 8], ['other', 2]]), 'uuid');
      assert.strictEqual(dominantClass([]), undefined);
      assert.strictEqual(evaluateFindings([service({ keys: [key({ key: 'x', classes: [['uuid', 7], ['other', 3]], distinct: 50 })] })], S).length, 0);
    });

    it('reports one finding per key, as R1 when both apply', () => {
      const fs = evaluateFindings([service({ keys: [key({ key: 'user.id', classes: ids, distinct: 500, occurrences: 500 })] })], S);
      assert.deepStrictEqual(fs.map((f) => f.rule), ['R1']);
      assert.strictEqual(fs[0].valueClass, 'uuid');
    });
  });

  describe('R3 metric series', () => {
    const labels = [key({ key: 'tenant', scope: 'metric', distinct: 5 }), key({ key: 'route', scope: 'metric', distinct: 80, classes: [['other', 64]] })];

    it('flags series at the threshold, critical at 10x, with the driving label', () => {
      const run = (series: number) => evaluateFindings([service({ metrics: [metric({ name: 'm', series, labels })] })], S);
      assert.strictEqual(run(S.maxSeriesPerMetric - 1).length, 0);
      const [warn] = run(S.maxSeriesPerMetric);
      assert.deepStrictEqual([warn.rule, warn.kind, warn.severity, warn.driver], ['R3', 'metricSeries', 'warning', { label: 'route', distinct: 80 }]);
      assert.strictEqual(run(10 * S.maxSeriesPerMetric)[0].severity, 'critical');
    });

    it('makes id-like metric labels critical even with few series', () => {
      const fs = evaluateFindings(
        [service({ metrics: [metric({ name: 'orders', series: 30, labels: [key({ key: 'user.id', scope: 'metric', distinct: 30 })] })] })],
        S
      );
      assert.deepStrictEqual(
        fs.map((f) => [f.rule, f.kind, f.severity, f.metric, f.key]),
        [['R2', 'metricLabel', 'critical', 'orders', 'user.id']]
      );
    });
  });

  describe('R4 span names', () => {
    const run = (distinct: number, classified: number, withIds: number) =>
      evaluateFindings([service({ spanNames: { distinct, approx: false, classified, withIds, samples: ['GET /users/1'] } })], S);

    it('flags many names or names embedding ids', () => {
      assert.strictEqual(run(S.maxSpanNamesPerService - 1, 20, 3).length, 0);
      assert.strictEqual(run(S.maxSpanNamesPerService, 20, 0)[0].rule, 'R4');
      assert.strictEqual(run(10 * S.maxSpanNamesPerService, 64, 0)[0].severity, 'critical');
      const [ids] = run(10, 10, 2);
      assert.deepStrictEqual([ids.severity, ids.valueClass, ids.samples], ['warning', 'pathId', ['GET /users/1']]);
    });

    it('needs a few classified names before judging the id share', () => {
      assert.strictEqual(run(4, 4, 4).length, 0);
    });
  });

  describe('R5 growth', () => {
    it('classifies growing, saturated and insufficient histories', () => {
      const series = (values: number[]) => [...values, ...new Array<number>(60 - values.length).fill(NaN)];
      assert.strictEqual(growthOf(series([1, 2, 3])), 'insufficient');
      assert.strictEqual(growthOf(series([10, 20, 30, 40, 50, 60, 70])), 'growing');
      assert.strictEqual(growthOf(series([10, 40, 60, 70, 71, 71, 71])), 'saturated');
      assert.strictEqual(growthOf(series([5, 5, 5, 5, 5])), 'saturated');
      assert.strictEqual(growthOf(series([5, 5, 5, 5, 9, 14])), 'growing');
      assert.strictEqual(growthOf([NaN, 1, NaN, 2, 3, 4, NaN]), 'growing', 'gaps are skipped');
      assert.strictEqual(growthOf([10, 9.5, 10, 10]), 'saturated', 'estimate noise is not growth');
    });

    it('raises severity one level while values keep arriving', () => {
      const growing = Array.from({ length: 60 }, (_, i) => (i < 59 ? 100 + i * 10 : NaN));
      const [f] = evaluateFindings([service({ keys: [key({ key: 'k', distinct: 200, occurrences: 200, history: () => growing })] })], S);
      assert.deepStrictEqual([f.growth, f.severity], ['growing', 'critical']);
    });
  });

  describe('R6 noisy log templates', () => {
    it('reports a template holding half the logs, from enough logs', () => {
      const run = (logs: number, count: number) =>
        evaluateFindings([service({ logs, templates: [{ text: 'Cache miss for key <*>', count, proto: 50, sample: 'Cache miss for key a' }] })], S);
      assert.strictEqual(run(NOISY_TEMPLATE_MIN_LOGS - 1, NOISY_TEMPLATE_MIN_LOGS - 1).length, 0);
      assert.strictEqual(run(200, 99).length, 0);
      const [f] = run(200, 100);
      assert.deepStrictEqual([f.rule, f.severity, f.kind, f.signal, f.samples], ['R6', 'info', 'logTemplate', 'logs', ['Cache miss for key a']]);
    });
  });

  it('orders by severity, bytes, unique values, service and key; ids are stable', () => {
    const a = service({ service: 'a', keys: [key({ key: 'x', classes: ids, distinct: 30, proto: 10 }), key({ key: 'y', classes: ids, distinct: 30, proto: 20 })] });
    const b = service({ service: 'b', keys: [key({ key: 'x', classes: ids, distinct: 30, proto: 10 })], metrics: [metric({ name: 'm', series: 30, labels: [key({ key: 'user.id', scope: 'metric', distinct: 30 })] })] });
    const fs = evaluateFindings([b, a], S);
    assert.deepStrictEqual(
      fs.map((f) => `${f.severity}:${f.service}:${f.key}`),
      ['critical:b:user.id', 'warning:a:y', 'warning:a:x', 'warning:b:x']
    );
    assert.deepStrictEqual(
      evaluateFindings([a, b], S).map((f) => f.id),
      fs.map((f) => f.id)
    );
    assert.strictEqual(new Set(fs.map((f) => f.id)).size, fs.length);
  });

  describe('settings', () => {
    it('clamps, rounds and falls back to defaults', () => {
      assert.deepStrictEqual(sanitizeCardinalitySettings(undefined), S);
      assert.deepStrictEqual(
        sanitizeCardinalitySettings({ minDistinct: 3, minDistinctRatio: 2, maxSeriesPerMetric: 1e9, maxSpanNamesPerService: 50.6 }),
        { minDistinct: 10, minDistinctRatio: 1, maxSeriesPerMetric: 1_000_000, maxSpanNamesPerService: 51 }
      );
      assert.deepStrictEqual(sanitizeCardinalitySettings({ minDistinct: '500', minDistinctRatio: NaN, maxSeriesPerMetric: null }), S);
    });

    it('package.json defaults, ranges and scopes match', () => {
      const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
      const props = pkg.contributes.configuration.properties;
      for (const k of Object.keys(S) as (keyof typeof S)[]) {
        const p = props[`otel.cardinality.${k}`];
        assert.strictEqual(p.default, S[k], k);
        assert.strictEqual(p.scope, 'resource', k);
        assert.strictEqual(sanitizeCardinalitySettings({ [k]: p.minimum - 1 })[k], p.minimum, `${k} minimum`);
        assert.strictEqual(sanitizeCardinalitySettings({ [k]: p.maximum + 1 })[k], p.maximum, `${k} maximum`);
      }
      assert.strictEqual(props['otel.cardinality.enabled'].default, true);
      assert.strictEqual(props['otel.cardinality.enabled'].scope, 'window');
    });
  });
});
