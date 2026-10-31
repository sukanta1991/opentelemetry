// SPDX-License-Identifier: Apache-2.0
// Unique-value counter over 32-bit hashes: exact up to EXACT_LIMIT, then a HyperLogLog sketch.
// Pure; no vscode import.

export const EXACT_LIMIT = 128;
export const HLL_P = 11;
const HLL_M = 1 << HLL_P;
// Rank bits left after the register index; register values span 0..Q+1.
const HLL_Q = 32 - HLL_P;
const MIN_SLOTS = 16;
// Keeps the open-addressing table at most half full.
const MAX_SLOTS = EXACT_LIMIT * 2;
// Rough per-instance cost of the object and its typed-array headers.
const OVERHEAD_BYTES = 160;
const HIST_BYTES = (HLL_Q + 2) * 2;
/** Largest `approxBytes()` any counter can report. */
export const MAX_COUNTER_BYTES = OVERHEAD_BYTES + Math.max(MAX_SLOTS * 4, HLL_M + HIST_BYTES);

interface Sketch {
  registers: Uint8Array;
  /** How many registers hold each value, so estimates don't rescan the registers. */
  hist: Uint16Array;
}

/**
 * Counts distinct 32-bit hashes. Exact while at most EXACT_LIMIT values have been seen (a 0-valued
 * slot means empty, so hash 0 is tracked by a flag), then switches for good to HyperLogLog with
 * 2^11 registers (standard error about 2.3%), estimated with Ertl's improved raw estimator.
 */
export class DistinctCounter {
  private slots: Uint32Array | undefined = new Uint32Array(MIN_SLOTS);
  private hasZero = false;
  private size = 0;
  private sketch: Sketch | undefined;
  // Sketch estimate, valid until a register changes; -1 = stale.
  private cached = -1;

  /** True once the counter has switched to the approximate sketch. */
  get approx(): boolean {
    return this.sketch !== undefined;
  }

  /** Exact phase: whether the value is new. Approximate phase: whether the sketch changed. */
  add(hash: number): boolean {
    const h = hash >>> 0;
    if (this.sketch) return this.changed(addToSketch(this.sketch, h));
    if (this.has(h)) return false;
    if (this.size === EXACT_LIMIT) return this.changed(addToSketch(this.toSketch(), h));
    this.insert(h);
    return true;
  }

  estimate(): number {
    if (!this.sketch) return this.size;
    if (this.cached < 0) this.cached = estimateSketch(this.sketch.hist);
    return this.cached;
  }

  approxBytes(): number {
    return OVERHEAD_BYTES + (this.sketch ? HLL_M + HIST_BYTES : this.slots!.byteLength);
  }

  /** Union with another counter (both must use the same hash seed). */
  mergeFrom(other: DistinctCounter): void {
    if (other.sketch) {
      const target = this.sketch ?? this.toSketch();
      this.cached = -1;
      const src = other.sketch.registers;
      for (let i = 0; i < HLL_M; i++) {
        const r = src[i];
        if (r > target.registers[i]) {
          target.hist[target.registers[i]]--;
          target.hist[r]++;
          target.registers[i] = r;
        }
      }
      return;
    }
    other.forEachExact((h) => this.add(h));
  }

  private changed(sketchChanged: boolean): boolean {
    if (sketchChanged) this.cached = -1;
    return sketchChanged;
  }

  private has(h: number): boolean {
    if (h === 0) return this.hasZero;
    const slots = this.slots!;
    const mask = slots.length - 1;
    for (let i = h & mask; ; i = (i + 1) & mask) {
      const v = slots[i];
      if (v === h) return true;
      if (v === 0) return false;
    }
  }

  private insert(h: number): void {
    this.size++;
    if (h === 0) {
      this.hasZero = true;
      return;
    }
    if (this.size * 2 > this.slots!.length) this.grow();
    place(this.slots!, h);
  }

  private grow(): void {
    const old = this.slots!;
    const next = new Uint32Array(Math.min(old.length * 2, MAX_SLOTS));
    for (const v of old) if (v !== 0) place(next, v);
    this.slots = next;
  }

  private forEachExact(fn: (h: number) => void): void {
    if (this.hasZero) fn(0);
    if (this.slots) for (const v of this.slots) if (v !== 0) fn(v);
  }

  // One-way switch: moves the exact values into a new sketch and frees the table.
  private toSketch(): Sketch {
    const hist = new Uint16Array(HLL_Q + 2);
    hist[0] = HLL_M;
    const sketch: Sketch = { registers: new Uint8Array(HLL_M), hist };
    this.forEachExact((h) => addToSketch(sketch, h));
    this.slots = undefined;
    this.hasZero = false;
    this.size = 0;
    this.sketch = sketch;
    return sketch;
  }
}

function addToSketch(s: Sketch, h: number): boolean {
  const idx = h >>> HLL_Q;
  const w = (h << HLL_P) >>> 0;
  const rank = w === 0 ? HLL_Q + 1 : Math.clz32(w) + 1;
  const old = s.registers[idx];
  if (rank <= old) return false;
  s.registers[idx] = rank;
  s.hist[old]--;
  s.hist[rank]++;
  return true;
}

function place(slots: Uint32Array, h: number): void {
  const mask = slots.length - 1;
  let i = h & mask;
  while (slots[i] !== 0) i = (i + 1) & mask;
  slots[i] = h;
}

// Ertl, "New cardinality estimation algorithms for HyperLogLog sketches" (2017), section 4.
function estimateSketch(counts: Uint16Array): number {
  let z = HLL_M * tau(1 - counts[HLL_Q + 1] / HLL_M);
  for (let k = HLL_Q; k >= 1; k--) z = 0.5 * (z + counts[k]);
  z += HLL_M * sigma(counts[0] / HLL_M);
  return (HLL_M * HLL_M) / (2 * Math.LN2 * z);
}

function sigma(x: number): number {
  if (x === 1) return Infinity;
  let y = 1;
  let z = x;
  for (;;) {
    x *= x;
    const prev = z;
    z += x * y;
    y += y;
    if (z === prev) return z;
  }
}

function tau(x: number): number {
  if (x === 0 || x === 1) return 0;
  let y = 1;
  let z = 1 - x;
  for (;;) {
    x = Math.sqrt(x);
    const prev = z;
    y *= 0.5;
    z -= (1 - x) * (1 - x) * y;
    if (z === prev) return z / 3;
  }
}
