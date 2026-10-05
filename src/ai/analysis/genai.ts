// SPDX-License-Identifier: Apache-2.0
// otel_genAiSummary: time split, token usage and tool calls of one AI-agent trace.
// Prompt/completion content is never returned, only its length.

import { AttributeValue, KeyValueMap, Span } from '../../store/model';
import { TaggedSpan, TelemetryStore } from '../../store/store';
import { buildWaterfall } from '../../views/waterfall';
import { MAX_SCAN_TRACES } from '../limits';
import { Ref } from '../refs';
import { latestTraceId, resolveTraceId } from '../resolve';
import { truncateString } from '../serialize';
import { GenAiSummaryInput } from '../toolInputs';
import {
  AnalysisContext,
  AnalysisOutput,
  errorOutput,
  isGenAiContentKey,
  refLabel,
  round1,
  spanRef,
  spansById,
  taggedSpans,
  traceRef,
} from './common';

const LLM_OPS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);
const AGENT_OPS = new Set(['invoke_agent', 'create_agent']);

type Kind = 'llm' | 'tool' | 'agent' | 'other';

const str = (v: AttributeValue | undefined) => (typeof v === 'string' && v ? v : undefined);

function num(v: AttributeValue | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const first = (a: KeyValueMap, ...keys: string[]) => keys.map((k) => a[k]).find((v) => v !== undefined && v !== null);

function kindOf(s: Span): Kind {
  const a = s.attrs;
  const op = str(a['gen_ai.operation.name']);
  if (op === 'execute_tool' || str(a['gen_ai.tool.name'])) return 'tool';
  if (op && AGENT_OPS.has(op)) return 'agent';
  if (
    (op && LLM_OPS.has(op)) ||
    str(a['gen_ai.request.model']) ||
    num(first(a, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens')) !== undefined ||
    num(first(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens')) !== undefined
  ) {
    return 'llm';
  }
  return 'other';
}

function hasGenAi(spans: Iterable<TaggedSpan>): boolean {
  for (const t of spans) for (const k of Object.keys(t.span.attrs)) if (k.startsWith('gen_ai.')) return true;
  return false;
}

// Merged length of [start, end) ranges, clipped to [lo, hi].
function unionMs(ranges: [number, number][], lo: number, hi: number): number {
  const clipped = ranges
    .map(([s, e]) => [Math.max(lo, s), Math.min(hi, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = 0;
  let curE = -Infinity;
  for (const [s, e] of clipped) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) total += curE - curS;
  return total;
}

function contentChars(attrs: KeyValueMap): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const k of Object.keys(attrs).filter(isGenAiContentKey).sort()) {
    const v = attrs[k];
    out[k] = typeof v === 'string' ? v.length : JSON.stringify(v)?.length ?? 0;
  }
  return Object.keys(out).length ? out : undefined;
}

const range = (s: Span): [number, number] => [s.startMs, s.startMs + s.durationMs];
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function genAiSummary(store: TelemetryStore, input: GenAiSummaryInput, ctx: AnalysisContext): AnalysisOutput {
  const r = ctx.redactor;
  let traceId: string;
  if (input.traceId) {
    const res = resolveTraceId(store, input.traceId);
    if ('error' in res) return errorOutput(res.error);
    traceId = res.traceId;
  } else {
    const latest = latestTraceId(store, (_id, parts) => hasGenAi(taggedSpans(parts)), MAX_SCAN_TRACES);
    if (!latest) return errorOutput('no trace with gen_ai.* attributes found among the most recent traces');
    traceId = latest;
  }

  const tagged = store.getSpansForTrace(traceId);
  const spans = [...spansById(tagged).values()].sort(
    (a, b) => a.span.startMs - b.span.startMs || cmpStr(a.span.spanId, b.span.spanId)
  );
  if (!hasGenAi(spans)) return errorOutput(`trace ${traceId} has no gen_ai.* attributes`);

  const classified = spans.map((t) => ({ t, kind: kindOf(t.span) }));
  const agent = classified.find((c) => c.kind === 'agent')?.t;
  const root = buildWaterfall(tagged)
    .filter((x) => x.depth === 0)
    .sort((a, b) => b.durationMs - a.durationMs)[0];
  const scope = agent?.span ?? spans.find((t) => t.span.spanId === root?.spanId)?.span ?? spans[0].span;
  const [lo, hi] = range(scope);

  const llm = classified.filter((c) => c.kind === 'llm').map((c) => c.t);
  const tools = classified.filter((c) => c.kind === 'tool').map((c) => c.t);
  const llmTimeMs = unionMs(llm.map((t) => range(t.span)), lo, hi);
  const toolTimeMs = unionMs(tools.map((t) => range(t.span)), lo, hi);
  const busyMs = unionMs([...llm, ...tools].map((t) => range(t.span)), lo, hi);

  const errorType = (s: Span) => {
    const t = str(s.attrs['error.type']);
    return t ? truncateString(r.text(t), 200) : undefined;
  };
  const instanceOf = new Map(spans.map((t) => [t.span.spanId, t.instanceId]));
  const isFailed = (c: { status: string; errorType?: string }) => c.status === 'ERROR' || !!c.errorType;

  const byModel = new Map<string, { model: string; calls: number; inputTokens: number; outputTokens: number }>();
  let inputTokens = 0;
  let outputTokens = 0;
  const llmCalls = llm.map(({ span }) => {
    const a = span.attrs;
    const model = str(a['gen_ai.response.model']) ?? str(a['gen_ai.request.model']) ?? '(unknown)';
    const inTok = num(first(a, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'));
    const outTok = num(first(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'));
    inputTokens += inTok ?? 0;
    outputTokens += outTok ?? 0;
    const m = byModel.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0 };
    m.calls++;
    m.inputTokens += inTok ?? 0;
    m.outputTokens += outTok ?? 0;
    byModel.set(model, m);
    return {
      spanId: span.spanId,
      name: span.name,
      provider: str(first(a, 'gen_ai.provider.name', 'gen_ai.system')),
      model,
      requestModel: str(a['gen_ai.request.model']),
      durationMs: round1(span.durationMs),
      inputTokens: inTok,
      outputTokens: outTok,
      status: span.statusCode,
      errorType: errorType(span),
      contentChars: contentChars(a),
    };
  });

  const toolCalls = tools
    .map(({ span }) => ({
      spanId: span.spanId,
      name: span.name,
      toolName: str(span.attrs['gen_ai.tool.name']),
      callId: str(span.attrs['gen_ai.tool.call.id']),
      durationMs: round1(span.durationMs),
      status: span.statusCode,
      errorType: errorType(span),
      statusMessage: span.statusMessage ? truncateString(r.text(span.statusMessage), 200) : undefined,
      contentChars: contentChars(span.attrs),
    }))
    .sort((a, b) => b.durationMs - a.durationMs || cmpStr(a.spanId, b.spanId));

  const slowestLlm = [...llmCalls].sort((a, b) => b.durationMs - a.durationMs || cmpStr(a.spanId, b.spanId))[0];
  const slowestTool = toolCalls[0];
  const failedTools = toolCalls.filter(isFailed);
  const failedLlm = llmCalls.filter(isFailed);

  const result: Record<string, unknown> = {
    traceId,
    agent: {
      name: str(agent?.span.attrs['gen_ai.agent.name']),
      spanId: scope.spanId,
      durationMs: round1(scope.durationMs),
      provider: str(first(scope.attrs, 'gen_ai.provider.name', 'gen_ai.system')),
    },
    time: {
      llmTimeMs: round1(llmTimeMs),
      toolTimeMs: round1(toolTimeMs),
      otherMs: round1(Math.max(0, scope.durationMs - busyMs)),
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      byModel: [...byModel.values()].sort((a, b) => cmpStr(a.model, b.model)),
    },
    llmCallCount: llmCalls.length,
    toolCallCount: toolCalls.length,
    llmCalls: llmCalls.slice(0, input.limit),
    toolCalls: toolCalls.slice(0, input.limit),
    slowest: {
      llm: slowestLlm && { spanId: slowestLlm.spanId, name: slowestLlm.name, durationMs: slowestLlm.durationMs },
      tool: slowestTool && { spanId: slowestTool.spanId, toolName: slowestTool.toolName, durationMs: slowestTool.durationMs },
    },
    failed: [
      ...failedTools.map((t) => ({ kind: 'tool', spanId: t.spanId, name: t.toolName ?? t.name, errorType: t.errorType, statusMessage: t.statusMessage })),
      ...failedLlm.map((c) => ({ kind: 'llm', spanId: c.spanId, name: c.model, errorType: c.errorType })),
    ],
  };

  const refs: Ref[] = [traceRef(store, traceId, refLabel(r, scope.name))];
  const seen = new Set<string>();
  const add = (c: { spanId: string; name: string } | undefined) => {
    if (!c || seen.has(c.spanId)) return;
    seen.add(c.spanId);
    refs.push(spanRef(traceId, c.spanId, instanceOf.get(c.spanId), refLabel(r, c.name)));
  };
  add(slowestTool);
  add(failedTools[0]);
  add(slowestLlm);
  return { result, refs, listKey: 'llmCalls' };
}
