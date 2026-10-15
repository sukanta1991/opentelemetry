// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { bhAdjust, erfc, logFactorial, mannWhitney, proportionTest } from '../../src/views/baselineStats';

// Reference values from scipy 1.18.1 (mannwhitneyu asymptotic + continuity, fisher_exact, false_discovery_control).
const near = (actual: number, expected: number, rel: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= rel * Math.abs(expected) + 1e-15, `${msg ?? ''} ${actual} vs ${expected}`);

const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);

describe('baselineStats', () => {
  describe('erfc', () => {
    it('matches reference values', () => {
      const cases: [number, number][] = [
        [0, 1],
        [0.5, 0.4795001221869535],
        [1, 0.15729920705028516],
        [2, 0.004677734981047266],
        [3, 2.2090496998585445e-5],
        [-1, 1.8427007929497148],
      ];
      for (const [x, v] of cases) near(erfc(x), v, 1.2e-7, `erfc(${x})`);
    });
  });

  describe('logFactorial', () => {
    it('matches reference values', () => {
      assert.strictEqual(logFactorial(0), 0);
      assert.strictEqual(logFactorial(1), 0);
      const cases: [number, number][] = [
        [5, 4.787491742782046],
        [20, 42.335616460753485],
        [170, 706.5730622457875],
        [10000, 82108.92783681436],
      ];
      for (const [n, v] of cases) near(logFactorial(n), v, 1e-12, `ln(${n}!)`);
    });
  });

  describe('mannWhitney', () => {
    it('matches reference p-values, with and without ties', () => {
      near(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]).p, 0.01218578035534481, 1e-6);
      near(mannWhitney([1, 2, 2, 3, 3, 3, 4], [2, 3, 4, 4, 5, 5, 6, 7]).p, 0.025279736885893918, 1e-6);
      const a = asc(Array.from({ length: 300 }, (_, i) => ((i * 7919) % 1000) / 10));
      const b = asc(Array.from({ length: 250 }, (_, i) => ((i * 104729) % 1000) / 10 + 3));
      near(mannWhitney(a, b).p, 0.3013443926392666, 1e-6);
    });

    it('signs z by which side is larger and accepts typed arrays', () => {
      const lo = [1, 2, 3, 4, 5];
      const hi = Float64Array.from([6, 7, 8, 9, 10]);
      assert.ok(mannWhitney(lo, hi).z > 0);
      assert.ok(mannWhitney(hi, lo).z < 0);
      assert.strictEqual(mannWhitney(lo, hi).p, mannWhitney(hi, lo).p);
    });

    it('reports no evidence for empty, identical, fully tied or single samples', () => {
      for (const [a, b] of [
        [[], [1, 2]],
        [[1, 2], []],
        [[1, 2, 3], [1, 2, 3]],
        [[5, 5, 5], [5, 5]],
        [[1], [2]],
      ]) {
        assert.deepStrictEqual(mannWhitney(a, b), { z: 0, p: 1 }, JSON.stringify([a, b]));
      }
    });
  });

  describe('proportionTest', () => {
    it('uses a pooled z-test when every expected cell is at least 5', () => {
      const r = proportionTest(20, 1000, 45, 1000);
      near(r.z, 3.152519949406393, 1e-12);
      near(r.p, 0.001618677606637792, 1e-6);
      assert.ok(proportionTest(45, 1000, 20, 1000).z < 0);
    });

    it('uses Fisher exact for small expected counts', () => {
      const cases: [number, number, number, number, number][] = [
        [0, 20, 3, 20, 0.2307692307692308],
        [1, 12, 8, 10, 0.001547987616099071],
        [0, 50, 4, 60, 0.12435683249367552],
        [3, 8, 0, 9, 0.08235294117647059],
      ];
      for (const [e1, n1, e2, n2, p] of cases) {
        const r = proportionTest(e1, n1, e2, n2);
        near(r.p, p, 1e-9, `${e1}/${n1} vs ${e2}/${n2}`);
        assert.strictEqual(Math.sign(r.z), Math.sign(e2 / n2 - e1 / n1));
      }
    });

    it('reports no evidence for empty groups, equal rates or no variance', () => {
      const cases: [number, number, number, number][] = [
        [0, 0, 1, 10],
        [1, 10, 0, 0],
        [2, 30, 2, 30],
        [0, 30, 0, 40],
        [30, 30, 40, 40],
      ];
      for (const args of cases) {
        assert.deepStrictEqual(proportionTest(...args), { z: 0, p: 1 }, args.join(','));
      }
    });
  });

  describe('bhAdjust', () => {
    it('matches reference q-values in input order', () => {
      const q = bhAdjust([0.01, 0.04, 0.03, 0.005, 0.5]);
      [0.025, 0.05, 0.05, 0.025, 0.5].forEach((v, i) => near(q[i], v, 1e-12, `q[${i}]`));
    });

    it('is monotone in p, capped at 1, and treats non-finite p as 1', () => {
      const p = [0.2, Number.NaN, 0.001, 0.9, 0.001, Infinity, 0.04];
      const q = bhAdjust(p);
      assert.strictEqual(q.length, p.length);
      assert.strictEqual(q[1], 1);
      assert.strictEqual(q[5], 1);
      assert.strictEqual(q[2], q[4]);
      const finite = p.map((v, i) => [v, q[i]]).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < finite.length; i++) assert.ok(finite[i][1] >= finite[i - 1][1]);
      assert.ok(q.every((v) => v <= 1));
      assert.deepStrictEqual(bhAdjust([]), []);
    });
  });
});
