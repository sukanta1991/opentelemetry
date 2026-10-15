// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { TaggedSpan } from '../../src/store/store';
import { DEFAULT_SNAPSHOT_CAPS, Snapshot, SnapshotEntry, captureSnapshot } from '../../src/views/baseline';
import { DEFAULT_BASELINE_SETTINGS } from '../../src/views/baselineCompare';
import { MAX_BASELINE_FILE_BYTES, parseBaselineFile, serializeBaseline } from '../../src/views/baselineFile';
import { buildComparedMap, compareDetails } from '../../src/views/baselineMap';
import { bhAdjust, mannWhitney, proportionTest } from '../../src/views/baselineStats';
import { buildNodeDetails } from '../../src/views/serviceMapModel';
import { tid } from './baselineFixtures';
import { CI_FACTOR, assertBudget, fillServiceMapStore } from './perfFixtures';

const CAPTURE_BUDGET_MS = 400 * CI_FACTOR;
const COMPARE_BUDGET_MS = 30 * CI_FACTOR;
const REFRESH_BUDGET_MS = 400 * CI_FACTOR;
const DETAILS_BUDGET_MS = 150 * CI_FACTOR;
const SERIALIZE_BUDGET_MS = 100 * CI_FACTOR;
const PARSE_BUDGET_MS = 150 * CI_FACTOR;
const MAX_FILE_MB = 2.5;
const KEYS = 2000;
const SAMPLES = 1000;

const sortedSample = (k: number, shift: number) =>
  Float64Array.from({ length: SAMPLES }, (_, i) => ((i * 7919 + k * 31) % 1000) / 10 + shift).sort();

// Pure comparison work for the largest baseline: one latency and one error test per key, then BH over all.
function compareWorkload(pairs: [Float64Array, Float64Array][]): number[] {
  const p: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    p.push(mannWhitney(pairs[k][0], pairs[k][1]).p);
    p.push(proportionTest(k % 7, SAMPLES, (k * 3) % 11, SAMPLES).p);
  }
  return bhAdjust(p);
}

describe('baseline performance', function () {
  this.timeout(120_000);
  let tagged: TaggedSpan[];

  before(() => {
    tagged = fillServiceMapStore().getAllTaggedSpans();
  });

  it(`captureSnapshot (200k spans, all operations): median under ${CAPTURE_BUDGET_MS} ms`, () => {
    const snap = captureSnapshot(tagged, { kind: 'window', label: 'perf', realm: 'live' });
    assert.ok(snap.entries.length > 0);
    assertBudget(() => captureSnapshot(tagged, { kind: 'window', label: 'perf', realm: 'live' }), CAPTURE_BUDGET_MS);
  });

  it(`compare ${KEYS} keys x ${SAMPLES} vs ${SAMPLES} samples + BH: median under ${COMPARE_BUDGET_MS} ms`, () => {
    const pairs = Array.from({ length: KEYS }, (_, k): [Float64Array, Float64Array] => [sortedSample(k, 0), sortedSample(k, k % 3)]);
    assert.strictEqual(compareWorkload(pairs).length, KEYS * 2);
    assertBudget(() => compareWorkload(pairs), COMPARE_BUDGET_MS);
  });

  // 90 routes per service gives ~1800 keys with ~22 calls each, so most keys are tested, not "insufficient".
  describe('baseline-mode refresh (200k spans, ~1800 keys)', () => {
    let many: TaggedSpan[];
    let baseline: Snapshot;

    before(() => {
      many = fillServiceMapStore(90).getAllTaggedSpans();
      baseline = captureSnapshot(many, { kind: 'session', label: 'perf', realm: 'other' });
    });

    it(`buildComparedMap: median under ${REFRESH_BUDGET_MS} ms`, () => {
      const { comparison } = buildComparedMap(many, { range: 'all' }, baseline, DEFAULT_BASELINE_SETTINGS, 'live');
      assert.ok(comparison && comparison.keys.length > 1500, `${comparison?.keys.length} keys`);
      assert.ok(comparison.summary.unchanged > 1000, JSON.stringify(comparison.summary));
      assertBudget(() => buildComparedMap(many, { range: 'all' }, baseline, DEFAULT_BASELINE_SETTINGS, 'live'), REFRESH_BUDGET_MS);
    });

    it(`buildNodeDetails + compareDetails: median under ${DETAILS_BUDGET_MS} ms`, () => {
      const { model, comparison } = buildComparedMap(many, { range: 'all' }, baseline, DEFAULT_BASELINE_SETTINGS, 'live');
      const sel = { kind: 'node' as const, id: 'svc:svc5' };
      const details = () => compareDetails(buildNodeDetails(many, model, sel)!, comparison!, () => true);
      assert.strictEqual(details().operations.length, 10);
      assertBudget(details, DETAILS_BUDGET_MS);
    });
  });

  describe('baseline file at the caps', () => {
    const snapshot = maxSnapshot();
    const text = serializeBaseline({ name: 'max', createdMs: 0, snapshot });

    it(`stays under ${MAX_FILE_MB} MB`, () => {
      assert.ok(text.length < MAX_FILE_MB * 1024 * 1024, `${(text.length / 1024 / 1024).toFixed(2)} MB`);
    });

    it(`serializes in under ${SERIALIZE_BUDGET_MS} ms`, () => {
      assertBudget(() => serializeBaseline({ name: 'max', createdMs: 0, snapshot }), SERIALIZE_BUDGET_MS);
    });

    it(`parses and validates in under ${PARSE_BUDGET_MS} ms`, () => {
      assert.deepStrictEqual(parseBaselineFile(text).snapshot, snapshot);
      assertBudget(() => parseBaselineFile(text), PARSE_BUDGET_MS);
    });

    it(`rejects an 8 MB non-baseline file in under ${PARSE_BUDGET_MS} ms`, () => {
      const junk = `[${'1234567,'.repeat(Math.floor(MAX_BASELINE_FILE_BYTES / 8) - 1)}1]`;
      assert.throws(() => parseBaselineFile(junk), /must be an object/);
      assertBudget(() => assert.throws(() => parseBaselineFile(junk)), PARSE_BUDGET_MS);
    });
  });
});

// Largest valid snapshot: every key used, the total sample budget spent, two exemplars per key.
function maxSnapshot(): Snapshot {
  const { keys, totalSamples } = DEFAULT_SNAPSHOT_CAPS;
  const perKey = Math.floor(totalSamples / keys);
  const entries: SnapshotEntry[] = Array.from({ length: keys }, (_, k) => ({
    target: 'svc:checkout-service',
    ...(k ? { op: `GET /api/v1/orders/{orderId}/items/${k}` } : {}),
    count: 123_456,
    errors: 1234,
    p50: 123.45,
    p95: 987.65,
    samples: Array.from({ length: perKey }, (_, i) => Math.round((i * 10.07 + k / 100) * 100) / 100),
    exemplars: [tid(k), tid(k + keys)],
  }));
  return {
    source: { kind: 'window', label: 'Last 15 minutes', realm: 'live', fromMs: 1_760_000_000_000, toMs: 1_760_000_900_000 },
    nodes: [{ id: 'svc:checkout-service', label: 'checkout-service', type: 'service' }],
    entries,
    truncated: false,
  };
}
