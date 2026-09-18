import * as assert from 'assert';
import {
  AGG_LABEL,
  AGG_OPTIONS,
  aggsFor,
  bucketSecondsFor,
  CHART_OPTIONS,
  chartKindsFor,
  DEFAULT_RANGE,
  isAggKind,
  isChartKind,
  isRangeKind,
  niceBucketSeconds,
  RANGE_LABEL,
  RANGE_OPTIONS,
  RANGE_SECONDS,
  STEP_LABEL,
  STEP_OPTIONS,
  STEP_SECONDS,
  DEFAULT_STEP,
  isStepKind,
  presentedType,
} from '../../src/views/webview/chartTypes';
import { computeRate, stack } from '../../src/views/webview/transforms';

describe('chartTypes', () => {
  it('maps sum monotonicity to counter / updowncounter', () => {
    assert.strictEqual(presentedType('sum', true), 'counter');
    assert.strictEqual(presentedType('sum', false), 'updowncounter');
    assert.strictEqual(presentedType('sum', undefined), 'updowncounter');
  });

  it('maps the remaining metric types 1:1', () => {
    assert.strictEqual(presentedType('gauge'), 'gauge');
    assert.strictEqual(presentedType('histogram'), 'histogram');
    assert.strictEqual(presentedType('exponentialHistogram'), 'exponentialHistogram');
    assert.strictEqual(presentedType('summary'), 'summary');
    assert.strictEqual(presentedType('unknown'), 'unknown');
  });

  it('lists the default kind first without duplicates', () => {
    for (const pt of Object.keys(CHART_OPTIONS) as (keyof typeof CHART_OPTIONS)[]) {
      const kinds = chartKindsFor(pt);
      assert.strictEqual(kinds[0], CHART_OPTIONS[pt].default);
      assert.strictEqual(new Set(kinds).size, kinds.length);
    }
  });

  it('validates chart kinds', () => {
    assert.ok(isChartKind('line'));
    assert.ok(isChartKind('percentile'));
    assert.ok(!isChartKind('pie'));
    assert.ok(!isChartKind(null));
  });

  it('offers raw first and labels every aggregation', () => {
    for (const pt of Object.keys(AGG_OPTIONS) as (keyof typeof AGG_OPTIONS)[]) {
      const aggs = aggsFor(pt);
      assert.strictEqual(aggs[0], 'raw');
      assert.strictEqual(new Set(aggs).size, aggs.length);
      for (const a of aggs) assert.ok(AGG_LABEL[a], `missing label for ${a}`);
    }
  });

  it('offers no over-time rollup for histograms', () => {
    assert.deepStrictEqual(aggsFor('histogram'), ['raw']);
    assert.ok(aggsFor('gauge').includes('p95'));
    assert.ok(aggsFor('counter').includes('count'));
  });

  it('validates aggregation kinds', () => {
    assert.ok(isAggKind('raw'));
    assert.ok(isAggKind('stddev'));
    assert.ok(!isAggKind('none'));
    assert.ok(!isAggKind(undefined));
  });

  it('covers every range with seconds, a label and a bucket width', () => {
    assert.ok(RANGE_OPTIONS.includes(DEFAULT_RANGE));
    for (const r of RANGE_OPTIONS) {
      assert.ok(RANGE_SECONDS[r] > 0, `missing seconds for ${r}`);
      assert.ok(RANGE_LABEL[r], `missing label for ${r}`);
      const bucket = bucketSecondsFor(r);
      assert.ok(bucket > 0, `missing bucket for ${r}`);
      // ~60 buckets. Targeting many more would put a single sample in each bucket for a
      // typical 10-60s exporter, collapsing every aggregation onto the raw value.
      assert.strictEqual(RANGE_SECONDS[r] / bucket, 60, `${r} bucket count`);
    }
  });

  it('orders ranges from shortest to longest', () => {
    const secs = RANGE_OPTIONS.map((r) => RANGE_SECONDS[r]);
    assert.deepStrictEqual(secs, [...secs].sort((a, b) => a - b));
  });

  it('validates range kinds', () => {
    assert.ok(isRangeKind('15m'));
    assert.ok(!isRangeKind('24h'));
    assert.ok(!isRangeKind(900));
  });

  it('snaps derived bucket widths to readable steps', () => {
    // A real .NET exporter reports this interval; it must not reach the UI verbatim.
    assert.strictEqual(niceBucketSeconds(59.999058961868286), 60);
    assert.strictEqual(niceBucketSeconds(60.001), 60);
    assert.strictEqual(niceBucketSeconds(5), 5);
    assert.strictEqual(niceBucketSeconds(0), 0);
    assert.strictEqual(niceBucketSeconds(-1), 0);
  });

  it('rounds a derived bucket up rather than below the sample spacing', () => {
    assert.strictEqual(niceBucketSeconds(45), 60);
    assert.strictEqual(niceBucketSeconds(11), 15);
    assert.strictEqual(niceBucketSeconds(5000), 7200);
  });

  it('keeps every range bucket on a nice step', () => {
    for (const r of RANGE_OPTIONS) {
      assert.strictEqual(niceBucketSeconds(bucketSecondsFor(r)), bucketSecondsFor(r));
    }
  });

  it('covers every step with seconds and a label', () => {
    assert.strictEqual(STEP_OPTIONS[0], DEFAULT_STEP);
    assert.strictEqual(STEP_SECONDS.auto, 0, 'auto must fall back to the range bucket');
    for (const s of STEP_OPTIONS) {
      assert.ok(STEP_LABEL[s], `missing label for ${s}`);
      if (s !== 'auto') {
        assert.ok(STEP_SECONDS[s] > 0, `missing seconds for ${s}`);
        assert.strictEqual(niceBucketSeconds(STEP_SECONDS[s]), STEP_SECONDS[s]);
      }
    }
  });

  it('offers steps coarser than a one-minute exporter so aggregations differ', () => {
    const coarser = STEP_OPTIONS.filter((s) => STEP_SECONDS[s] > 60);
    assert.ok(coarser.length >= 3, 'need steps above a 60s sample interval');
  });

  it('validates step kinds', () => {
    assert.ok(isStepKind('auto'));
    assert.ok(isStepKind('5m'));
    assert.ok(!isStepKind('7m'));
    assert.ok(!isStepKind(300));
  });
});

describe('transforms', () => {
  it('computeRate returns per-second deltas and null for the first sample', () => {
    const xs = [0, 1, 2, 3];
    const ys = [10, 12, 18, 20];
    assert.deepStrictEqual(computeRate(xs, ys), [null, 2, 6, 2]);
  });

  it('computeRate clamps counter resets to null', () => {
    const xs = [0, 1, 2];
    const ys = [100, 40, 60];
    assert.deepStrictEqual(computeRate(xs, ys), [null, null, 20]);
  });

  it('computeRate keeps signed deltas when resets are not clamped', () => {
    const xs = [0, 1, 2];
    const ys = [100, 40, 60];
    assert.deepStrictEqual(computeRate(xs, ys, false), [null, -60, 20]);
  });

  it('computeRate guards non-positive dt and null samples', () => {
    const xs = [0, 0, 1];
    const ys = [1, null, 5];
    assert.deepStrictEqual(computeRate(xs, ys), [null, null, null]);
  });

  it('stack accumulates bands and treats nulls as zero', () => {
    const a = [1, 2, 3];
    const b = [10, null, 30];
    assert.deepStrictEqual(stack([a, b]), [
      [1, 2, 3],
      [11, 2, 33],
    ]);
  });
});
