// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { genAiSummary } from '../../src/ai/analysis/genai';
import { createRedactor } from '../../src/ai/redact';
import { parseGenAiSummaryInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import { AGENT_CONTENT, AGENT_TRACE, DIST_TRACE, T0, addAgentTrace, addBaselineTraces, addDistributedTrace } from './aiFixtures';

const ctx = { now: T0 + 90_000, redactor: createRedactor(), maxItems: 25 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseGenAiSummaryInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return genAiSummary(store, input.value, ctx);
}

describe('ai genAiSummary', () => {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addAgentTrace(store);
  addBaselineTraces(store); // newer, but without gen_ai.* attributes

  it('defaults to the newest trace with gen_ai attributes', () => {
    assert.strictEqual(run(store, {}).result.traceId, AGENT_TRACE);
  });

  it('splits agent time, counting parallel tool calls once', () => {
    const { result } = run(store, {});
    assert.deepStrictEqual(result.agent, { name: 'travel', spanId: '9000000000000001', durationMs: 1000, provider: 'openai' });
    assert.deepStrictEqual(result.time, { llmTimeMs: 600, toolTimeMs: 300, otherMs: 100 });
  });

  it('totals tokens across old and new attribute names, including string values', () => {
    const { result } = run(store, {});
    assert.deepStrictEqual(result.tokens, {
      input: 230,
      output: 60,
      byModel: [
        { model: 'gpt-4o', calls: 1, inputTokens: 50, outputTokens: 30 },
        { model: 'gpt-4o-2024-08-06', calls: 1, inputTokens: 100, outputTokens: 20 },
        { model: 'gpt-4o-mini', calls: 1, inputTokens: 80, outputTokens: 10 },
      ],
    });
    const legacy = result.llmCalls.find((c: any) => c.spanId === '9000000000000005');
    assert.strictEqual(legacy.provider, 'openai');
    assert.strictEqual(legacy.inputTokens, 80);
    assert.strictEqual(legacy.outputTokens, 10);
  });

  it('lists tool calls by duration and detects the failed one', () => {
    const { result } = run(store, {});
    assert.deepStrictEqual(
      result.toolCalls.map((t: any) => [t.toolName, t.durationMs, t.status, t.callId]),
      [
        ['search', 300, 'UNSET', 'call_1'],
        ['book', 200, 'ERROR', 'call_2'],
      ]
    );
    assert.deepStrictEqual(result.failed, [
      { kind: 'tool', spanId: '9000000000000004', name: 'book', errorType: 'BookingError', statusMessage: 'booking failed' },
    ]);
    assert.deepStrictEqual(result.slowest, {
      llm: { spanId: '9000000000000006', name: 'chat gpt-4o', durationMs: 250 },
      tool: { spanId: '9000000000000003', toolName: 'search', durationMs: 300 },
    });
  });

  it('never returns prompt or completion content, only its length', () => {
    const { result } = run(store, {});
    const text = JSON.stringify(result);
    for (const content of AGENT_CONTENT) assert.ok(!text.includes(content), `leaked "${content}"`);
    const first = result.llmCalls.find((c: any) => c.spanId === '9000000000000002');
    assert.deepStrictEqual(Object.keys(first.contentChars), ['gen_ai.input.messages']);
    assert.ok(first.contentChars['gen_ai.input.messages'] > AGENT_CONTENT[0].length);
    assert.deepStrictEqual(result.llmCalls[1].contentChars, { 'gen_ai.prompt': AGENT_CONTENT[1].length });
  });

  it('emits refs for the trace, slowest tool, first failed tool and slowest LLM call', () => {
    const { refs } = run(store, {});
    assert.deepStrictEqual(
      refs.map((r: any) => [r.kind, r.spanId, r.instanceId]),
      [
        ['trace', undefined, 'agent-app::i1'],
        ['span', '9000000000000003', 'agent-app::i1'],
        ['span', '9000000000000004', 'agent-app::i1'],
        ['span', '9000000000000006', 'agent-app::i1'],
      ]
    );
  });

  it('explains when there is no GenAI data', () => {
    const plain = new TelemetryStore();
    addDistributedTrace(plain);
    assert.match(run(plain, {}).result.error, /no trace with gen_ai/);
    assert.match(run(store, { traceId: DIST_TRACE }).result.error, /has no gen_ai/);
  });

  it('caps listed calls with limit but keeps the counts', () => {
    const { result } = run(store, { limit: 1 });
    assert.strictEqual(result.llmCalls.length, 1);
    assert.strictEqual(result.llmCallCount, 3);
    assert.strictEqual(result.toolCallCount, 2);
  });
});
