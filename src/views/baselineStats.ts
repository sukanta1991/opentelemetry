// SPDX-License-Identifier: Apache-2.0
// Significance tests for baseline comparison. Pure; no vscode or DOM.

export interface TestResult {
  // Signed so callers can tell direction; 0 when there is no evidence either way.
  z: number;
  p: number;
}

const NO_EVIDENCE: TestResult = Object.freeze({ z: 0, p: 1 });

// Complementary error function, fractional error < 1.2e-7 (Numerical Recipes erfcc).
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

const twoSided = (z: number) => Math.min(1, erfc(Math.abs(z) / Math.SQRT2));

// Mann-Whitney U, normal approximation with tie and continuity correction. Both inputs sorted ascending.
// z > 0 when values in `b` tend to be larger than in `a`.
export function mannWhitney(a: ArrayLike<number>, b: ArrayLike<number>): TestResult {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return NO_EVIDENCE;
  let i = 0;
  let j = 0;
  let rank = 0;
  let rankSumA = 0;
  let ties = 0;
  while (i < n1 || j < n2) {
    const v = j >= n2 || (i < n1 && a[i] <= b[j]) ? a[i] : b[j];
    let ta = 0;
    let tb = 0;
    while (i < n1 && a[i] === v) {
      i++;
      ta++;
    }
    while (j < n2 && b[j] === v) {
      j++;
      tb++;
    }
    const t = ta + tb;
    rankSumA += ta * (rank + (t + 1) / 2);
    ties += t * t * t - t;
    rank += t;
  }
  const n = n1 + n2;
  const variance = ((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1)));
  if (!(variance > 0)) return NO_EVIDENCE;
  // U of b = n1*n2 - U of a; positive shift means b ranks higher.
  const diff = (n1 * n2) / 2 - (rankSumA - (n1 * (n1 + 1)) / 2);
  const corrected = Math.max(0, Math.abs(diff) - 0.5);
  if (corrected === 0) return NO_EVIDENCE;
  const z = (Math.sign(diff) * corrected) / Math.sqrt(variance);
  return { z, p: twoSided(z) };
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

// ln(n!) via Lanczos (g = 7), accurate to ~1e-13 relative.
export function logFactorial(n: number): number {
  if (n < 2) return 0;
  const x = n;
  let s = LANCZOS[0];
  for (let k = 1; k < LANCZOS.length; k++) s += LANCZOS[k] / (x + k);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

// Two-sided Fisher exact test on [[e1, n1-e1], [e2, n2-e2]].
function fisherExact(e1: number, n1: number, e2: number, n2: number): number {
  const n = n1 + n2;
  const errors = e1 + e2;
  const lo = Math.max(0, n1 - (n - errors));
  const hi = Math.min(n1, errors);
  const base = logFactorial(errors) + logFactorial(n - errors) + logFactorial(n1) + logFactorial(n2) - logFactorial(n);
  const logP = (k: number) =>
    base - logFactorial(k) - logFactorial(errors - k) - logFactorial(n1 - k) - logFactorial(n - errors - n1 + k);
  // Relative tolerance as in R / scipy so tables equal in probability to the observed one count.
  const cutoff = logP(e1) + Math.log1p(1e-7);
  let p = 0;
  for (let k = lo; k <= hi; k++) {
    const lp = logP(k);
    if (lp <= cutoff) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

// Error rate e2/n2 vs e1/n1: pooled z-test when every expected cell is >= 5, else Fisher exact.
// z > 0 when the second rate is higher; for Fisher only its sign is meaningful.
export function proportionTest(e1: number, n1: number, e2: number, n2: number): TestResult {
  if (!n1 || !n2) return NO_EVIDENCE;
  const n = n1 + n2;
  const errors = e1 + e2;
  const pooled = errors / n;
  const diff = e2 / n2 - e1 / n1;
  if (pooled === 0 || pooled === 1 || diff === 0) return NO_EVIDENCE;
  const minExpected = Math.min(n1, n2) * Math.min(pooled, 1 - pooled);
  if (minExpected >= 5) {
    const z = diff / Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    return { z, p: twoSided(z) };
  }
  return { z: Math.sign(diff), p: fisherExact(e1, n1, e2, n2) };
}

// Benjamini-Hochberg adjusted p-values (q), returned in input order. Non-finite p counts as 1.
export function bhAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((_, i) => i);
  const p = (i: number) => (Number.isFinite(pValues[i]) ? Math.min(1, Math.max(0, pValues[i])) : 1);
  order.sort((x, y) => p(x) - p(y) || x - y);
  const q = new Array<number>(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const i = order[r];
    running = Math.min(running, (p(i) * m) / (r + 1));
    q[i] = running;
  }
  return q;
}
