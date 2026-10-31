// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  DEFAULT_PRICING,
  DailyUsage,
  MAX_PRICE,
  Pricing,
  effectivePricing,
  estimateCost,
  hasPrices,
  sanitizeOverrides,
  sanitizePricing,
} from '../../src/views/cardinalityCost';

const USAGE: DailyUsage = {
  bytes: { protobuf: 2e9, json: 5e9 },
  spans: 1e6,
  logs: 4e6,
  activeSeries: 1500,
  windowMinutes: 15,
};

const priced = (p: Partial<Pricing>): Pricing => ({ ...DEFAULT_PRICING, ...p });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

describe('cardinality cost', () => {
  describe('sanitizePricing', () => {
    it('defaults to no prices', () => {
      assert.deepStrictEqual(sanitizePricing(undefined), DEFAULT_PRICING);
      assert.strictEqual(hasPrices(DEFAULT_PRICING), false);
      assert.strictEqual(estimateCost(USAGE, DEFAULT_PRICING), undefined);
    });

    it('accepts valid values and drops invalid ones field by field', () => {
      const p = sanitizePricing({
        currency: 'EUR',
        perGbIngested: 0.5,
        perMillionSpans: -1,
        perMillionLogs: MAX_PRICE + 1,
        perSeriesMonth: '0.1',
        perGbMonthRetained: Infinity,
        retentionDays: 7.5,
        sizeModel: 'xml',
        trafficMultiplier: 0,
      });
      assert.deepStrictEqual(p, { ...DEFAULT_PRICING, currency: 'EUR', perGbIngested: 0.5 });
      assert.strictEqual(sanitizePricing({ currency: 'eur' }).currency, 'USD');
      assert.strictEqual(sanitizePricing({ currency: 'EURO' }).currency, 'USD');
      assert.strictEqual(sanitizePricing({ retentionDays: 30, trafficMultiplier: 250, sizeModel: 'json' }).trafficMultiplier, 250);
      assert.strictEqual(sanitizePricing({ perGbIngested: 0 }).perGbIngested, 0, 'a free tier is a price');
    });

    it('ignores prototype keys', () => {
      const p = sanitizePricing(JSON.parse('{"__proto__": {"perGbIngested": 5}, "constructor": 1}'));
      assert.deepStrictEqual(p, DEFAULT_PRICING);
      assert.strictEqual(({} as Record<string, unknown>).perGbIngested, undefined);
    });
  });

  describe('overrides', () => {
    it('keeps only valid fields; null clears a price', () => {
      assert.deepStrictEqual(sanitizeOverrides({ perGbIngested: null, perMillionSpans: 2, bogus: 1, trafficMultiplier: -3 }), {
        perGbIngested: null,
        perMillionSpans: 2,
      });
      assert.deepStrictEqual(sanitizeOverrides([1, 2]), {});
      assert.deepStrictEqual(sanitizeOverrides('x'), {});
    });

    it('applies on top of settings and reports the source', () => {
      const settings = priced({ perGbIngested: 1, perMillionSpans: 3 });
      assert.deepStrictEqual(effectivePricing(settings, undefined), { pricing: settings, source: 'settings' });
      assert.deepStrictEqual(effectivePricing(settings, { bogus: 1 }), { pricing: settings, source: 'settings' });
      const { pricing, source } = effectivePricing(settings, { perGbIngested: null, perMillionLogs: 0.25 });
      assert.strictEqual(source, 'workspace');
      assert.deepStrictEqual([pricing.perGbIngested, pricing.perMillionSpans, pricing.perMillionLogs], [null, 3, 0.25]);
    });
  });

  describe('estimateCost', () => {
    it('prices each set item per 30-day month', () => {
      const c = estimateCost(USAGE, priced({ perGbIngested: 0.5, perMillionSpans: 2, perMillionLogs: 0.1, perSeriesMonth: 0.05 }))!;
      const by = Object.fromEntries(c.lines.map((l) => [l.item, l]));
      close(by.ingest.quantity, 60);
      close(by.ingest.monthly, 30);
      close(by.spans.quantity, 30);
      close(by.spans.monthly, 60);
      close(by.logs.quantity, 120);
      close(by.logs.monthly, 12);
      close(by.series.quantity, 1500);
      close(by.series.monthly, 75);
      close(c.monthlyTotal, 177);
      assert.deepStrictEqual(c.lines.map((l) => l.item), ['ingest', 'spans', 'logs', 'series']);
      assert.strictEqual(c.currency, 'USD');
    });

    it('prices only what is set', () => {
      const c = estimateCost(USAGE, priced({ perMillionSpans: 2 }))!;
      assert.deepStrictEqual(c.lines.map((l) => l.item), ['spans']);
    });

    it('uses the chosen size model and multiplier (not for series)', () => {
      const c = estimateCost(USAGE, priced({ perGbIngested: 1, perSeriesMonth: 1, sizeModel: 'json', trafficMultiplier: 10 }))!;
      close(c.lines[0].quantity, 5 * 10 * 30);
      close(c.lines[1].quantity, 1500);
      assert.ok(c.assumptions.some((a) => a.includes('×10')));
      assert.ok(c.assumptions.some((a) => a.includes('JSON')));
    });

    it('prices retention as GB per day times retention days, and explains a missing day count', () => {
      const c = estimateCost(USAGE, priced({ perGbMonthRetained: 0.03, retentionDays: 15 }))!;
      close(c.lines[0].quantity, 30);
      close(c.lines[0].monthly, 0.9);
      const missing = estimateCost(USAGE, priced({ perGbMonthRetained: 0.03 }))!;
      assert.strictEqual(missing.lines.length, 0);
      assert.ok(missing.assumptions.some((a) => a.includes('retention days')));
    });

    it('stays finite at the extremes and states its window', () => {
      const huge: DailyUsage = { bytes: { protobuf: 1e15, json: 1e15 }, spans: 1e12, logs: 1e12, activeSeries: 1e7, windowMinutes: 0.2 };
      const all = priced({ perGbIngested: MAX_PRICE, perMillionSpans: MAX_PRICE, perMillionLogs: MAX_PRICE, perSeriesMonth: MAX_PRICE, perGbMonthRetained: MAX_PRICE, retentionDays: 3650, trafficMultiplier: 1e6 });
      const c = estimateCost(huge, all)!;
      assert.ok(Number.isFinite(c.monthlyTotal) && c.lines.every((l) => Number.isFinite(l.monthly)));
      assert.ok(c.assumptions[0].includes('1 minute'));
      assert.ok(estimateCost({ ...USAGE, windowMinutes: 180 }, all)!.assumptions[0].includes('3 hours'));
      const zero = estimateCost({ bytes: { protobuf: 0, json: 0 }, spans: 0, logs: 0, activeSeries: 0, windowMinutes: 0 }, all)!;
      assert.strictEqual(zero.monthlyTotal, 0);
    });
  });

  it('package.json defaults, ranges and scopes match', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    for (const k of Object.keys(DEFAULT_PRICING) as (keyof Pricing)[]) {
      const p = props[`otel.cost.${k}`];
      assert.ok(p, k);
      assert.deepStrictEqual(p.default, DEFAULT_PRICING[k], k);
      assert.strictEqual(p.scope, 'resource', k);
      if (typeof p.maximum === 'number') assert.strictEqual(sanitizePricing({ [k]: p.maximum + 1 })[k], DEFAULT_PRICING[k], `${k} above maximum`);
    }
    assert.deepStrictEqual(props['otel.cost.sizeModel'].enum, ['protobuf', 'json']);
  });
});
