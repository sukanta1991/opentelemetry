// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { MAX_HASHED_CHARS, PROCESS_SEED, hashString, hashValue } from '../../src/store/cardinality/hash';
import { AttributeValue } from '../../src/store/model';

const SEED = 42;

describe('cardinality hash', () => {
  it('is deterministic for a seed and changes with the seed', () => {
    assert.strictEqual(hashString('GET /users/{id}', SEED), hashString('GET /users/{id}', SEED));
    let same = 0;
    for (let i = 0; i < 1000; i++) if (hashString(`v${i}`, 1) === hashString(`v${i}`, 2)) same++;
    assert.ok(same <= 1, `${same} hashes unchanged by the seed`);
  });

  it('returns unsigned 32-bit integers', () => {
    for (const s of ['', 'a', 'ab', 'abc', '\u{1F600}', 'x'.repeat(5000)]) {
      const h = hashString(s, SEED);
      assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `${s.length}: ${h}`);
    }
    assert.ok(Number.isInteger(PROCESS_SEED) && PROCESS_SEED >= 0 && PROCESS_SEED <= 0xffffffff);
  });

  it('has no collisions over 20k sequential ids', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) seen.add(hashString(`user-${i}`, SEED));
    assert.strictEqual(seen.size, 20_000);
  });

  // Sequential ids are the common case; HLL uses the top 11 bits and the exact table the low bits.
  it('spreads sequential ids evenly over high and low bits (chi-square)', () => {
    const n = 204_800;
    const buckets = 2048;
    const high = new Float64Array(buckets);
    const low = new Float64Array(buckets);
    for (let i = 0; i < n; i++) {
      const h = hashString(String(i), SEED);
      high[h >>> 21]++;
      low[h & (buckets - 1)]++;
    }
    const expected = n / buckets;
    // Mean + 5 standard deviations of a chi-square with 2047 degrees of freedom.
    const limit = buckets - 1 + 5 * Math.sqrt(2 * (buckets - 1));
    for (const [name, counts] of [['high', high], ['low', low]] as const) {
      const chi = counts.reduce((sum, c) => sum + ((c - expected) * (c - expected)) / expected, 0);
      assert.ok(chi < limit, `${name} bits chi-square ${chi.toFixed(0)} >= ${limit.toFixed(0)}`);
    }
  });

  it('keeps values of different types apart', () => {
    const values: AttributeValue[] = ['1', 1, ['1'], [1], 'true', true, '', null, '{}', {}, '[]', []];
    const hashes = values.map((v) => hashValue(v, SEED));
    assert.strictEqual(new Set(hashes).size, values.length);
  });

  it('hashes objects by sorted keys and arrays by order', () => {
    assert.strictEqual(hashValue({ a: 1, b: { c: 2, d: 3 } }, SEED), hashValue({ b: { d: 3, c: 2 }, a: 1 }, SEED));
    assert.notStrictEqual(hashValue([1, 2], SEED), hashValue([2, 1], SEED));
    assert.notStrictEqual(hashValue({ a: 1 }, SEED), hashValue({ a: 2 }, SEED));
  });

  it('treats numbers by their string form', () => {
    assert.strictEqual(hashValue(0, SEED), hashValue(-0, SEED));
    assert.notStrictEqual(hashValue(1.5, SEED), hashValue(15, SEED));
    assert.notStrictEqual(hashValue(NaN, SEED), hashValue(Infinity, SEED));
  });

  it('hashes only a bounded prefix of long strings but still tells lengths apart', () => {
    const base = 'x'.repeat(MAX_HASHED_CHARS);
    assert.strictEqual(hashString(`${base}a`, SEED), hashString(`${base}b`, SEED));
    assert.notStrictEqual(hashString(`${base}a`, SEED), hashString(`${base}ab`, SEED));
    assert.notStrictEqual(hashValue([`${base}a`], SEED), hashValue([`${base}ab`], SEED));
  });

  it('does bounded work on huge, deep or wide structured values', () => {
    const wide = Array.from({ length: 1_000_000 }, (_, i) => i);
    let deep: AttributeValue = 'leaf';
    for (let i = 0; i < 10_000; i++) deep = [deep];
    const manyKeys: Record<string, AttributeValue> = {};
    for (let i = 0; i < 50_000; i++) manyKeys[`k${i}`] = i;
    const t = process.hrtime.bigint();
    for (const v of [wide, deep, manyKeys, 'y'.repeat(10_000_000)]) {
      assert.strictEqual(hashValue(v, SEED), hashValue(v, SEED));
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  });

  it('handles prototype-named keys as plain data', () => {
    const parsed = JSON.parse('{"__proto__": 1, "constructor": "x", "toString": "y"}') as AttributeValue;
    const h = hashValue(parsed, SEED);
    assert.notStrictEqual(h, hashValue({}, SEED));
    assert.strictEqual(h, hashValue(JSON.parse('{"toString": "y", "constructor": "x", "__proto__": 1}') as AttributeValue, SEED));
  });
});
