// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { TelemetryStore } from '../../src/store/store';
import { CallStats, ModelNode, buildNodeDetails, buildServiceMap } from '../../src/views/serviceMapModel';
import { NodeBox } from '../../src/views/webview/serviceMapLayout';
import {
  HostContext,
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  edgeLabel,
  edgePath,
  edgeWidth,
  fitTransform,
  formatCalls,
  formatCount,
  formatMs,
  formatPercent,
  formatRate,
  loadMapState,
  nodeAriaLabel,
  nodeSubtitle,
  parseMapMessage,
  parseSelection,
  sameSelection,
  sparklinePath,
  truncateLabel,
  zoomAt,
} from '../../src/views/webview/serviceMapView';
import { addDistributedTrace } from './aiFixtures';

const stats = (p: Partial<CallStats>): CallStats => ({
  count: 10,
  errors: 0,
  errorRate: 0,
  p50: 5,
  p95: 20,
  ...p,
});

describe('serviceMapView', () => {
  describe('formatting', () => {
    it('formats counts, rates and calls', () => {
      assert.strictEqual(formatCount(1240), '1,240');
      assert.strictEqual(formatRate(1240.4), '1,240 req/min');
      assert.strictEqual(formatRate(12.6), '13 req/min');
      assert.strictEqual(formatRate(2.5), '2.5 req/min');
      assert.strictEqual(formatRate(3), '3 req/min');
      assert.strictEqual(formatRate(0.25), '0.25 req/min');
      assert.strictEqual(formatCalls(1), '1 call');
      assert.strictEqual(formatCalls(312), '312 calls');
    });

    it('formats durations', () => {
      assert.strictEqual(formatMs(null), '–');
      assert.strictEqual(formatMs(0.42), '0.4 ms');
      assert.strictEqual(formatMs(4), '4 ms');
      assert.strictEqual(formatMs(12.4), '12 ms');
      assert.strictEqual(formatMs(820), '820 ms');
      assert.strictEqual(formatMs(1200), '1.2 s');
      assert.strictEqual(formatMs(90_000), '1.5 min');
    });

    it('formats percentages', () => {
      assert.strictEqual(formatPercent(0), '0%');
      assert.strictEqual(formatPercent(0.0004), '<0.1%');
      assert.strictEqual(formatPercent(0.042), '4.2%');
      assert.strictEqual(formatPercent(0.05), '5%');
      assert.strictEqual(formatPercent(0.43), '43%');
    });

    it('labels edges with rate when windowed, else calls, plus errors', () => {
      assert.strictEqual(edgeLabel(stats({ count: 312 })), '312 calls');
      assert.strictEqual(edgeLabel(stats({ ratePerMin: 1240 })), '1,240 req/min');
      assert.strictEqual(edgeLabel(stats({ count: 50, errors: 2, errorRate: 0.04 })), '50 calls · 4% err');
    });

    it('summarises nodes', () => {
      assert.strictEqual(nodeSubtitle(stats({ p95: 820, errors: 1, errorRate: 0.042 })), '820 ms · 4.2%');
      assert.strictEqual(nodeSubtitle(stats({ count: 0, p95: null })), 'no calls');
      const node = {
        id: 'svc:pay',
        label: 'payment',
        type: 'service',
        health: 'critical',
        stats: { ...stats({ p95: 820, errors: 1, errorRate: 0.1 }), lastSeenMs: 0, spark: { count: [], errors: [] } },
      } as ModelNode;
      assert.strictEqual(nodeAriaLabel(node), 'payment, service, Critical, 10 calls, p95 820 ms, 10% errors');
      assert.strictEqual(
        nodeAriaLabel({ ...node, health: 'idle', stats: { ...node.stats, count: 0 } }),
        'payment, service, Idle, 0 calls'
      );
    });

    it('truncates long labels with an ellipsis', () => {
      assert.strictEqual(truncateLabel('checkout', 10), 'checkout');
      assert.strictEqual(truncateLabel('checkout-api-service', 10), 'checkout-…');
      assert.strictEqual(truncateLabel('abc', 1), '…');
    });
  });

  describe('geometry', () => {
    it('scales edge width logarithmically between 1 and 4', () => {
      assert.strictEqual(edgeWidth(0, 100), 1);
      assert.strictEqual(edgeWidth(5, 0), 1);
      assert.strictEqual(edgeWidth(100, 100), 4);
      const mid = edgeWidth(10, 1000);
      assert.ok(mid > 1.9 && mid < 2.1, String(mid));
    });

    it('draws sparklines scaled to the max value', () => {
      assert.strictEqual(sparklinePath([], 60, 10), '');
      assert.strictEqual(sparklinePath([0, 5, 10], 60, 10), 'M0,10L30,5L60,0');
      assert.strictEqual(sparklinePath([0, 0], 60, 10), 'M0,10L60,10');
      assert.strictEqual(sparklinePath([4], 60, 10), 'M0,0L60,0');
    });

    const box = (x: number, y: number): NodeBox => ({ x, y, width: 100, height: 56, layer: 0 });

    it('runs forward edges from bottom centre to top centre', () => {
      const g = edgePath(box(100, 50), box(200, 250), false);
      assert.strictEqual(g.d, 'M100,78 C100,150 200,150 200,222');
      assert.deepStrictEqual([g.labelX, g.labelY], [178.4, 172.75]);
    });

    it('loops back edges out to the right', () => {
      const g = edgePath(box(100, 250), box(100, 50), true);
      assert.ok(g.d.startsWith('M150,250 C'));
      assert.ok(g.d.endsWith(' 150,50'));
      assert.ok(g.labelX > 150);
    });

    it('fits content without enlarging past 1:1', () => {
      assert.deepStrictEqual(fitTransform(200, 100, 800, 600), { scale: 1, tx: 300, ty: 250 });
      const big = fitTransform(3200, 600, 800, 600);
      assert.ok(Math.abs(big.scale - (800 - 32) / 3200) < 1e-9);
      assert.strictEqual(fitTransform(100_000, 100, 800, 600).scale, MIN_SCALE);
      assert.deepStrictEqual(fitTransform(0, 0, 800, 600), { scale: 1, tx: 0, ty: 0 });
    });

    it('zooms around a fixed screen point and clamps the scale', () => {
      const t = zoomAt({ scale: 1, tx: 0, ty: 0 }, 2, 100, 50);
      assert.deepStrictEqual(t, { scale: 2, tx: -100, ty: -50 });
      // The content point under the cursor stays put.
      assert.strictEqual((100 - t.tx) / t.scale, 100);
      assert.strictEqual(zoomAt(t, 100, 0, 0).scale, MAX_SCALE);
      assert.strictEqual(zoomAt(t, 0.0001, 0, 0).scale, MIN_SCALE);
    });

    it('centres a content point in the view', () => {
      assert.deepStrictEqual(centerOn({ scale: 2, tx: 0, ty: 0 }, 100, 50, 800, 600), { scale: 2, tx: 200, ty: 200 });
    });
  });

  describe('state', () => {
    it('parses selections strictly', () => {
      assert.deepStrictEqual(parseSelection({ kind: 'node', id: 'svc:a', extra: 1 }), { kind: 'node', id: 'svc:a' });
      assert.deepStrictEqual(parseSelection({ kind: 'edge', source: 'a', target: 'b' }), {
        kind: 'edge',
        source: 'a',
        target: 'b',
      });
      for (const bad of [null, 'x', {}, { kind: 'node' }, { kind: 'node', id: '' }, { kind: 'node', id: 5 }, { kind: 'edge', source: 'a' }]) {
        assert.strictEqual(parseSelection(bad), null, JSON.stringify(bad));
      }
    });

    it('loads persisted state with defaults for bad values', () => {
      assert.deepStrictEqual(loadMapState(undefined), { range: '5m', selection: null, view: null });
      assert.deepStrictEqual(
        loadMapState({ range: '15m', selection: { kind: 'node', id: 'svc:a' }, view: { scale: 9, tx: 1, ty: 2 } }),
        { range: '15m', selection: { kind: 'node', id: 'svc:a' }, view: { scale: MAX_SCALE, tx: 1, ty: 2 } }
      );
      assert.deepStrictEqual(loadMapState({ range: 'toString', view: { scale: NaN, tx: 0, ty: 0 } }), {
        range: '5m',
        selection: null,
        view: null,
      });
    });

    it('compares selections by value', () => {
      assert.ok(sameSelection(null, null));
      assert.ok(!sameSelection(null, { kind: 'node', id: 'a' }));
      assert.ok(sameSelection({ kind: 'node', id: 'a' }, { kind: 'node', id: 'a' }));
      assert.ok(!sameSelection({ kind: 'node', id: 'a' }, { kind: 'edge', source: 'a', target: 'b' }));
      assert.ok(sameSelection({ kind: 'edge', source: 'a', target: 'b' }, { kind: 'edge', source: 'a', target: 'b' }));
    });
  });

  describe('parseMapMessage', () => {
    function ctx(selectionId: string | null = 'svc:checkout'): HostContext {
      const store = new TelemetryStore();
      addDistributedTrace(store);
      const tagged = store.getAllTaggedSpans();
      const model = buildServiceMap(tagged, { range: 'all' });
      const selection = selectionId ? ({ kind: 'node', id: selectionId } as const) : null;
      const details = selection ? buildNodeDetails(tagged, model, selection)! : null;
      return { seq: 7, model, details, selection };
    }

    it('rejects non-objects, unknown types and missing types', () => {
      for (const m of [null, undefined, 'ready', 42, [], {}, { type: 'nope' }, { type: '__proto__' }]) {
        assert.strictEqual(parseMapMessage(m, ctx()), undefined, JSON.stringify(m));
      }
    });

    it('accepts ready with defaults for bad range or selection', () => {
      assert.deepStrictEqual(parseMapMessage({ type: 'ready', range: '15m', selection: { kind: 'node', id: 'x' } }, ctx()), {
        type: 'ready',
        range: '15m',
        selection: { kind: 'node', id: 'x' },
      });
      assert.deepStrictEqual(parseMapMessage({ type: 'ready', range: 'forever', selection: 5 }, ctx()), {
        type: 'ready',
        range: '5m',
        selection: null,
      });
    });

    it('validates ranges', () => {
      assert.deepStrictEqual(parseMapMessage({ type: 'setRange', range: '1h' }, ctx()), { type: 'setRange', range: '1h' });
      for (const range of ['3m', 'toString', 5, undefined]) {
        assert.strictEqual(parseMapMessage({ type: 'setRange', range }, ctx()), undefined, String(range));
      }
    });

    it('only selects nodes and edges that exist in the posted model', () => {
      const c = ctx();
      assert.deepStrictEqual(parseMapMessage({ type: 'select', selection: null }, c), { type: 'select', selection: null });
      assert.deepStrictEqual(parseMapMessage({ type: 'select', selection: { kind: 'node', id: 'svc:frontend' } }, c), {
        type: 'select',
        selection: { kind: 'node', id: 'svc:frontend' },
      });
      assert.deepStrictEqual(
        parseMapMessage({ type: 'select', selection: { kind: 'edge', source: 'svc:frontend', target: 'svc:checkout' } }, c),
        { type: 'select', selection: { kind: 'edge', source: 'svc:frontend', target: 'svc:checkout' } }
      );
      for (const selection of [
        { kind: 'node', id: 'svc:ghost' },
        { kind: 'edge', source: 'svc:checkout', target: 'svc:frontend' },
        { kind: 'node' },
        'svc:frontend',
        undefined,
      ]) {
        assert.strictEqual(parseMapMessage({ type: 'select', selection }, c), undefined, JSON.stringify(selection));
      }
      assert.strictEqual(
        parseMapMessage({ type: 'select', selection: { kind: 'node', id: 'svc:frontend' } }, { ...c, model: null }),
        undefined
      );
    });

    it('only opens panels for a selected service node', () => {
      assert.deepStrictEqual(parseMapMessage({ type: 'open', target: 'logs' }, ctx()), { type: 'open', target: 'logs' });
      assert.strictEqual(parseMapMessage({ type: 'open', target: 'shell' }, ctx()), undefined);
      assert.strictEqual(parseMapMessage({ type: 'open', target: 'traces' }, ctx(null)), undefined);
      assert.strictEqual(parseMapMessage({ type: 'open', target: 'traces' }, ctx('db:postgresql:shop')), undefined);
    });

    it('bounds trace and source indexes to the posted details', () => {
      const c = ctx();
      assert.strictEqual(c.details!.slowTraces.length, 1);
      assert.deepStrictEqual(parseMapMessage({ type: 'revealTrace', seq: 7, list: 'slow', index: 0 }, c), {
        type: 'revealTrace',
        seq: 7,
        list: 'slow',
        index: 0,
      });
      assert.deepStrictEqual(parseMapMessage({ type: 'openSource', seq: 7, index: 0 }, c), {
        type: 'openSource',
        seq: 7,
        index: 0,
      });
      for (const m of [
        { type: 'revealTrace', seq: 7, list: 'slow', index: 1 },
        { type: 'revealTrace', seq: 7, list: 'slow', index: -1 },
        { type: 'revealTrace', seq: 7, list: 'slow', index: 0.5 },
        { type: 'revealTrace', seq: 7, list: 'slow', index: '0' },
        { type: 'revealTrace', seq: 7, list: 'error', index: 0 },
        { type: 'revealTrace', seq: 7, list: 'other', index: 0 },
        { type: 'openSource', seq: 7, index: 1 },
        { type: 'openSource', seq: 7, index: NaN },
        { type: 'openSource', seq: 7 },
      ]) {
        assert.strictEqual(parseMapMessage(m, c), undefined, JSON.stringify(m));
      }
    });

    it('rejects index actions from stale or missing details', () => {
      const c = ctx();
      assert.strictEqual(parseMapMessage({ type: 'revealTrace', seq: 6, list: 'slow', index: 0 }, c), undefined);
      assert.strictEqual(parseMapMessage({ type: 'openSource', seq: 8, index: 0 }, c), undefined);
      assert.strictEqual(parseMapMessage({ type: 'openSource', index: 0 }, c), undefined);
      assert.strictEqual(parseMapMessage({ type: 'openSource', seq: 7, index: 0 }, { ...c, details: null }), undefined);
    });
  });
});
