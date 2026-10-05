// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { allTraceIds, latestTraceId, resolveSpanId, resolveTraceId } from '../../src/ai/resolve';
import { TelemetryStore } from '../../src/store/store';
import { DIST_TRACE, T0, addDistributedTrace, addSpans, span } from './aiFixtures';

const A = 'aaaaaaaa11111111aaaaaaaa11111111';
const A2 = 'aaaaaaaa22222222aaaaaaaa22222222';
const B = 'bbbbbbbb00000000bbbbbbbb00000000';

function build(): TelemetryStore {
  const store = new TelemetryStore();
  addDistributedTrace(store, DIST_TRACE, T0);
  addSpans(store, 'svc', [
    span({ traceId: A, spanId: 'a1a1a1a1a1a1a1a1', startMs: T0 + 1000 }),
    span({ traceId: A2, spanId: 'a2a2a2a2a2a2a2a2', startMs: T0 + 2000 }),
    span({ traceId: B, spanId: 'b1b1b1b1b1b1b1b1', startMs: T0 + 3000, statusCode: 'ERROR' }),
  ]);
  return store;
}

describe('ai resolve', () => {
  describe('resolveTraceId', () => {
    const store = build();

    it('accepts a full id, uppercase or 0x-prefixed', () => {
      assert.deepStrictEqual(resolveTraceId(store, DIST_TRACE), { traceId: DIST_TRACE });
      assert.deepStrictEqual(resolveTraceId(store, ` ${DIST_TRACE.toUpperCase()} `), { traceId: DIST_TRACE });
    });

    it('accepts a W3C traceparent', () => {
      assert.deepStrictEqual(resolveTraceId(store, `00-${DIST_TRACE}-a000000000000001-01`), { traceId: DIST_TRACE });
    });

    it('resolves a unique prefix across instances', () => {
      assert.deepStrictEqual(resolveTraceId(store, '4bf92f35'), { traceId: DIST_TRACE });
      assert.deepStrictEqual(resolveTraceId(store, 'BBBBBBBB'), { traceId: B });
    });

    it('lists candidates for an ambiguous prefix', () => {
      const r = resolveTraceId(store, 'aaaaaaaa');
      assert.ok('error' in r);
      assert.match(r.error, /ambiguous/);
      assert.ok(r.error.includes(A) && r.error.includes(A2));
    });

    it('caps the candidate list at 5', () => {
      const s = new TelemetryStore();
      const ids = Array.from({ length: 7 }, (_, i) => `cccccccc${String(i).padStart(24, '0')}`);
      addSpans(s, 'svc', ids.map((traceId, i) => span({ traceId, spanId: `${i + 1}`.padStart(16, 'd') })));
      const r = resolveTraceId(s, 'cccccccc');
      assert.ok('error' in r);
      assert.strictEqual(ids.filter((id) => r.error.includes(id)).length, 5);
      assert.match(r.error, /and 2 more/);
    });

    it('reports unknown ids as possibly evicted', () => {
      const r = resolveTraceId(store, 'f'.repeat(32));
      assert.ok('error' in r);
      assert.match(r.error, /not found; it may have been evicted/);
      const p = resolveTraceId(store, 'deadbeef');
      assert.ok('error' in p);
      assert.match(p.error, /evicted/);
    });

    it('rejects the all-zero id, bad input and short prefixes', () => {
      for (const raw of ['0'.repeat(32), 'hello', 'abc', '', '   ', 42, undefined, '4bf92f35-x']) {
        const r = resolveTraceId(store, raw);
        assert.ok('error' in r, `expected error for ${String(raw)}`);
      }
    });
  });

  describe('resolveSpanId', () => {
    const store = build();
    const parts = store.getTraceParts(DIST_TRACE);

    it('accepts a full id across trace parts', () => {
      assert.deepStrictEqual(resolveSpanId(parts, 'B000000000000002'), { spanId: 'b000000000000002' });
    });

    it('resolves a unique prefix and lists candidates for an ambiguous one', () => {
      assert.deepStrictEqual(resolveSpanId(store.getTraceParts(A), 'A1A1A1A1'), { spanId: 'a1a1a1a1a1a1a1a1' });
      const amb = resolveSpanId(parts, 'a0000000');
      assert.ok('error' in amb);
      assert.ok(amb.error.includes('a000000000000001') && amb.error.includes('a000000000000002'));
    });

    it('errors on unknown or malformed span ids', () => {
      assert.ok('error' in resolveSpanId(parts, 'ffffffffffffffff'));
      assert.ok('error' in resolveSpanId(parts, 'ffffffff'));
      assert.ok('error' in resolveSpanId(parts, '0'.repeat(16)));
      assert.ok('error' in resolveSpanId(parts, 'abc'));
      assert.ok('error' in resolveSpanId(parts, null));
    });
  });

  describe('allTraceIds / latestTraceId', () => {
    it('orders newest first with a deterministic id tiebreak', () => {
      const store = build();
      const tie1 = 'eeeeeeee00000000eeeeeeee00000002';
      const tie2 = 'eeeeeeee00000000eeeeeeee00000001';
      addSpans(store, 'other', [
        span({ traceId: tie1, spanId: 'e1e1e1e1e1e1e1e1', startMs: T0 + 500 }),
        span({ traceId: tie2, spanId: 'e2e2e2e2e2e2e2e2', startMs: T0 + 500 }),
      ]);
      const expected = [B, A2, A, tie2, tie1, DIST_TRACE];
      assert.deepStrictEqual(allTraceIds(store), expected);
      assert.deepStrictEqual(allTraceIds(store), expected, 'stable across calls');
      assert.deepStrictEqual(allTraceIds(store, 2), [B, A2]);
    });

    it('uses the earliest start across instances for a distributed trace', () => {
      const store = new TelemetryStore();
      addDistributedTrace(store, DIST_TRACE, T0 + 100);
      addSpans(store, 'svc', [span({ traceId: A, spanId: 'a1a1a1a1a1a1a1a1', startMs: T0 + 110 })]);
      // checkout's part starts at T0+120, frontend's at T0+100: the trace sorts at T0+100.
      assert.deepStrictEqual(allTraceIds(store), [A, DIST_TRACE]);
    });

    it('returns the newest trace, optionally matching a predicate', () => {
      const store = build();
      assert.strictEqual(latestTraceId(store), B);
      assert.strictEqual(
        latestTraceId(store, (_id, parts) => parts.some((p) => p.serviceName === 'checkout')),
        DIST_TRACE
      );
      assert.strictEqual(latestTraceId(store, () => false), undefined);
      assert.strictEqual(latestTraceId(new TelemetryStore()), undefined);
    });
  });
});
