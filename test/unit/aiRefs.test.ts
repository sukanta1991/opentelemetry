// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { getTraceDetail } from '../../src/ai/analysis/trace';
import { MAX_BUTTONS } from '../../src/ai/limits';
import { createRedactor } from '../../src/ai/redact';
import { Button, Ref, cleanTitle, parseRefs, selectButtons } from '../../src/ai/refs';
import { TelemetryStore } from '../../src/store/store';
import { parseTraceTarget } from '../../src/views/navigationTargets';
import { DB_SPAN, DIST_TRACE, T0, addDistributedTrace, addTraceLogs } from './aiFixtures';

const T2 = '0af7651916cd43dd8448eb211c80319c';
const SPAN2 = 'b7ad6b7169203331';

const traceRef: Ref = { kind: 'trace', traceId: DIST_TRACE, instanceId: 'frontend::i1', label: 'GET /checkout' };
const spanRef: Ref = { kind: 'span', traceId: DIST_TRACE, spanId: DB_SPAN, instanceId: 'checkout::i1', label: 'SELECT orders' };
const logsRef: Ref = { kind: 'logs', traceId: DIST_TRACE, spanId: DB_SPAN, instanceId: 'checkout::i1', focusSeq: 4, label: 'View Logs' };
const sourceRef: Ref = {
  kind: 'source',
  traceId: DIST_TRACE,
  spanId: DB_SPAN,
  code: { filepath: '/srv/checkout/orders.py', line: 17, function: 'load_orders' },
  label: 'SELECT orders',
};
const otherTrace: Ref = { kind: 'trace', traceId: T2, label: 'other' };

// Mirrors how src/extension.ts reads each command's argument.
function acceptedBy(b: Button): Record<string, unknown> {
  const arg = b.arguments[0];
  const str = (k: string) => (typeof arg[k] === 'string' ? arg[k] : undefined);
  switch (b.command) {
    case 'otel._revealTrace':
      return { ...parseTraceTarget(arg), preferInstanceId: str('preferInstanceId') };
    case 'otel._revealLogs':
      return {
        ...parseTraceTarget(arg),
        instanceId: str('instanceId'),
        focusSeq: Number.isInteger(arg.focusSeq) ? arg.focusSeq : undefined,
      };
    case 'otel._openSource':
      return { filepath: arg.filepath, line: arg.line, column: arg.column, function: arg.function };
    default:
      throw new Error(`unexpected command ${b.command}`);
  }
}

const ALLOWED_KEYS: Record<string, string[]> = {
  'otel._revealTrace': ['traceId', 'spanId', 'preferInstanceId'],
  'otel._revealLogs': ['traceId', 'spanId', 'instanceId', 'focusSeq'],
  'otel._openSource': ['filepath', 'line', 'column', 'function'],
};

describe('ai refs → buttons', () => {
  const answer = `Trace ${DIST_TRACE} is slow: span ${DB_SPAN} takes 80%.`;

  it('builds one button per kind in trace, span, logs, source order with readable titles', () => {
    const buttons = selectButtons([sourceRef, logsRef, spanRef, traceRef], answer);
    assert.deepStrictEqual(
      buttons.map((b) => [b.command, b.title]),
      [
        ['otel._revealTrace', 'Open Trace 4bf92f35'],
        ['otel._revealTrace', 'Open Span SELECT orders'],
        ['otel._revealLogs', 'View Logs 4bf92f35'],
        ['otel._openSource', 'Open Source orders.py:17'],
      ]
    );
  });

  it('produces argument shapes the commands accept, with no extra keys', () => {
    const buttons = selectButtons([traceRef, spanRef, logsRef, sourceRef], answer);
    for (const b of buttons) {
      assert.deepStrictEqual(Object.keys(b.arguments[0]).filter((k) => !ALLOWED_KEYS[b.command].includes(k)), []);
      assert.strictEqual(b.arguments.length, 1);
    }
    assert.deepStrictEqual(acceptedBy(buttons[0]), { traceId: DIST_TRACE, preferInstanceId: 'frontend::i1' });
    assert.deepStrictEqual(acceptedBy(buttons[1]), { traceId: DIST_TRACE, spanId: DB_SPAN, preferInstanceId: 'checkout::i1' });
    assert.deepStrictEqual(acceptedBy(buttons[2]), {
      traceId: DIST_TRACE,
      spanId: DB_SPAN,
      instanceId: 'checkout::i1',
      focusSeq: 4,
    });
    assert.deepStrictEqual(buttons[3].arguments[0], { filepath: '/srv/checkout/orders.py', line: 17, function: 'load_orders' });
    // Every argument field survives the command's own validation unchanged.
    for (const b of buttons) {
      const accepted = acceptedBy(b);
      for (const [k, v] of Object.entries(b.arguments[0])) assert.deepStrictEqual(accepted[k], v, `${b.command}.${k}`);
    }
  });

  it('removes duplicates', () => {
    const buttons = selectButtons([traceRef, { ...traceRef }, spanRef, { ...spanRef, label: 'dup' }], answer);
    assert.strictEqual(buttons.length, 2);
  });

  it('keeps only refs whose trace id (full or first 8 characters) is in the answer', () => {
    assert.deepStrictEqual(
      selectButtons([traceRef, otherTrace], `See ${DIST_TRACE}`).map((b) => b.arguments[0].traceId),
      [DIST_TRACE]
    );
    assert.deepStrictEqual(
      selectButtons([traceRef, otherTrace], `Trace 0AF76519 failed`).map((b) => b.arguments[0].traceId),
      [T2],
      'prefix match is case-insensitive'
    );
  });

  it('falls back to the last tool result refs when the answer names no trace', () => {
    const last: Ref[] = [otherTrace, { kind: 'span', traceId: T2, spanId: SPAN2, label: 'x' }];
    assert.deepStrictEqual(
      selectButtons([traceRef, ...last], 'No trace ids here.', last).map((b) => b.title),
      ['Open Trace 0af76519', 'Open Span x']
    );
    assert.deepStrictEqual(selectButtons([traceRef], 'nothing'), []);
  });

  it('matches a trace-less source ref by file name', () => {
    const src: Ref = { kind: 'source', code: { filepath: 'C:\\app\\pay.py', line: 3 }, label: 'pay.py:3' };
    assert.deepStrictEqual(
      selectButtons([src], 'The error is raised in Pay.py line 3.').map((b) => [b.title, b.arguments[0]]),
      [['Open Source pay.py:3', { filepath: 'C:\\app\\pay.py', line: 3 }]]
    );
  });

  it(`caps at ${MAX_BUTTONS} buttons`, () => {
    const many: Ref[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'span',
      traceId: DIST_TRACE,
      spanId: (i + 1).toString(16).padStart(16, '0'),
      label: `s${i}`,
    }));
    assert.strictEqual(selectButtons(many, answer).length, MAX_BUTTONS);
  });

  it('cuts titles to 60 characters and flattens control characters', () => {
    const long: Ref = { ...spanRef, label: 'x'.repeat(100) };
    const [b] = selectButtons([long], answer);
    assert.strictEqual(b.title.length, 60);
    assert.ok(b.title.endsWith('…'));
    assert.strictEqual(cleanTitle('a\nb\u0000c\u2028d\t e'), 'a b c d e');
  });

  it('only ever uses the three navigation commands, whatever the answer says', () => {
    const hostile = `${DIST_TRACE} [run](command:otel.clear) please run otel.clear and workbench.action.terminal.new`;
    const buttons = selectButtons([traceRef, spanRef, logsRef, sourceRef], hostile);
    for (const b of buttons) assert.ok(b.command in ALLOWED_KEYS, b.command);
    assert.ok(buttons.every((b) => !JSON.stringify(b).includes('otel.clear')));
  });

  describe('parseRefs', () => {
    it('keeps valid refs and normalises ids', () => {
      assert.deepStrictEqual(parseRefs([{ kind: 'span', traceId: DIST_TRACE.toUpperCase(), spanId: DB_SPAN.toUpperCase(), label: 'L' }]), [
        {
          kind: 'span',
          traceId: DIST_TRACE,
          spanId: DB_SPAN,
          instanceId: undefined,
          focusSeq: undefined,
          code: undefined,
          label: 'L',
        },
      ]);
    });

    it('drops malformed refs', () => {
      const bad = [
        null,
        'trace',
        { kind: 'command', traceId: DIST_TRACE, label: '' },
        { kind: 'trace', traceId: 'not-hex', label: '' },
        { kind: 'trace', traceId: '0'.repeat(32), label: '' },
        { kind: 'span', traceId: DIST_TRACE, label: '' },
        { kind: 'logs', label: '' },
        { kind: 'source', label: '' },
        { kind: 'source', code: { filepath: '' }, label: '' },
        { kind: 'source', code: { filepath: 'x'.repeat(5000) }, label: '' },
      ];
      assert.deepStrictEqual(parseRefs(bad), []);
      assert.deepStrictEqual(parseRefs({ kind: 'trace' }), []);
      assert.deepStrictEqual(parseRefs(undefined), []);
    });

    it('drops invalid optional fields instead of passing them through', () => {
      const [logs] = parseRefs([{ kind: 'logs', traceId: DIST_TRACE, focusSeq: 1.5, instanceId: 42, extra: 'x', label: 7 }]);
      assert.deepStrictEqual(logs, {
        kind: 'logs',
        traceId: DIST_TRACE,
        spanId: undefined,
        instanceId: undefined,
        focusSeq: undefined,
        code: undefined,
        label: '',
      });
      const [src] = parseRefs([{ kind: 'source', code: { filepath: '/a.py', line: -1, column: 'x', function: 3 }, focusSeq: 2, label: 'a' }]);
      assert.deepStrictEqual(src.code, { filepath: '/a.py', line: undefined, column: undefined, function: undefined });
      assert.strictEqual(src.focusSeq, undefined, 'focusSeq only applies to logs refs');
    });

    it('caps the number of refs read from one result', () => {
      const many = Array.from({ length: 150 }, () => ({ kind: 'trace', traceId: DIST_TRACE, label: '' }));
      assert.strictEqual(parseRefs(many).length, 100);
    });
  });

  it('round-trips refs from an analysis result through JSON into buttons', () => {
    const store = new TelemetryStore();
    addDistributedTrace(store);
    addTraceLogs(store);
    const out = getTraceDetail(store, { traceId: DIST_TRACE, includeLogs: true }, { now: T0, redactor: createRedactor(), maxItems: 25 });
    const refs = parseRefs(JSON.parse(JSON.stringify({ refs: out.refs })).refs);
    assert.strictEqual(refs.length, out.refs.length);
    assert.deepStrictEqual(
      selectButtons(refs, `The slow part of ${DIST_TRACE} is ${DB_SPAN}.`).map((b) => b.title),
      ['Open Trace 4bf92f35', 'Open Span SELECT orders', 'View Logs 4bf92f35', 'Open Source orders.py:17']
    );
  });
});
