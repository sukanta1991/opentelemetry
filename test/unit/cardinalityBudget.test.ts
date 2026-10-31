// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Budget, CardinalityBudget, DEFAULT_CARDINALITY_CAPS } from '../../src/store/cardinality/budget';

describe('cardinality budget', () => {
  it('grants up to the limit and refuses beyond it without partial grants', () => {
    const b = new Budget(3);
    assert.strictEqual(b.tryAcquire(), true);
    assert.strictEqual(b.tryAcquire(2), true);
    assert.strictEqual(b.tryAcquire(), false);
    assert.strictEqual(b.used, 3);
    b.release(2);
    assert.strictEqual(b.tryAcquire(3), false);
    assert.strictEqual(b.used, 1);
    assert.strictEqual(b.tryAcquire(2), true);
  });

  it('allows a zero limit', () => {
    const b = new Budget(0);
    assert.strictEqual(b.tryAcquire(), false);
    assert.strictEqual(b.tryAcquire(0), true);
  });

  it('throws on releasing more than is in use', () => {
    const b = new Budget(5);
    b.tryAcquire(2);
    assert.throws(() => b.release(3), RangeError);
    assert.strictEqual(b.used, 2);
  });

  it('rejects negative, fractional and non-finite counts', () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => new Budget(bad), RangeError, `limit ${bad}`);
      assert.throws(() => new Budget(10).tryAcquire(bad), RangeError, `acquire ${bad}`);
      assert.throws(() => new Budget(10).release(bad), RangeError, `release ${bad}`);
    }
  });

  it('sizes store-wide budgets from the caps', () => {
    const b = new CardinalityBudget();
    assert.strictEqual(b.keys.limit, DEFAULT_CARDINALITY_CAPS.keysTotal);
    assert.strictEqual(b.metrics.limit, DEFAULT_CARDINALITY_CAPS.metricsTotal);
    assert.strictEqual(b.templates.limit, DEFAULT_CARDINALITY_CAPS.templatesTotal);
    const custom = new CardinalityBudget({ keysTotal: 2, metricsTotal: 3, templatesTotal: 1 });
    assert.strictEqual(custom.keys.limit, 2);
    assert.strictEqual(custom.metrics.limit, 3);
    assert.strictEqual(custom.templates.limit, 1);
  });

  it('freezes the default caps', () => {
    assert.ok(Object.isFrozen(DEFAULT_CARDINALITY_CAPS));
    assert.ok(DEFAULT_CARDINALITY_CAPS.keysPerInstance <= DEFAULT_CARDINALITY_CAPS.keysTotal);
    assert.ok(DEFAULT_CARDINALITY_CAPS.metricsPerInstance <= DEFAULT_CARDINALITY_CAPS.metricsTotal);
    assert.ok(DEFAULT_CARDINALITY_CAPS.templatesPerInstance <= DEFAULT_CARDINALITY_CAPS.templatesTotal);
  });
});
