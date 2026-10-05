// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import {
  MAX_ARRAY_ITEMS,
  MAX_ATTRS_PER_OBJECT,
  MAX_RESULT_CHARS,
  MAX_STRING_CHARS,
  MAX_VALUE_DEPTH,
} from '../../src/ai/limits';
import { fitResult, iso, safeValue } from '../../src/ai/serialize';

describe('ai serialize', () => {
  describe('safeValue', () => {
    it('truncates long strings with an ellipsis', () => {
      const out = safeValue('x'.repeat(MAX_STRING_CHARS + 10)) as string;
      assert.strictEqual(out.length, MAX_STRING_CHARS + 1);
      assert.ok(out.endsWith('…'));
      assert.strictEqual(safeValue('short'), 'short');
    });

    it('does not split a surrogate pair', () => {
      const s = 'a'.repeat(MAX_STRING_CHARS - 1) + '😀' + 'b';
      const out = safeValue(s) as string;
      assert.ok(!out.includes('\ud83d…'));
      assert.strictEqual(out, 'a'.repeat(MAX_STRING_CHARS - 1) + '…');
    });

    it('caps depth', () => {
      let v: unknown = 'leaf';
      for (let i = 0; i < MAX_VALUE_DEPTH + 3; i++) v = { n: v };
      let cur = safeValue(v) as any;
      for (let i = 0; i < MAX_VALUE_DEPTH; i++) cur = cur.n;
      assert.strictEqual(cur.n, '[depth]');
    });

    it('keeps the first sorted keys and first array items', () => {
      const obj: Record<string, number> = {};
      for (let i = MAX_ATTRS_PER_OBJECT + 9; i >= 0; i--) obj[`k${String(i).padStart(3, '0')}`] = i;
      const keys = Object.keys(safeValue(obj) as object);
      assert.strictEqual(keys.length, MAX_ATTRS_PER_OBJECT);
      assert.strictEqual(keys[0], 'k000');
      assert.deepStrictEqual(keys, [...keys].sort());
      const arr = safeValue(Array.from({ length: 50 }, (_, i) => i)) as number[];
      assert.strictEqual(arr.length, MAX_ARRAY_ITEMS);
      assert.strictEqual(arr[0], 0);
    });

    it('turns non-finite numbers into null and returns a new value', () => {
      assert.deepStrictEqual(safeValue({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 }), {
        a: null,
        b: null,
        c: null,
        d: 1.5,
      });
      const input = { nested: { s: 'x' } };
      const out = safeValue(input) as typeof input;
      assert.notStrictEqual(out, input);
      assert.notStrictEqual(out.nested, input.nested);
    });

    it('never throws, even on throwing getters, cycles or odd types', () => {
      const bad = {
        get boom(): string {
          throw new Error('nope');
        },
      };
      assert.doesNotThrow(() => safeValue(bad));
      const cyc: any = { a: 1 };
      cyc.self = cyc;
      assert.doesNotThrow(() => JSON.stringify(safeValue(cyc)));
      assert.strictEqual(safeValue(10n), '10');
      assert.strictEqual(safeValue(() => 1), null);
      assert.strictEqual(safeValue(Symbol('s')), null);
    });

    it('keeps a "__proto__" key as data', () => {
      const input = JSON.parse('{"__proto__": {"polluted": true}}');
      const out = safeValue(input) as any;
      assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
      assert.strictEqual(({} as any).polluted, undefined);
      assert.strictEqual(JSON.stringify(out), '{"__proto__":{"polluted":true}}');
    });
  });

  describe('fitResult', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i, text: 'y'.repeat(100) }));

    it('returns the full object when it fits', () => {
      const obj = { total: 3, rows: rows(3) };
      assert.deepStrictEqual(JSON.parse(fitResult(obj, 'rows')), obj);
    });

    it('drops trailing list entries and reports how many were omitted', () => {
      const obj = { total: 1000, rows: rows(1000) };
      const text = fitResult(obj, 'rows');
      assert.ok(text.length <= MAX_RESULT_CHARS);
      const parsed = JSON.parse(text);
      assert.strictEqual(parsed.truncated, true);
      assert.strictEqual(parsed.rows.length + parsed.omitted, 1000);
      assert.strictEqual(parsed.rows[0].i, 0);
      // Keeps as many entries as fit: one more would overflow.
      const oneMore = JSON.stringify({
        ...obj,
        rows: obj.rows.slice(0, parsed.rows.length + 1),
        truncated: true,
        omitted: parsed.omitted - 1,
      });
      assert.ok(oneMore.length > MAX_RESULT_CHARS);
      assert.strictEqual(obj.rows.length, 1000, 'input list is not mutated');
    });

    it('returns a small error when even an empty list does not fit', () => {
      const obj = { blob: 'z'.repeat(MAX_RESULT_CHARS), rows: rows(2) };
      assert.deepStrictEqual(JSON.parse(fitResult(obj, 'rows')), { error: 'result too large' });
      assert.deepStrictEqual(JSON.parse(fitResult({ blob: 'z'.repeat(MAX_RESULT_CHARS) }, 'rows')), {
        error: 'result too large',
      });
    });

    it('always returns parseable JSON', () => {
      const cyc: any = { rows: [] };
      cyc.self = cyc;
      assert.ok(JSON.parse(fitResult(cyc, 'rows')).error);
      for (const n of [0, 1, 50, 240, 241, 5000]) {
        const text = fitResult({ rows: rows(n) }, 'rows');
        assert.ok(text.length <= MAX_RESULT_CHARS);
        assert.doesNotThrow(() => JSON.parse(text));
      }
    });
  });

  describe('iso', () => {
    it('formats UTC and rejects 0 and invalid input', () => {
      assert.strictEqual(iso(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '2026-01-02T03:04:05.006Z');
      assert.strictEqual(iso(0), null);
      assert.strictEqual(iso(NaN), null);
      assert.strictEqual(iso(Infinity), null);
      assert.strictEqual(iso(undefined), null);
      assert.strictEqual(iso(9e15), null);
    });
  });
});
