import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import { parseTraceIdInput, parseTraceTarget, pickTraceInstance } from '../../src/views/navigationTargets';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

function span(spanId: string, startMs: number, parentSpanId?: string): Span {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId,
    name: spanId,
    kind: 'INTERNAL',
    startMs,
    endMs: startMs + 1,
    durationMs: 1,
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
  };
}

const resource = (svc: string) => ({ serviceName: svc, serviceInstanceId: 'i', attrs: {} });

describe('navigationTargets', () => {
  describe('parseTraceTarget', () => {
    it('normalises ids and drops an invalid span', () => {
      assert.deepStrictEqual(parseTraceTarget({ traceId: TRACE.toUpperCase(), spanId: SPAN }), {
        traceId: TRACE,
        spanId: SPAN,
      });
      assert.deepStrictEqual(parseTraceTarget({ traceId: TRACE, spanId: 'nope' }), { traceId: TRACE });
    });

    it('rejects missing or malformed traces', () => {
      assert.strictEqual(parseTraceTarget(undefined), undefined);
      assert.strictEqual(parseTraceTarget('x'), undefined);
      assert.strictEqual(parseTraceTarget({ traceId: '<script>' }), undefined);
      assert.strictEqual(parseTraceTarget({ traceId: '0'.repeat(32) }), undefined);
    });
  });

  describe('parseTraceIdInput', () => {
    it('accepts a bare trace id', () => {
      assert.deepStrictEqual(parseTraceIdInput(`  ${TRACE}  `), { traceId: TRACE });
    });

    it('extracts trace and parent span from a traceparent', () => {
      const expected = { traceId: TRACE, spanId: SPAN };
      assert.deepStrictEqual(parseTraceIdInput(`00-${TRACE}-${SPAN}-01`), expected);
      assert.deepStrictEqual(parseTraceIdInput(`traceparent: 00-${TRACE}-${SPAN}-01`), expected);
    });

    it('rejects anything else', () => {
      assert.strictEqual(parseTraceIdInput(''), undefined);
      assert.strictEqual(parseTraceIdInput('hello'), undefined);
      assert.strictEqual(parseTraceIdInput(`00-${TRACE}-${SPAN}`), undefined);
    });
  });

  describe('pickTraceInstance', () => {
    function store(): TelemetryStore {
      const s = new TelemetryStore();
      s.ingestSpans([{ resource: resource('child'), spans: [span('2222222222222222', 20, '1111111111111111')] }]);
      s.ingestSpans([{ resource: resource('root'), spans: [span('1111111111111111', 10)] }]);
      s.ingestSpans([{ resource: resource('other'), spans: [span('3333333333333333', 30)] }]);
      return s;
    }

    it('returns undefined for an unknown trace', () => {
      assert.strictEqual(pickTraceInstance(store(), 'f'.repeat(32)), undefined);
    });

    it('prefers the caller instance when it holds the trace', () => {
      assert.strictEqual(pickTraceInstance(store(), TRACE, 'child::i'), 'child::i');
    });

    it('falls back to the instance with the earliest root span', () => {
      assert.strictEqual(pickTraceInstance(store(), TRACE), 'root::i');
      assert.strictEqual(pickTraceInstance(store(), TRACE, 'missing::i'), 'root::i');
    });

    it('uses the first holder when no instance has a root', () => {
      const s = new TelemetryStore();
      s.ingestSpans([{ resource: resource('a'), spans: [span('2222222222222222', 20, '1111111111111111')] }]);
      assert.strictEqual(pickTraceInstance(s, TRACE), 'a::i');
    });
  });
});
