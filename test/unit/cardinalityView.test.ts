// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { DEFAULT_PRICING, Pricing } from '../../src/views/cardinalityCost';
import {
  HostContext,
  findingSubject,
  formatBytes,
  formatCompact,
  formatCount,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatSignedPercent,
  loadViewState,
  overridesFrom,
  parseCardinalityMessage,
  parseNumberInput,
  projections,
  sparklinePath,
  truncate,
} from '../../src/views/webview/cardinalityView';

const ctx: HostContext = {
  seq: 4,
  scope: { realm: 'live', service: 'api' },
  options: {
    realms: [
      { id: 'live', label: 'Live' },
      { id: 's1', label: 'old.json' },
    ],
    services: ['api', 'worker', '__proto__'],
    instances: [{ id: 'api::i1', label: 'i1' }],
  },
  tables: { keys: 3 },
};
const parse = (m: unknown) => parseCardinalityMessage(m, ctx);

describe('cardinality view: messages', () => {
  it('accepts ready, tabs, reset and settings messages', () => {
    assert.deepStrictEqual(parse({ type: 'ready', tab: 'metrics' }), { type: 'ready', tab: 'metrics' });
    assert.deepStrictEqual(parse({ type: 'ready', tab: 'nope' }), { type: 'ready', tab: 'overview' });
    assert.deepStrictEqual(parse({ type: 'setTab', tab: 'pricing' }), { type: 'setTab', tab: 'pricing' });
    assert.strictEqual(parse({ type: 'setTab', tab: 'toString' }), undefined);
    assert.deepStrictEqual(parse({ type: 'resetPricing' }), { type: 'resetPricing' });
    assert.deepStrictEqual(parse({ type: 'openSettings', section: 'cost' }), { type: 'openSettings', section: 'cost' });
    assert.strictEqual(parse({ type: 'openSettings', section: 'otel.ai' }), undefined);
    for (const bad of [null, undefined, 'ready', 42, [], { type: 'nope' }, { type: '__proto__' }]) assert.strictEqual(parse(bad), undefined, String(bad));
  });

  it('validates scope against the offered realms, services and instances', () => {
    const scope = (s: unknown) => (parse({ type: 'setScope', scope: s }) as any)?.scope;
    assert.deepStrictEqual(scope({ realm: 's1' }), { realm: 's1' });
    assert.deepStrictEqual(scope({ realm: 'live', service: 'worker' }), { realm: 'live', service: 'worker' });
    assert.deepStrictEqual(scope({ realm: 'live', service: '__proto__' }), { realm: 'live', service: '__proto__' });
    assert.deepStrictEqual(scope({ realm: 'live', service: 'api', instanceId: 'api::i1' }), { realm: 'live', service: 'api', instanceId: 'api::i1' });
    for (const bad of [
      { realm: 'ghost' },
      { realm: 'live', service: 'ghost' },
      { realm: 's1', service: 'api' },
      { realm: 'live', service: 'worker', instanceId: 'api::i1' },
      { realm: 'live', service: 'api', instanceId: 'api::i9' },
      { realm: 'live', instanceId: 'api::i1' },
      { realm: 'live', service: 5 },
      { realm: ['live'] },
      [],
      'live',
    ]) {
      assert.strictEqual(scope(bad), undefined, JSON.stringify(bad));
    }
  });

  it('accepts only current, in-range detail selections', () => {
    assert.deepStrictEqual(parse({ type: 'select', seq: 4, table: 'keys', index: 2 }), { type: 'select', seq: 4, table: 'keys', index: 2 });
    for (const bad of [
      { seq: 3, table: 'keys', index: 0 },
      { seq: 4, table: 'keys', index: 3 },
      { seq: 4, table: 'keys', index: -1 },
      { seq: 4, table: 'keys', index: 1.5 },
      { seq: 4, table: 'keys', index: '1' },
      { seq: 4, table: 'metrics', index: 0 },
      { seq: 4, table: 'constructor', index: 0 },
    ]) {
      assert.strictEqual(parse({ type: 'select', ...bad }), undefined, JSON.stringify(bad));
    }
  });

  it('accepts pricing overrides only when every field is known and valid', () => {
    const ok = (o: unknown) => (parse({ type: 'setPricing', overrides: o }) as any)?.overrides;
    assert.deepStrictEqual(ok({}), {});
    assert.deepStrictEqual(ok({ perGbIngested: 0.5, perMillionSpans: null, currency: 'EUR', sizeModel: 'json', retentionDays: 30, trafficMultiplier: 10 }), {
      perGbIngested: 0.5,
      perMillionSpans: null,
      currency: 'EUR',
      sizeModel: 'json',
      retentionDays: 30,
      trafficMultiplier: 10,
    });
    for (const bad of [
      { perGbIngested: -1 },
      { perGbIngested: 1_000_001 },
      { perGbIngested: '1' },
      { currency: 'eur' },
      { currency: 'EURO' },
      { sizeModel: 'xml' },
      { retentionDays: 1.5 },
      { retentionDays: 0 },
      { trafficMultiplier: 0 },
      { trafficMultiplier: null },
      { extra: 1 },
      [],
      null,
      'x',
    ]) {
      assert.strictEqual(ok(bad), undefined, JSON.stringify(bad));
    }
    assert.strictEqual(ok(JSON.parse('{"__proto__":{"perGbIngested":1}}')), undefined);
    assert.strictEqual(ok(JSON.parse('{"perGbIngested":1e999}')), undefined);
  });

  it('restores the persisted tab or falls back to the overview', () => {
    assert.deepStrictEqual(loadViewState({ tab: 'logs' }), { tab: 'logs' });
    assert.deepStrictEqual(loadViewState({ tab: 'hasOwnProperty' }), { tab: 'overview' });
    assert.deepStrictEqual(loadViewState(undefined), { tab: 'overview' });
  });
});

describe('cardinality view: pricing form', () => {
  it('parses number inputs strictly', () => {
    const price = { min: 0, max: 1_000_000 };
    assert.strictEqual(parseNumberInput('', price), null);
    assert.strictEqual(parseNumberInput('  0.25 ', price), 0.25);
    assert.strictEqual(parseNumberInput('.5', price), 0.5);
    assert.strictEqual(parseNumberInput('1e3', price), 1000);
    for (const bad of ['-1', '1,000', '0x10', 'Infinity', 'NaN', '1e999', '2000000', '1.', '1 2', '+1']) {
      assert.strictEqual(parseNumberInput(bad, price), undefined, bad);
    }
    assert.strictEqual(parseNumberInput('30.5', { min: 1, max: 3650, integer: true }), undefined);
    assert.strictEqual(parseNumberInput('', { min: 1, max: 10, allowEmpty: false }), undefined);
  });

  it('keeps only the fields that differ from the settings', () => {
    const settings: Pricing = { ...DEFAULT_PRICING, perGbIngested: 0.1 };
    assert.deepStrictEqual(overridesFrom({ ...settings }, settings), {});
    assert.deepStrictEqual(overridesFrom({ ...settings, perGbIngested: null, currency: 'EUR', trafficMultiplier: 5 }, settings), {
      perGbIngested: null,
      currency: 'EUR',
      trafficMultiplier: 5,
    });
  });
});

describe('cardinality view: formatting', () => {
  it('formats counts, bytes, shares, durations and money', () => {
    assert.strictEqual(formatCount(1234.4), '1,234');
    assert.strictEqual(formatCount(1234, true), '≈1,234');
    assert.deepStrictEqual([0, 3.25, 950, 12_345, 4_100_000, 7e9].map(formatCompact), ['0', '3.3', '950', '12.3K', '4.1M', '7B']);
    assert.deepStrictEqual([0, 1023, 1024, 15_000, 3 * 1024 ** 3, NaN].map(formatBytes), ['0 B', '1023 B', '1 KB', '15 KB', '3 GB', '0 B']);
    assert.deepStrictEqual([0, 0.0004, 0.05, 0.5].map(formatPercent), ['0%', '<0.1%', '5%', '50%']);
    assert.deepStrictEqual([null, 0.5, -0.25].map(formatSignedPercent), ['new', '+50%', '−25%']);
    assert.deepStrictEqual([0, 0.5, 15, 180, 4320].map(formatMinutes), ['–', '30 s', '15 min', '3 h', '3 days']);
    assert.strictEqual(formatMoney(1234.5, 'USD'), '$1,234.50');
    assert.strictEqual(formatMoney(0.0123, 'EUR'), '€0.0123');
    assert.deepStrictEqual(projections(2), { day: 2880, month: 86_400 });
    assert.strictEqual(truncate('abcdef', 4), 'abc…');
    assert.strictEqual(truncate('abc', 4), 'abc');
  });

  it('names finding subjects by kind', () => {
    assert.strictEqual(findingSubject({ kind: 'attribute', key: 'user.id', scope: 'span.event' }), 'user.id (span event)');
    assert.strictEqual(findingSubject({ kind: 'metricLabel', key: 'user', metric: 'http.requests' }), 'http.requests by user');
    assert.strictEqual(findingSubject({ kind: 'spanNames', key: 'span names' }), 'span names');
  });
});

describe('cardinality view: sparkline', () => {
  it('scales to the maximum and breaks at gaps', () => {
    assert.strictEqual(sparklinePath([0, 5, 10], 100, 10), 'M0,10L50,5L100,0');
    assert.strictEqual(sparklinePath([1, null, 2, 4], 30, 10), 'M0,7.5L5,7.5M20,5L30,0');
    assert.strictEqual(sparklinePath([null, 3], 10, 10), 'M10,0L5,0', 'a lone last point draws backwards');
    assert.strictEqual(sparklinePath([null, null], 10, 10), '');
    assert.strictEqual(sparklinePath([], 10, 10), '');
    assert.strictEqual(sparklinePath([0, 0], 10, 10), 'M0,10L10,10');
  });
});
