// SPDX-License-Identifier: Apache-2.0
// Caps that bound cardinality-tracking memory, and the store-wide budgets shared by all instances.
// Pure; no vscode import.

export interface CardinalityCaps {
  keysPerInstance: number;
  keysTotal: number;
  operationsPerInstance: number;
  metricsPerInstance: number;
  metricsTotal: number;
  templatesPerInstance: number;
  templatesTotal: number;
  samplesPerKey: number;
  sampleChars: number;
}

export const DEFAULT_CARDINALITY_CAPS: Readonly<CardinalityCaps> = Object.freeze({
  keysPerInstance: 512,
  keysTotal: 4096,
  operationsPerInstance: 500,
  metricsPerInstance: 500,
  metricsTotal: 1024,
  templatesPerInstance: 500,
  templatesTotal: 2000,
  samplesPerKey: 3,
  sampleChars: 120,
});

/** Longer attribute keys and metric names are not tracked (counted as dropped), so names can't inflate memory. */
export const MAX_KEY_CHARS = 256;

/** A counted allowance: acquire before allocating, release when the owner is dropped. */
export class Budget {
  private inUse = 0;

  constructor(readonly limit: number) {
    checkCount(limit);
  }

  get used(): number {
    return this.inUse;
  }

  tryAcquire(n = 1): boolean {
    checkCount(n);
    if (this.inUse + n > this.limit) return false;
    this.inUse += n;
    return true;
  }

  release(n: number): void {
    checkCount(n);
    if (n > this.inUse) throw new RangeError(`releasing ${n} but only ${this.inUse} in use`);
    this.inUse -= n;
  }
}

function checkCount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`invalid count: ${n}`);
}

/** Store-wide budgets; per-instance caps are enforced by each tracker. */
export class CardinalityBudget {
  readonly keys: Budget;
  readonly metrics: Budget;
  readonly templates: Budget;

  constructor(caps: Pick<CardinalityCaps, 'keysTotal' | 'metricsTotal' | 'templatesTotal'> = DEFAULT_CARDINALITY_CAPS) {
    this.keys = new Budget(caps.keysTotal);
    this.metrics = new Budget(caps.metricsTotal);
    this.templates = new Budget(caps.templatesTotal);
  }
}
