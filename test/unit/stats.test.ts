import * as assert from 'assert';
import {
  bucketAxis,
  bucketSeries,
  hasIsolatedPoints,
  histogramMean,
  histogramQuantile,
  medianInterval,
  quantile,
  reduceAcrossSeries,
  reduceOverTime,
  stddev,
  windowSeries,
} from '../../src/views/webview/stats';

describe('stats', () => {
  it('quantile interpolates and handles edges', () => {
    const xs = [1, 2, 3, 4];
    assert.strictEqual(quantile(xs, 0), 1);
    assert.strictEqual(quantile(xs, 1), 4);
    assert.strictEqual(quantile(xs, 0.5), 2.5);
    assert.strictEqual(quantile([], 0.5), null);
    assert.strictEqual(quantile([7], 0.9), 7);
  });

  it('reduceOverTime computes stats and ignores nulls', () => {
    const ys = [10, null, 30, 50];
    assert.strictEqual(reduceOverTime(ys, 'last'), 50);
    assert.strictEqual(reduceOverTime(ys, 'min'), 10);
    assert.strictEqual(reduceOverTime(ys, 'max'), 50);
    assert.strictEqual(reduceOverTime(ys, 'sum'), 90);
    assert.strictEqual(reduceOverTime(ys, 'avg'), 30);
    assert.strictEqual(reduceOverTime(ys, 'count'), 3);
    assert.strictEqual(reduceOverTime(ys, 'raw'), null);
    assert.strictEqual(reduceOverTime([], 'avg'), null);
  });

  it('stddev is zero for constant input', () => {
    assert.strictEqual(stddev([5, 5, 5]), 0);
  });

  it('histogramQuantile interpolates within the located bucket', () => {
    // bounds [1,2,5]; counts [2,2,4,0] -> total 8; p50 rank 4 falls at end of 2nd bucket.
    const bounds = [1, 2, 5];
    const counts = [2, 2, 4, 0];
    assert.strictEqual(histogramQuantile(bounds, counts, 0.5), 2);
    // p95 rank 7.6 falls in the [2,5] bucket (cumulative 4..8).
    const p95 = histogramQuantile(bounds, counts, 0.95)!;
    assert.ok(p95 > 2 && p95 <= 5, `p95=${p95}`);
    assert.strictEqual(histogramQuantile([], [], 0.5), null);
    assert.strictEqual(histogramQuantile([1], [0, 0], 0.5), null);
  });

  it('histogramMean guards missing/zero count', () => {
    assert.strictEqual(histogramMean(100, 10), 10);
    assert.strictEqual(histogramMean(100, 0), null);
    assert.strictEqual(histogramMean(undefined, 10), null);
  });

  it('reduceAcrossSeries aggregates per timestamp and skips gaps', () => {
    const a = [1, 2, 3];
    const b = [10, null, 30];
    assert.deepStrictEqual(reduceAcrossSeries([a, b], 'sum'), [11, 2, 33]);
    assert.deepStrictEqual(reduceAcrossSeries([a, b], 'avg'), [5.5, 2, 16.5]);
    assert.deepStrictEqual(reduceAcrossSeries([a, b], 'max'), [10, 2, 30]);
    assert.deepStrictEqual(reduceAcrossSeries([a, b], 'none'), a);
  });
});

describe('windowSeries', () => {
  const xs = [0, 10, 20, 30, 40];
  const ys = [[1, 2, 3, 4, 5]];

  it('keeps one sample before the window so rate has a predecessor', () => {
    const w = windowSeries(xs, ys, 20, 40);
    assert.deepStrictEqual(w.xs, [10, 20, 30, 40]);
    assert.deepStrictEqual(w.seriesYs, [[2, 3, 4, 5]]);
  });

  it('trims samples after the window end', () => {
    const w = windowSeries(xs, ys, 0, 20);
    assert.deepStrictEqual(w.xs, [0, 10, 20]);
    assert.deepStrictEqual(w.seriesYs, [[1, 2, 3]]);
  });

  it('returns empty aligned output when nothing falls inside', () => {
    const w = windowSeries(xs, ys, 100, 200);
    assert.deepStrictEqual(w.xs, []);
    assert.deepStrictEqual(w.seriesYs, [[]]);
  });

  it('passes through a fully contained window', () => {
    const w = windowSeries(xs, ys, -10, 100);
    assert.deepStrictEqual(w.xs, xs);
  });
});

describe('bucketSeries', () => {
  it('returns the input untouched for raw', () => {
    const xs = [0, 1, 2];
    const ys = [1, 2, 3];
    const b = bucketSeries(xs, ys, 10, 'raw');
    assert.strictEqual(b.xs, xs);
    assert.strictEqual(b.ys, ys);
  });

  it('floors samples onto bucket boundaries and aggregates them', () => {
    const xs = [0, 3, 7, 12, 18];
    const ys = [1, 3, 5, 10, 20];
    const b = bucketSeries(xs, ys, 10, 'avg');
    assert.deepStrictEqual(b.xs, [0, 10]);
    assert.deepStrictEqual(b.ys, [3, 15]);
  });

  it('emits null for empty buckets so gaps stay gaps', () => {
    const xs = [0, 25];
    const ys = [4, 8];
    const b = bucketSeries(xs, ys, 10, 'sum');
    assert.deepStrictEqual(b.xs, [0, 10, 20]);
    assert.deepStrictEqual(b.ys, [4, null, 8]);
  });

  it('drops nulls inside a bucket and counts the survivors', () => {
    const xs = [0, 2, 4];
    const ys = [5, null, 15];
    assert.deepStrictEqual(bucketSeries(xs, ys, 10, 'count').ys, [2]);
    assert.deepStrictEqual(bucketSeries(xs, ys, 10, 'max').ys, [15]);
  });

  it('gives every series of a metric the same axis', () => {
    const xs = [0, 5, 14, 21];
    const a = bucketSeries(xs, [1, 2, 3, 4], 10, 'avg');
    const b = bucketSeries(xs, [null, null, null, null], 10, 'avg');
    assert.deepStrictEqual(a.xs, bucketAxis(xs, 10));
    assert.deepStrictEqual(a.xs, b.xs);
    assert.deepStrictEqual(b.ys, [null, null, null]);
  });

  it('handles a single sample and empty input', () => {
    assert.deepStrictEqual(bucketSeries([7], [9], 10, 'avg'), { xs: [0], ys: [9] });
    assert.deepStrictEqual(bucketSeries([], [], 10, 'avg'), { xs: [], ys: [] });
  });
});

describe('hasIsolatedPoints', () => {
  it('detects values that cannot form a line segment', () => {
    assert.ok(hasIsolatedPoints([5]));
    assert.ok(hasIsolatedPoints([1, null, 2]));
    assert.ok(hasIsolatedPoints([null, 7, null, null]));
    assert.ok(!hasIsolatedPoints([1, 2, 3]));
    assert.ok(!hasIsolatedPoints([null, 1, 2, null]));
    assert.ok(!hasIsolatedPoints([]));
    assert.ok(!hasIsolatedPoints([null, null]));
  });

  it('flags a bucketed series whose samples arrive in bursts', () => {
    // Median interval is 10s, so the two-minute stall still empties buckets between
    // the bursts and strands the lone sample at t=180.
    const xs = [0, 10, 20, 180, 360, 370];
    const ys = [1, 2, 3, 4, 5, 6];
    const b = bucketSeries(xs, ys, Math.max(5, medianInterval(xs)), 'avg');
    assert.ok(b.ys.some((v) => v == null));
    assert.ok(hasIsolatedPoints(b.ys));
  });

  it('is quiet for a series bucketed at its own sample interval', () => {
    const xs = [0, 60, 120, 180];
    const ys = [1, 1, 0, 1];
    const b = bucketSeries(xs, ys, Math.max(5, medianInterval(xs)), 'avg');
    assert.ok(!hasIsolatedPoints(b.ys));
  });
});

describe('medianInterval', () => {
  it('reports the typical spacing and ignores non-advancing samples', () => {
    assert.strictEqual(medianInterval([0, 60, 120, 180]), 60);
    assert.strictEqual(medianInterval([0, 59, 121, 180]), 59);
    assert.strictEqual(medianInterval([5, 5, 5]), 0);
    assert.strictEqual(medianInterval([5]), 0);
    assert.strictEqual(medianInterval([]), 0);
  });

  it('keeps sparsely exported series connected when used as a bucket floor', () => {
    // Samples a minute apart bucketed at 5s would isolate every point behind nulls,
    // leaving uPlot with no adjacent pair to draw a segment between.
    const xs = [0, 60, 120, 180];
    const ys = [1, 1, 0, 1];
    assert.deepStrictEqual(bucketSeries(xs, ys, 5, 'avg').ys.filter((v) => v != null).length, 4);
    assert.ok(bucketSeries(xs, ys, 5, 'avg').ys.some((v) => v == null));

    const floored = Math.max(5, medianInterval(xs));
    assert.deepStrictEqual(bucketSeries(xs, ys, floored, 'avg'), { xs, ys });
  });
});
