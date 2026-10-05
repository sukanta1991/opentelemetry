// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import {
  HistoryTurn,
  LoopHost,
  LoopPart,
  MAX_HISTORY_CHARS,
  ToolOutcome,
  chatErrorMessage,
  disabledMarkdown,
  emptyStoreMarkdown,
  historyMessages,
  runToolLoop,
} from '../../src/ai/chatLoop';
import { MAX_HISTORY_TURNS, MAX_TOOL_ROUNDS } from '../../src/ai/limits';
import { COMMAND_TEMPLATES } from '../../src/ai/prompt';
import { TOOL_NAMES } from '../../src/ai/toolNames';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER = '0af7651916cd43dd8448eb211c80319c';

type Msg = { role: 'user' | 'assistant' | 'tool'; parts?: LoopPart[]; results?: ToolOutcome[]; text?: string };

class FakeHost implements LoopHost<Msg> {
  sent: Msg[][] = [];
  invoked: { name: string; input: object }[] = [];
  markdowns: string[] = [];
  progresses: string[] = [];
  cancelled = false;
  constructor(
    private readonly rounds: (LoopPart | undefined)[][],
    private readonly tool: (name: string, input: object) => Promise<string> = async () => '{}',
    readonly onSend?: (round: number) => void
  ) {}
  async send(messages: Msg[]): Promise<AsyncIterable<LoopPart | undefined>> {
    this.sent.push([...messages]);
    this.onSend?.(this.sent.length);
    const parts = this.rounds[Math.min(this.sent.length - 1, this.rounds.length - 1)];
    return (async function* () {
      for (const p of parts) yield p;
    })();
  }
  assistant(parts: LoopPart[]): Msg {
    return { role: 'assistant', parts };
  }
  toolResults(results: ToolOutcome[]): Msg {
    return { role: 'tool', results };
  }
  invokeTool(name: string, input: object): Promise<string> {
    this.invoked.push({ name, input });
    return this.tool(name, input);
  }
  toolErrorText(e: unknown): string {
    return e instanceof Error && e.message === 'declined' ? 'user declined' : `error: ${(e as Error).message}`;
  }
  isCancelled(): boolean {
    return this.cancelled;
  }
  markdown(text: string): void {
    this.markdowns.push(text);
  }
  progress(text: string): void {
    this.progresses.push(text);
  }
}

const text = (t: string): LoopPart => ({ kind: 'text', text: t });
const call = (id: string, name = 'otel_getTrace', input: object = {}): LoopPart => ({ kind: 'call', callId: id, name, input });
const allowed = new Set<string>(TOOL_NAMES);
const initial: Msg[] = [{ role: 'user', text: 'instructions' }, { role: 'user', text: 'question' }];
const resultWithRefs = (traceId: string) =>
  JSON.stringify({ ok: true, refs: [{ kind: 'trace', traceId, label: 'x' }, { kind: 'bogus' }] });

describe('ai chat loop', () => {
  it('streams a plain answer in one round', async () => {
    const host = new FakeHost([[text('All '), undefined, text('good.')]]);
    const r = await runToolLoop(host, initial, allowed);
    assert.deepStrictEqual(r, { finalText: 'All good.', refs: [], lastRefs: [], rounds: 1, hitRoundCap: false, cancelled: false });
    assert.deepStrictEqual(host.markdowns, ['All ', 'good.']);
    assert.strictEqual(host.sent.length, 1);
    assert.deepStrictEqual(host.sent[0], initial);
  });

  it('answers every tool call, keeps text and calls in the assistant message, and collects refs', async () => {
    const host = new FakeHost(
      [[text('Looking…'), call('c1'), call('c2', 'otel_searchTraces', { query: 'status=error' })], [text(`Trace ${TRACE} is slow.`)]],
      async (name) => (name === 'otel_getTrace' ? resultWithRefs(TRACE) : resultWithRefs(OTHER))
    );
    const r = await runToolLoop(host, initial, allowed);
    assert.strictEqual(r.rounds, 2);
    assert.strictEqual(r.finalText, `Looking…Trace ${TRACE} is slow.`);
    const second = host.sent[1];
    assert.deepStrictEqual(second[2], { role: 'assistant', parts: [text('Looking…'), call('c1'), call('c2', 'otel_searchTraces', { query: 'status=error' })] });
    assert.deepStrictEqual(
      second[3].results!.map((x) => x.callId),
      ['c1', 'c2']
    );
    assert.deepStrictEqual(
      r.refs.map((x) => x.traceId),
      [TRACE, OTHER],
      'malformed refs dropped'
    );
    assert.deepStrictEqual(
      r.lastRefs.map((x) => x.traceId),
      [OTHER]
    );
    assert.deepStrictEqual(host.progresses, ['Running otel_getTrace…', 'Running otel_searchTraces…']);
    assert.deepStrictEqual(host.invoked[1].input, { query: 'status=error' });
  });

  it('turns failures, declines and unknown tools into results instead of dropping them', async () => {
    const round = [
      call('a', 'otel_getTrace', { which: 'fail' }),
      call('b', 'otel_getTrace', { which: 'decline' }),
      call('c', 'other_ext_tool'),
      call('d', 'otel_getTrace', {}),
    ];
    const host = new FakeHost([round, [text('done')]], async (_n, input) => {
      const which = (input as { which?: string }).which;
      if (which === 'fail') throw new Error('boom');
      if (which === 'decline') throw new Error('declined');
      return 'not json';
    });
    const r = await runToolLoop(host, initial, allowed);
    assert.deepStrictEqual(host.sent[1][3].results, [
      { callId: 'a', text: 'error: boom' },
      { callId: 'b', text: 'user declined' },
      { callId: 'c', text: 'error: tool "other_ext_tool" is not available here' },
      { callId: 'd', text: 'not json' },
    ]);
    assert.ok(!host.invoked.some((i) => i.name === 'other_ext_tool'), 'only our tools are invoked');
    assert.deepStrictEqual(r.refs, []);
  });

  it(`stops after ${MAX_TOOL_ROUNDS} rounds`, async () => {
    const host = new FakeHost([[call('x')]]);
    const r = await runToolLoop(host, initial, allowed);
    assert.strictEqual(r.hitRoundCap, true);
    assert.strictEqual(r.rounds, MAX_TOOL_ROUNDS);
    assert.strictEqual(host.sent.length, MAX_TOOL_ROUNDS);
    // Each round adds one assistant message and one tool-result message.
    assert.strictEqual(host.sent.at(-1)!.length, initial.length + 2 * (MAX_TOOL_ROUNDS - 1));
  });

  it('checks for cancellation before each round and each call', async () => {
    const before = new FakeHost([[text('x')]]);
    before.cancelled = true;
    assert.strictEqual((await runToolLoop(before, initial, allowed)).cancelled, true);
    assert.strictEqual(before.sent.length, 0);

    const host: FakeHost = new FakeHost([[call('a'), call('b')], [text('never')]], async () => {
      host.cancelled = true;
      return '{}';
    });
    const r = await runToolLoop(host, initial, allowed);
    assert.strictEqual(r.cancelled, true);
    assert.strictEqual(host.invoked.length, 1, 'second call skipped');
    assert.strictEqual(host.sent.length, 1, 'no further round');
  });

  it('treats a rejection caused by cancellation as cancellation', async () => {
    const host: FakeHost = new FakeHost([[call('a')], [text('never')]], async () => {
      host.cancelled = true;
      throw new Error('Canceled');
    });
    const r = await runToolLoop(host, initial, allowed);
    assert.strictEqual(r.cancelled, true);
    assert.strictEqual(host.sent.length, 1);
  });

  describe('historyMessages', () => {
    it('keeps the last turns, applies command templates and cuts long text', () => {
      const turns: HistoryTurn[] = [
        { role: 'user', text: 'old' },
        { role: 'assistant', text: 'old answer' },
        ...Array.from({ length: MAX_HISTORY_TURNS - 2 }, (_, i) => ({ role: 'assistant' as const, text: `a${i}` })),
        { role: 'user', text: '', command: 'slow' },
        { role: 'assistant', text: 'y'.repeat(MAX_HISTORY_CHARS + 50) },
      ];
      const out = historyMessages(turns);
      assert.strictEqual(out.length, MAX_HISTORY_TURNS);
      assert.deepStrictEqual(out.at(-2), { role: 'user', text: COMMAND_TEMPLATES.slow });
      assert.strictEqual(out.at(-1)!.text.length, MAX_HISTORY_CHARS);
      assert.ok(!out.some((t) => t.text === 'old'));
    });

    it('drops empty turns', () => {
      assert.deepStrictEqual(historyMessages([{ role: 'assistant', text: '  ' }, { role: 'user', text: 'hi' }]), [{ role: 'user', text: 'hi' }]);
    });
  });

  describe('messages', () => {
    it('explains the disabled state and the empty store', () => {
      assert.match(disabledMarkdown(), /otel\.ai\.enabled/);
      assert.match(disabledMarkdown(), /redacted/);
      assert.match(disabledMarkdown(), /OpenTelemetry AI\*\* output channel/);
      assert.match(emptyStoreMarkdown(false), /not running/);
      assert.match(emptyStoreMarkdown(true), /Copy OTLP Endpoint/);
    });

    it('maps errors to short, fixed chat text', () => {
      assert.match(chatErrorMessage(new Error('x'), 'NoPermissions'), /not allowed/);
      assert.match(chatErrorMessage(new Error('x'), 'Blocked'), /blocked/);
      assert.match(chatErrorMessage(new Error('x'), 'NotFound'), /no longer available/);
      assert.match(chatErrorMessage(new Error('x'), 'Weird\ncode'), /^The language model returned an error \(Weird code\)\.$/);
      assert.strictEqual(
        chatErrorMessage(new Error('Model does not support tools')),
        'The selected model may not support tool calling; pick another model.'
      );
      const other = chatErrorMessage(new Error('secret path /home/u/.ssh at line 3'));
      assert.ok(!other.includes('secret') && other.includes('output channel'));
    });
  });
});
