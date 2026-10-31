// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { DrainTemplater } from '../../src/store/cardinality/drain';
import { Snapshot } from '../../src/views/baseline';
import { parseBaselineFile, serializeBaseline } from '../../src/views/baselineFile';
import { captureCardinality, compareCardinality } from '../../src/views/cardinalityBaseline';
import { evaluateOverview } from '../../src/views/cardinalityEvaluator';
import { SUMMARY_LIMITS } from '../../src/views/cardinalitySummary';
import { buildCardinalityModel, findingsFor, scopeInstances } from '../../src/views/cardinalityModel';
import { DEFAULT_PRICING } from '../../src/views/cardinalityCost';
import { baselineView, detailTables, detailsOf, pricingView, summaryOf, tabData } from '../../src/views/cardinalityPayload';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { TABS } from '../../src/views/webview/cardinalityView';
import { CAPS, SPAN_INSTANCES, fillToCaps } from './cardinalityFixtures';
import { buildLogBatches } from './ingestFixtures';
import { CI_FACTOR, assertBudget } from './perfFixtures';

// P8: 1.5 µs per log on the 50k-log fixture.
const DRAIN_BUDGET_MS = 75 * CI_FACTOR;
const FINDINGS_BUDGET_MS = 5 * CI_FACTOR;
// Services plus instances of multi-instance services; runs at most every 2 s.
const OVERVIEW_BUDGET_MS = 10 * CI_FACTOR;
const MODEL_BUDGET_MS = 50 * CI_FACTOR;
const CAPTURE_BUDGET_MS = 20 * CI_FACTOR;
const MAX_SUMMARY_BYTES = 200 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024;

describe('Drain performance', () => {
  it(`templates 50k logs: median under ${DRAIN_BUDGET_MS} ms (P8)`, function () {
    this.timeout(60_000);
    const logs = buildLogBatches().flatMap((b) => b.logs);
    assertBudget(() => {
      const d = new DrainTemplater();
      for (const l of logs) d.add(l.body, l.timeMs, 100);
    }, DRAIN_BUDGET_MS);
  });
});

describe('cardinality model performance (all caps)', function () {
  this.timeout(120_000);
  let store: TelemetryStore;

  before(() => {
    store = fillToCaps();
  });

  it('fills the caps it claims to', () => {
    const live = scopeInstances(store.getAllInstances(), { realm: LIVE_REALM });
    const sum = (f: (i: (typeof live)[number]) => number) => live.reduce((n, i) => n + f(i), 0);
    assert.strictEqual(sum((i) => i.usage!.spanKeys.size), SPAN_INSTANCES * CAPS.keysPerInstance);
    assert.ok(live.every((i) => [...i.usage!.spanKeys.values()].every((k) => k.distinct.approx)));
    assert.strictEqual(sum((i) => i.usage!.metrics.size), CAPS.metricsTotal);
    assert.strictEqual(sum((i) => i.usage!.templates.size), CAPS.templatesTotal);
  });

  it(`findingsFor at all caps: median under ${FINDINGS_BUDGET_MS} ms (P3)`, () => {
    const live = scopeInstances(store.getAllInstances(), { realm: LIVE_REALM });
    assert.ok(findingsFor(live, DEFAULT_CARDINALITY_SETTINGS).length >= SPAN_INSTANCES * CAPS.keysPerInstance);
    assertBudget(() => findingsFor(live, DEFAULT_CARDINALITY_SETTINGS), FINDINGS_BUDGET_MS);
  });

  it(`badge and status evaluation at all caps: median under ${OVERVIEW_BUDGET_MS} ms (P3, P7)`, () => {
    const all = store.getAllInstances();
    assert.ok(evaluateOverview(all, DEFAULT_CARDINALITY_SETTINGS).noisyServices >= SPAN_INSTANCES);
    assertBudget(() => evaluateOverview(all, DEFAULT_CARDINALITY_SETTINGS), OVERVIEW_BUDGET_MS);
  });

  it(`buildCardinalityModel at all caps: median under ${MODEL_BUDGET_MS} ms (P4)`, () => {
    const all = store.getAllInstances();
    const m = buildCardinalityModel(all, { realm: LIVE_REALM }, DEFAULT_CARDINALITY_SETTINGS);
    assert.strictEqual(m.rowsTruncated, true);
    assertBudget(() => buildCardinalityModel(all, { realm: LIVE_REALM }, DEFAULT_CARDINALITY_SETTINGS), MODEL_BUDGET_MS);
  });

  it(`captureCardinality at all caps: median under ${CAPTURE_BUDGET_MS} ms, within the summary caps (P9)`, () => {
    const all = store.getAllInstances();
    const sum = captureCardinality(all, { realm: LIVE_REALM })!;
    const keys = sum.services.reduce((n, s) => n + s.keys.length, 0);
    assert.strictEqual(keys, SUMMARY_LIMITS.keysTotal);
    assert.ok(sum.services.every((s) => s.keys.length <= SUMMARY_LIMITS.keysPerService && s.metrics.length <= SUMMARY_LIMITS.metricsPerService));
    assert.ok(sum.services.filter((s) => s.service.startsWith('spans')).every((s) => s.keysTruncated));
    assert.ok(sum.services.some((s) => s.metricsTruncated));
    assertBudget(() => captureCardinality(all, { realm: LIVE_REALM }), CAPTURE_BUDGET_MS);
  });

  it(`a summary at all caps adds under ${MAX_SUMMARY_BYTES / 1024} KB to a baseline file and round-trips (P9)`, () => {
    const cardinality = captureCardinality(store.getAllInstances(), { realm: LIVE_REALM })!;
    const bare: Snapshot = { source: { kind: 'mark', label: 'live', realm: LIVE_REALM, fromMs: 0, toMs: 1 }, nodes: [], entries: [], truncated: false };
    const without = serializeBaseline({ name: 'b', createdMs: 0, snapshot: bare });
    const withUsage = serializeBaseline({ name: 'b', createdMs: 0, snapshot: { ...bare, cardinality } });
    const added = Buffer.byteLength(withUsage) - Buffer.byteLength(without);
    assert.ok(added <= MAX_SUMMARY_BYTES, `${added} bytes`);
    assert.deepStrictEqual(parseBaselineFile(withUsage).snapshot.cardinality, cardinality);
    assert.strictEqual(compareCardinality(cardinality, cardinality, DEFAULT_CARDINALITY_SETTINGS).changes.length, 0);
  });

  it(`panel update messages at all caps stay under ${MAX_MESSAGE_BYTES / 1024} KB for every tab, details included (P4)`, () => {
    const all = store.getAllInstances();
    const scope = { realm: LIVE_REALM };
    const model = buildCardinalityModel(all, scope, DEFAULT_CARDINALITY_SETTINGS);
    const summary = captureCardinality(all, scope)!;
    const sources = {
      pricing: () => pricingView(model, { ...DEFAULT_PRICING, perGbIngested: 0.5 }, undefined),
      baseline: () => baselineView({ name: 'b', createdMs: 0, summary: { ...summary, services: [] } }, summary, scope, DEFAULT_CARDINALITY_SETTINGS),
    };
    const options = { realms: [{ id: LIVE_REALM, label: 'Live' }], services: model.services.map((s) => s.service), instances: [] };
    const sizes: Record<string, number> = {};
    for (const tab of TABS) {
      const data = tabData(tab, model, sources);
      const msg = { type: 'update', seq: 1, tab, scope, options, summary: summaryOf(model), data };
      sizes[tab] = Buffer.byteLength(JSON.stringify(msg));
      assert.ok(sizes[tab] <= MAX_MESSAGE_BYTES, `${tab}: ${sizes[tab]} bytes`);
      for (const [table, n] of Object.entries(detailTables(data))) {
        for (let i = 0; i < n!; i += 50) {
          const size = Buffer.byteLength(JSON.stringify(detailsOf(model, table as any, i)));
          assert.ok(size <= MAX_MESSAGE_BYTES, `${table}[${i}]: ${size} bytes`);
        }
      }
    }
    assert.ok(sizes.baseline > 1000, 'the baseline tab lists changes');
  });
});
