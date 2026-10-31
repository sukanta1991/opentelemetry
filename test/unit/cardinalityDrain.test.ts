// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { createRedactor } from '../../src/ai/redact';
import { Budget } from '../../src/store/cardinality/budget';
import { DrainTemplater, maskToken, shapeOf, tokenize } from '../../src/store/cardinality/drain';
import { LogRecord } from '../../src/store/model';
import { buildLogBatches } from './ingestFixtures';

function templatesOf(bodies: string[], opts = {}): Map<string, number> {
  const d = new DrainTemplater(opts);
  for (const b of bodies) d.add(b, 0, b.length);
  return new Map(d.templates().map((t) => [t.text, t.count]));
}

describe('Drain log templates', () => {
  describe('maskToken', () => {
    const cases: [string, string][] = [
      ['123', '<NUM>'],
      ['45ms', '<NUM>ms'],
      ['12.5%', '<NUM>%'],
      ['-3', '<NUM>'],
      ['4)', '<NUM>)'],
      ['(attempt', '(attempt'],
      ['product:4999', 'product:<NUM>'],
      ['id=42,', 'id=<NUM>,'],
      ['10.0.0.5', '<IP>'],
      ['10.0.0.5:8080', '<IP>'],
      ['/10.250.19.102:54106', '/<IP>'],
      ['/users/42', '/users/<ID>'],
      ['/search?q=1', '/search?<QUERY>'],
      ['https://x.example/a/1', '<URL>'],
      ['3f2b8c1e-9a4d-4c7e-b1f2-0a9e8d7c6b5a', '<UUID>'],
      ['alice@example.com', '<EMAIL>'],
      ['4bf92f3577b34da6', '<HEX>'],
      ['2026-10-30T12:00:00Z', '<TS>'],
      ['sk_live_51HxQ2bKz9vXy7Lm3Np4Qr', '<TOKEN>'],
      ['v2', 'v2'],
      ['exhausted:', 'exhausted:'],
      ['word', 'word'],
      ['GET', 'GET'],
    ];
    for (const [input, expected] of cases) {
      it(`${input} -> ${expected}`, () => assert.strictEqual(maskToken(input), expected));
    }
  });

  it('tokenizes on whitespace, masks quoted text and caps tokens and length', () => {
    assert.deepStrictEqual(tokenize('User "bob smith" logged\tin  \n'), ['User', '<STR>', 'logged', 'in']);
    assert.strictEqual(tokenize(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')).length, 64);
    assert.strictEqual(tokenize(`${'a'.repeat(5000)} tail`).join(' '), 'a'.repeat(2048));
  });

  it('describes non-text bodies by shape', () => {
    assert.strictEqual(shapeOf({ b: 1, a: { c: 2 } }), '{a,b}');
    assert.strictEqual(shapeOf([1, 2]), '[array]');
    assert.strictEqual(shapeOf(5), '<NUM>');
    assert.strictEqual(shapeOf(false), '<BOOL>');
    assert.strictEqual(shapeOf(null), '<empty>');
    assert.strictEqual(shapeOf('   '), '<empty>');
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i++) wide[`k${String(i).padStart(2, '0')}`] = i;
    assert.ok(shapeOf(wide).endsWith(',k31,…}'));
  });

  it('reproduces the Drain3 README example', () => {
    const t = templatesOf([
      'connected to 10.0.0.1',
      'connected to 192.168.0.1',
      'Hex number 0xDEADBEAF',
      'user davidoh logged in',
      'user eranr logged in',
    ]);
    assert.deepStrictEqual(
      [...t.entries()],
      [
        ['connected to <IP>', 2],
        ['user <*> logged in', 2],
        ['Hex number 0xDEADBEAF', 1],
      ]
    );
  });

  describe('on the ingest fixture (50k logs)', () => {
    let logs: LogRecord[];
    before(() => {
      logs = buildLogBatches().flatMap((b) => b.logs);
    });

    const EXPECTED = [
      'User <NUM> logged in from <IP>',
      'Order <UUID> processed in <NUM> ms',
      'Cache miss for key product:<NUM>',
      'GET /users/<ID> returned <NUM> in <NUM> ms',
      // A few random 16-hex ids are all digits (<NUM>), so Drain generalizes that position.
      'Retrying request <*> (attempt <NUM>)',
      'Payment declined for card ending <NUM>',
      'Connection pool exhausted: <NUM> waiting, max <NUM>',
      'Scheduled job reindex finished',
      '{amount,event,items,orderId}',
    ];

    it('finds exactly the generated patterns and accounts for every log', () => {
      const d = new DrainTemplater();
      for (const l of logs) d.add(l.body, l.timeMs, 100);
      const ts = d.templates();
      assert.deepStrictEqual(ts.map((t) => t.text).sort(), [...EXPECTED].sort());
      assert.strictEqual(ts.reduce((n, t) => n + t.count, 0), logs.length);
      assert.strictEqual(ts.reduce((n, t) => n + t.bytes, 0), logs.length * 100);
      assert.strictEqual(d.other.count, 0);
      for (const t of ts) assert.ok(t.firstSeen <= t.lastSeen);
    });

    it('gives the same templates regardless of input order', () => {
      const forward = templatesOf(logs.map((l) => String(l.body)));
      const reversed = templatesOf(logs.map((l) => String(l.body)).reverse());
      assert.deepStrictEqual([...reversed.entries()].sort(), [...forward.entries()].sort());
    });
  });

  it('routes extra first tokens to a wildcard child beyond maxChildren', () => {
    const t = templatesOf(['a x', 'b x', 'c x', 'd x'], { maxChildren: 3 });
    assert.deepStrictEqual([...t.entries()].sort(), [
      ['<*> x', 2],
      ['a x', 1],
      ['b x', 1],
    ]);
  });

  it('evicts the oldest single-use template at the cap, then counts new patterns as other', () => {
    const d = new DrainTemplater({ maxTemplates: 3 });
    d.add('alpha one', 0, 1);
    d.add('beta two words', 0, 1);
    d.add('beta two words', 0, 1);
    d.add('gamma three more words', 0, 1);
    d.add('delta four five six seven', 0, 1);
    assert.deepStrictEqual(
      d.templates().map((t) => t.text),
      ['beta two words', 'gamma three more words', 'delta four five six seven']
    );
    assert.deepStrictEqual(d.other, { count: 1, bytes: 1 });
    d.add('gamma three more words', 0, 1);
    d.add('delta four five six seven', 0, 1);
    d.add('epsilon', 0, 1);
    assert.strictEqual(d.size, 3);
    assert.deepStrictEqual(d.other, { count: 2, bytes: 2 });
    // The evicted pattern starts over as a new template once there is room.
    const again = new DrainTemplater({ maxTemplates: 1 });
    const first = again.add('alpha one', 0, 1);
    again.add('beta two words', 0, 1);
    assert.notStrictEqual(again.add('alpha one', 0, 1), first);
  });

  it('shares a store-wide budget and releases it on dispose', () => {
    const budget = new Budget(3);
    const a = new DrainTemplater({}, budget);
    const b = new DrainTemplater({}, budget);
    a.add('one', 0, 1);
    a.add('two words', 0, 1);
    b.add('three more words', 0, 1);
    assert.strictEqual(budget.used, 3);
    // Out of budget: b replaces its own single-use template instead of growing.
    b.add('four words here now', 0, 1);
    assert.strictEqual(budget.used, 3);
    assert.strictEqual(b.size, 1);
    a.dispose();
    assert.strictEqual(budget.used, 1);
    b.dispose();
    assert.strictEqual(budget.used, 0);
  });

  it('groups structured bodies by key set', () => {
    const d = new DrainTemplater();
    d.add({ b: 1, a: 2 }, 0, 1);
    d.add({ a: 3, b: 4 }, 0, 1);
    d.add([1], 0, 1);
    d.add('', 0, 1);
    d.add(null, 0, 1);
    assert.deepStrictEqual(
      d.templates().map((t) => [t.text, t.count]),
      [
        ['{a,b}', 2],
        ['<empty>', 2],
        ['[array]', 1],
      ]
    );
    assert.strictEqual(d.templates()[0].sample, '{"b":1,"a":2}');
  });

  it('redacts and truncates samples', () => {
    const redact = createRedactor().text;
    const d = new DrainTemplater({ sampleChars: 40 }, undefined, redact);
    d.add(`login ok token=abcdef1234567890 for user 7 ${'x'.repeat(100)}`, 0, 1);
    const sample = d.templates()[0].sample;
    assert.ok(!sample.includes('abcdef1234567890'), sample);
    assert.ok(sample.includes('[REDACTED]'), sample);
    assert.strictEqual(sample.length, 41);
    assert.ok(sample.endsWith('…'));
  });

  it('rejects invalid options', () => {
    for (const bad of [{ depth: 2 }, { similarity: 1.5 }, { maxChildren: 1 }, { maxTemplates: 0 }, { maxTokens: 0 }]) {
      assert.throws(() => new DrainTemplater(bad), RangeError, JSON.stringify(bad));
    }
  });

  // S2: bounded work on hostile bodies.
  it('stays fast on huge, token-heavy and quote-heavy bodies', () => {
    const bodies = [
      'x'.repeat(1_000_000),
      'a '.repeat(500_000),
      '"'.repeat(100_000),
      '" '.repeat(50_000),
      '1/'.repeat(50_000),
      '='.repeat(100_000),
      `/${'1:'.repeat(50_000)}`,
    ];
    const d = new DrainTemplater();
    for (const b of bodies) {
      const t = process.hrtime.bigint();
      d.add(b, 0, b.length);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(ms < 5, `${JSON.stringify(b.slice(0, 6))}...: ${ms.toFixed(2)} ms`);
    }
  });

  it('keeps unique-per-log floods within the cap', () => {
    const d = new DrainTemplater({ maxTemplates: 100 });
    const t = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i++) d.add(`event${String.fromCharCode(97 + (i % 26))}${i.toString(36).replace(/\d/g, 'q')} done`, 0, 1);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(d.size <= 100);
    assert.strictEqual(d.templates().reduce((n, x) => n + x.count, 0) + d.other.count, 20_000);
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  });
});
