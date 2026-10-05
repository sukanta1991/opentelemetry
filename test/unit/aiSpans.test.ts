// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { selfTimes } from '../../src/ai/analysis/common';
import { findSpans } from '../../src/ai/analysis/spans';
import { MAX_SCAN_TRACES } from '../../src/ai/limits';
import { REDACTED, createRedactor } from '../../src/ai/redact';
import { parseFindSpansInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import { buildWaterfall } from '../../src/views/waterfall';
import {
  DB_SPAN,
  DIST_TRACE,
  FAIL_CHILD,
  ODD_TRACE,
  SECRET_BEARER,
  T0,
  addBaselineTraces,
  addDistributedTrace,
  addFailingTrace,
  addOrphanAndSkewTrace,
  addSpans,
  span,
} from './aiFixtures';

const ctx = { now: T0 + 90_000, redactor: createRedactor(), maxItems: 50 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseFindSpansInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return findSpans(store, input.value, ctx);
}

describe('ai findSpans', () => {
  describe('self-time', () => {
    it('merges overlapping children and never goes negative with skewed children', () => {
      const T = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      const rows = buildWaterfall(
        [
          span({ traceId: T, spanId: 'e000000000000001', startMs: T0, durationMs: 100 }),
          span({ traceId: T, spanId: 'e000000000000002', parentSpanId: 'e000000000000001', startMs: T0 + 10, durationMs: 50 }),
          span({ traceId: T, spanId: 'e000000000000003', parentSpanId: 'e000000000000001', startMs: T0 + 40, durationMs: 50 }),
          span({ traceId: T, spanId: 'e000000000000004', startMs: T0, durationMs: 100 }),
          span({ traceId: T, spanId: 'e000000000000005', parentSpanId: 'e000000000000004', startMs: T0 - 20, durationMs: 150 }),
        ].map((s) => ({ span: s, serviceName: 'svc' }))
      );
      const self = selfTimes(rows);
      assert.strictEqual(self.get('e000000000000001'), 20, '10–90 covered by the merged children');
      assert.strictEqual(self.get('e000000000000004'), 0, 'skewed child is clipped to the parent');
      assert.strictEqual(self.get('e000000000000005'), 150);
      for (const v of self.values()) assert.ok(v >= 0);
    });

    it('reports self-time per span and sorts by it', () => {
      const store = new TelemetryStore();
      addOrphanAndSkewTrace(store);
      const { result } = run(store, { service: 'worker', sort: 'selfTime' });
      assert.deepStrictEqual(
        result.spans.map((s: any) => [s.name, s.selfMs]),
        [
          ['skewed', 150],
          ['lost', 30],
          ['job', 0],
        ]
      );
      assert.strictEqual(result.spans[0].traceId, ODD_TRACE);
    });
  });

  describe('filters and rows', () => {
    const store = new TelemetryStore();
    addDistributedTrace(store);
    addFailingTrace(store);
    addBaselineTraces(store);

    it('applies span-level query, service, status and duration filters', () => {
      assert.deepStrictEqual(
        run(store, { minDurationMs: 800 }).result.spans.map((s: any) => s.durationMs),
        [1000, 950, 930, 800]
      );
      assert.deepStrictEqual(
        run(store, { query: 'db.system=postgresql', minDurationMs: 500 }).result.spans.map((s: any) => s.spanId),
        [DB_SPAN]
      );
      assert.strictEqual(run(store, { status: 'error' }).result.matchedSpans, 2);
      assert.strictEqual(run(store, { service: 'frontend' }).result.matchedSpans, 62);
      assert.strictEqual(run(store, { sinceMinutes: 1, query: 'name="SELECT orders"' }).result.matchedSpans, 30);
    });

    it('notes that trace-level predicates and words are ignored', () => {
      const { result } = run(store, { query: 'dur>1s checkout' });
      assert.match(result.notes[0], /ignored/);
      assert.strictEqual(result.matchedSpans, 31 * 4 + 2);
    });

    it('returns the useful attributes, redacted, without GenAI content', () => {
      const [row] = run(store, { query: 'error.type=CardError' }).result.spans;
      assert.strictEqual(row.spanId, FAIL_CHILD);
      assert.deepStrictEqual(row.attrs, {
        'error.type': 'CardError',
        'http.request.header.authorization': REDACTED,
        'server.address': 'api.payments.local',
      });
      assert.ok(!JSON.stringify(row).includes(SECRET_BEARER));
      assert.deepStrictEqual(row.code, { filepath: '/srv/checkout/pay.py', line: 42, column: 5, function: 'charge' });
    });

    it('emits span refs and source refs for spans with code locations', () => {
      const { refs } = run(store, { query: 'db.system=postgresql', minDurationMs: 500 });
      assert.deepStrictEqual(refs, [
        { kind: 'span', traceId: DIST_TRACE, spanId: DB_SPAN, instanceId: 'checkout::i1', label: 'SELECT orders' },
        {
          kind: 'source',
          traceId: DIST_TRACE,
          spanId: DB_SPAN,
          code: { filepath: '/srv/checkout/orders.py', line: 17, column: undefined, function: 'load_orders' },
          label: 'SELECT orders',
        },
      ]);
    });
  });

  describe('grouping', () => {
    const store = new TelemetryStore();
    addDistributedTrace(store);
    addBaselineTraces(store);

    it('groups by service and name with self-time totals and shares', () => {
      const { result, refs } = run(store, { groupBy: 'serviceAndName', sort: 'selfTime' });
      assert.deepStrictEqual(
        result.groups.map((g: any) => [g.service, g.name, g.count, g.totalSelfMs, g.shareOfSelfTime]),
        [
          ['checkout', 'POST /pay', 31, 4030, 0.468],
          ['checkout', 'SELECT orders', 31, 2420, 0.281],
          ['frontend', 'GET /checkout', 31, 1550, 0.18],
          ['frontend', 'POST checkout', 31, 620, 0.072],
        ]
      );
      const db = result.groups[1];
      assert.strictEqual(db.exampleTraceId, DIST_TRACE);
      assert.strictEqual(db.exampleSpanId, DB_SPAN);
      assert.strictEqual(db.p50Ms, 54);
      assert.strictEqual(refs.length, 4);
      assert.ok(refs.every((r: any) => r.kind === 'span' && r.traceId === DIST_TRACE));
    });

    it('groups by service', () => {
      const { result } = run(store, { groupBy: 'service', sort: 'selfTime' });
      assert.deepStrictEqual(
        result.groups.map((g: any) => [g.service, g.name, g.count, g.totalSelfMs]),
        [
          ['checkout', undefined, 62, 6450],
          ['frontend', undefined, 62, 2170],
        ]
      );
    });
  });

  it('scans only the newest MAX_SCAN_TRACES traces and says so', () => {
    const store = new TelemetryStore(5000, 5000);
    const total = MAX_SCAN_TRACES + 5;
    const spans = Array.from({ length: total }, (_, i) =>
      span({ traceId: `cafe${i.toString(16).padStart(28, '0')}`, spanId: 'c000000000000001', startMs: T0 + i })
    );
    addSpans(store, 'svc', spans);
    const { result } = run(store, {});
    assert.strictEqual(result.scannedTraces, MAX_SCAN_TRACES);
    assert.strictEqual(result.totalTraces, total);
    assert.strictEqual(result.matchedSpans, MAX_SCAN_TRACES);
    assert.ok(result.notes.some((n: string) => n.includes(`newest ${MAX_SCAN_TRACES} of ${total}`)));
  });
});
