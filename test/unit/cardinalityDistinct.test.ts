// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { DEFAULT_CARDINALITY_CAPS } from '../../src/store/cardinality/budget';
import { DistinctCounter, EXACT_LIMIT, MAX_COUNTER_BYTES } from '../../src/store/cardinality/distinct';
import { hashString } from '../../src/store/cardinality/hash';

const SEED = 7;
const hashes = (from: number, to: number, seed = SEED): number[] =>
  Array.from({ length: to - from }, (_, i) => hashString(`value-${from + i}`, seed));

function counterOf(hs: number[]): DistinctCounter {
  const c = new DistinctCounter();
  for (const h of hs) c.add(h);
  return c;
}

const relError = (estimate: number, actual: number) => Math.abs(estimate - actual) / actual;

describe('DistinctCounter', () => {
  it('counts exactly up to EXACT_LIMIT and reports new values', () => {
    const c = new DistinctCounter();
    const hs = hashes(0, EXACT_LIMIT);
    for (const h of hs) assert.strictEqual(c.add(h), true);
    for (const h of hs) assert.strictEqual(c.add(h), false);
    assert.strictEqual(c.estimate(), EXACT_LIMIT);
    assert.strictEqual(c.approx, false);
  });

  it('tracks hash 0 and the maximum hash like any other value', () => {
    const c = new DistinctCounter();
    assert.strictEqual(c.add(0), true);
    assert.strictEqual(c.add(0), false);
    assert.strictEqual(c.add(0xffffffff), true);
    assert.strictEqual(c.add(-1), false, '-1 is the same 32-bit value as 0xffffffff');
    assert.strictEqual(c.estimate(), 2);
  });

  it('switches to the sketch on the first value past the limit, keeping the count', () => {
    const c = counterOf(hashes(0, EXACT_LIMIT));
    c.add(0);
    assert.strictEqual(c.approx, true);
    assert.ok(Math.abs(c.estimate() - (EXACT_LIMIT + 1)) <= 3, `${c.estimate()}`);
    const before = c.estimate();
    for (const h of hashes(0, EXACT_LIMIT)) assert.strictEqual(c.add(h), false);
    assert.strictEqual(c.estimate(), before);
  });

  for (const n of [1_000, 10_000, 100_000, 1_000_000]) {
    it(`estimates ${n.toLocaleString('en-US')} unique values within 7% (3 seeds)`, function () {
      this.timeout(20_000);
      for (const seed of [1, 2, 3]) {
        const c = new DistinctCounter();
        for (let i = 0; i < n; i++) c.add(hashString(`id-${i}`, seed));
        // Duplicates must not move the estimate.
        for (let i = 0; i < n; i += 10) c.add(hashString(`id-${i}`, seed));
        const err = relError(c.estimate(), n);
        assert.ok(err <= 0.07, `seed ${seed}: estimate ${c.estimate().toFixed(0)}, error ${(err * 100).toFixed(2)}%`);
      }
    });
  }

  it('grows the exact table on demand and caps reported memory', () => {
    const small = counterOf(hashes(0, 5));
    const full = counterOf(hashes(0, EXACT_LIMIT));
    const sketch = counterOf(hashes(0, EXACT_LIMIT + 1));
    assert.ok(small.approxBytes() < full.approxBytes(), `${small.approxBytes()} vs ${full.approxBytes()}`);
    for (const c of [new DistinctCounter(), small, full, sketch]) assert.ok(c.approxBytes() <= MAX_COUNTER_BYTES);
    assert.strictEqual(sketch.approxBytes(), MAX_COUNTER_BYTES);
  });

  it('keeps counters for every store-wide key within the memory budget (P6)', () => {
    const worst = DEFAULT_CARDINALITY_CAPS.keysTotal * MAX_COUNTER_BYTES;
    assert.ok(worst <= 16 * 1024 * 1024, `${(worst / 1048576).toFixed(1)} MB`);
  });

  describe('mergeFrom', () => {
    it('stays exact when the union fits', () => {
      const a = counterOf(hashes(0, 60));
      a.mergeFrom(counterOf(hashes(40, 100)));
      assert.strictEqual(a.approx, false);
      assert.strictEqual(a.estimate(), 100);
    });

    it('switches to the sketch when the exact union overflows', () => {
      const a = counterOf(hashes(0, 100));
      a.mergeFrom(counterOf(hashes(50, 150)));
      assert.strictEqual(a.approx, true);
      assert.ok(relError(a.estimate(), 150) <= 0.05, `${a.estimate()}`);
    });

    it('unions sketches and mixed counters approximately', () => {
      const big1 = counterOf(hashes(0, 50_000));
      const big2 = counterOf(hashes(25_000, 75_000));
      const exact = counterOf(hashes(74_990, 75_010));

      const sketches = counterOf(hashes(0, 50_000));
      sketches.mergeFrom(big2);
      assert.ok(relError(sketches.estimate(), 75_000) <= 0.07, `sketch+sketch ${sketches.estimate()}`);

      const exactIntoSketch = counterOf(hashes(0, 50_000));
      exactIntoSketch.mergeFrom(exact);
      assert.ok(relError(exactIntoSketch.estimate(), 50_020) <= 0.07, `sketch+exact ${exactIntoSketch.estimate()}`);

      const sketchIntoExact = counterOf(hashes(74_990, 75_010));
      sketchIntoExact.mergeFrom(big1);
      assert.strictEqual(sketchIntoExact.approx, true);
      assert.ok(relError(sketchIntoExact.estimate(), 50_020) <= 0.07, `exact+sketch ${sketchIntoExact.estimate()}`);
    });

    it('estimates the same as one counter fed the union', () => {
      const merged = counterOf(hashes(0, 30_000));
      merged.mergeFrom(counterOf(hashes(20_000, 60_000)));
      assert.strictEqual(merged.estimate(), counterOf(hashes(0, 60_000)).estimate());
    });

    it('leaves the source counter unchanged', () => {
      const src = counterOf(hashes(0, 10));
      counterOf(hashes(0, 200)).mergeFrom(src);
      assert.strictEqual(src.estimate(), 10);
      assert.strictEqual(src.approx, false);
    });

    it('is idempotent for self-merge', () => {
      const exact = counterOf(hashes(0, 50));
      exact.mergeFrom(exact);
      assert.strictEqual(exact.estimate(), 50);
      const sketch = counterOf(hashes(0, 5_000));
      const before = sketch.estimate();
      sketch.mergeFrom(sketch);
      assert.strictEqual(sketch.estimate(), before);
    });
  });
});
