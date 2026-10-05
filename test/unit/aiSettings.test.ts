// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS } from '../../src/ai/limits';
import { sanitizeAiSettings } from '../../src/ai/aiSettings';

describe('ai settings', () => {
  it('defaults to disabled with no extra keys', () => {
    assert.deepStrictEqual(sanitizeAiSettings({}), {
      enabled: false,
      redactAttributeKeys: [],
      maxResultItems: DEFAULT_MAX_ITEMS,
    });
  });

  it('enables only for a literal true', () => {
    assert.strictEqual(sanitizeAiSettings({ enabled: true }).enabled, true);
    for (const v of ['true', 1, {}, null]) assert.strictEqual(sanitizeAiSettings({ enabled: v }).enabled, false);
  });

  it('clamps maxResultItems', () => {
    assert.strictEqual(sanitizeAiSettings({ maxResultItems: 0 }).maxResultItems, 1);
    assert.strictEqual(sanitizeAiSettings({ maxResultItems: 1e6 }).maxResultItems, HARD_MAX_ITEMS);
    assert.strictEqual(sanitizeAiSettings({ maxResultItems: 12.7 }).maxResultItems, 12);
    assert.strictEqual(sanitizeAiSettings({ maxResultItems: '50' }).maxResultItems, DEFAULT_MAX_ITEMS);
    assert.strictEqual(sanitizeAiSettings({ maxResultItems: NaN }).maxResultItems, DEFAULT_MAX_ITEMS);
  });

  it('keeps unique, non-empty, bounded string keys', () => {
    const keys = sanitizeAiSettings({
      redactAttributeKeys: [' tenant.id ', 'tenant.id', '', '  ', 42, null, 'x'.repeat(129), 'user.email'],
    }).redactAttributeKeys;
    assert.deepStrictEqual(keys, ['tenant.id', 'user.email']);
    assert.strictEqual(sanitizeAiSettings({ redactAttributeKeys: 'password' }).redactAttributeKeys.length, 0);
    const many = Array.from({ length: 150 }, (_, i) => `k${i}`);
    assert.strictEqual(sanitizeAiSettings({ redactAttributeKeys: many }).redactAttributeKeys.length, 100);
  });
});
