// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import {
  CLASSIFY_SAMPLE_LIMIT,
  ClassTally,
  classifyString,
  classifyValue,
  isIdSegment,
  isIpAddress,
} from '../../src/store/cardinality/classify';
import { classHint, keyHint } from '../../src/store/cardinality/keyHints';
import { ID_CLASSES, VALUE_CLASSES, ValueClass } from '../../src/store/cardinality/valueClass';

const CASES: [string, ValueClass][] = [
  ['3f2b8c1e-9a4d-4c7e-b1f2-0a9e8d7c6b5a', 'uuid'],
  ['3F2B8C1E-9A4D-4C7E-B1F2-0A9E8D7C6B5A', 'uuid'],
  ['4bf92f3577b34da6a3ce929d0e0e4736', 'hexId'],
  ['0x00f067aa0ba902b7', 'hexId'],
  ['12345678', 'numericId'],
  ['000123', 'numericId'],
  ['sk_live_51HxQ2bKz9vXy7Lm3Np4Qr', 'token'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'token'],
  ['alice@example.com', 'email'],
  ['10.0.0.5', 'ip'],
  ['10.0.0.5:8080', 'ip'],
  ['2001:db8::1', 'ip'],
  ['[2001:db8::1]:443', 'ip'],
  ['2026-10-30T12:34:56.789Z', 'timestamp'],
  ['2026-10-30 12:34:56+05:30', 'timestamp'],
  ['1793371517', 'timestamp'],
  ['1793371517883', 'timestamp'],
  ['https://api.example.com/search?q=shoes&page=2', 'urlQuery'],
  ['/search?session=abc', 'urlQuery'],
  ['https://api.example.com/users/12345', 'pathId'],
  ['/orders/3f2b8c1e-9a4d-4c7e-b1f2-0a9e8d7c6b5a/items', 'pathId'],
  ['SELECT * FROM orders WHERE id = 42', 'freeText'],
  ['Query a1b2 timed out after 30 ms', 'freeText'],
];

// Low-cardinality look-alikes that must not be flagged as ids.
const NOT_IDS: string[] = [
  'GET',
  'POST',
  '200',
  '404',
  '1.2.3',
  'v1.24.0',
  '2026-10-30',
  'acme',
  'feature_flag_checkout_redesign',
  'deadbeefcafebabe',
  'https://api.example.com/users',
  '/users/{id}',
  '/api/v2/orders',
  '/srv/app/repo.ts',
  'postgresql',
  'application/json',
  'ok then',
  '12345',
  'user@localhost',
  '999.1.1.1',
];

describe('cardinality classify', () => {
  for (const [value, cls] of CASES) {
    it(`classifies ${JSON.stringify(value)} as ${cls}`, () => assert.strictEqual(classifyString(value), cls));
  }

  it('does not treat versions, codes, routes, words or short numbers as ids', () => {
    for (const v of NOT_IDS) {
      const cls = classifyString(v);
      assert.ok(!ID_CLASSES.has(cls), `${v} -> ${cls}`);
    }
  });

  it('classifies non-strings by type', () => {
    assert.strictEqual(classifyValue(12345678), 'number');
    assert.strictEqual(classifyValue(true), 'other');
    assert.strictEqual(classifyValue(null), 'other');
    assert.strictEqual(classifyValue(['a']), 'other');
    assert.strictEqual(classifyValue({ a: 1 }), 'other');
    assert.strictEqual(classifyValue(''), 'other');
  });

  it('classifies only a bounded prefix of long values', () => {
    assert.strictEqual(classifyString(`https://x.example/a?b=${'c'.repeat(10_000)}`), 'urlQuery');
    assert.strictEqual(classifyString(`${'word '.repeat(10_000)}`), 'freeText');
    assert.strictEqual(classifyString('f'.repeat(10_000) + '1'), 'other');
  });

  it('checks ip ports and path segments strictly', () => {
    assert.strictEqual(isIpAddress('10.0.0.5:65535'), true);
    assert.strictEqual(isIpAddress('10.0.0.5:123456'), false);
    assert.strictEqual(isIpAddress('10.0.0.5:'), false);
    assert.strictEqual(isIpAddress('[::1]'), true);
    assert.strictEqual(isIpAddress('[10.0.0.1]:80'), false);
    assert.strictEqual(isIdSegment('42'), true);
    assert.strictEqual(isIdSegment('orders'), false);
    assert.strictEqual(isIdSegment('{id}'), false);
  });

  // S2: inputs shaped to make backtracking regexes explode.
  it('stays fast on adversarial 100 KB inputs', () => {
    const inputs = [
      'a'.repeat(100_000) + '!',
      '1'.repeat(100_000) + 'x',
      '2026-10-30T12:34:56' + '9'.repeat(100_000),
      'https://' + 'a.'.repeat(50_000) + '?',
      '/' + '1/'.repeat(50_000),
      'x@' + 'a.'.repeat(50_000),
      '@'.repeat(100_000),
      ':'.repeat(100_000),
      '[' + ':'.repeat(100_000),
      '-'.repeat(100_000),
    ];
    for (const s of inputs) {
      const t = process.hrtime.bigint();
      classifyString(s);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(ms < 5, `${s.slice(0, 12)}...: ${ms.toFixed(2)} ms`);
    }
  });

  describe('ClassTally', () => {
    it('reports a dominant class at 80% share and none below', () => {
      const t = new ClassTally();
      for (let i = 0; i < 8; i++) t.add('uuid');
      t.add('other');
      t.add('number');
      assert.strictEqual(t.dominant(), 'uuid');
      t.add('other');
      assert.strictEqual(t.dominant(), undefined);
      assert.deepStrictEqual(t.entries(), [
        ['uuid', 8],
        ['other', 2],
        ['number', 1],
      ]);
    });

    it('stops counting at the sample limit', () => {
      const t = new ClassTally();
      for (let i = 0; i < CLASSIFY_SAMPLE_LIMIT + 10; i++) t.add('hexId');
      assert.strictEqual(t.total, CLASSIFY_SAMPLE_LIMIT);
      assert.strictEqual(t.full, true);
      assert.strictEqual(t.dominant(), 'hexId');
    });

    it('has no dominant class when empty', () => {
      assert.strictEqual(new ClassTally().dominant(), undefined);
      assert.strictEqual(new ClassTally().entries().length, 0);
    });
  });
});

describe('cardinality key hints', () => {
  it('suggests route templates for url keys and query summaries for SQL', () => {
    assert.deepStrictEqual(keyHint('url.full')?.prefer, ['http.route', 'url.template']);
    assert.deepStrictEqual(keyHint('http.target')?.prefer, ['http.route', 'url.template']);
    assert.ok(keyHint('db.query.text')?.prefer.includes('db.query.summary'));
    assert.ok(keyHint('user.id')?.hint.includes('metric labels'));
    assert.ok(keyHint('client.port')?.hint.includes('ephemeral'));
  });

  it('matches exact keys only, including prototype names', () => {
    assert.strictEqual(keyHint('URL.FULL'), undefined);
    assert.strictEqual(keyHint('url.full.extra'), undefined);
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.strictEqual(keyHint(k), undefined);
  });

  it('has a hint for every id class and free text, none for neutral classes', () => {
    for (const cls of VALUE_CLASSES) {
      const expected = ID_CLASSES.has(cls) || cls === 'freeText';
      assert.strictEqual(classHint(cls) !== undefined, expected, cls);
    }
  });
});
