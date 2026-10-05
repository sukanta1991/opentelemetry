// SPDX-License-Identifier: Apache-2.0
// @otel participant logic without vscode: the tool-calling loop, history trimming and user-facing
// messages. src/ai/participant.ts adapts it to the VS Code chat and language model APIs.

import { MAX_HISTORY_TURNS, MAX_TOOL_ROUNDS } from './limits';
import { buildUserPrompt } from './prompt';
import { Ref, cleanTitle, parseRefs } from './refs';

export const MAX_HISTORY_CHARS = 4000;

export type LoopPart = { kind: 'text'; text: string } | { kind: 'call'; callId: string; name: string; input: object };

export interface ToolOutcome {
  callId: string;
  text: string;
}

export interface LoopHost<M> {
  send(messages: M[]): Promise<AsyncIterable<LoopPart | undefined>>;
  assistant(parts: LoopPart[]): M;
  toolResults(results: ToolOutcome[]): M;
  invokeTool(name: string, input: object): Promise<string>;
  // Text for the model when invokeTool rejected, e.g. "user declined" or "error: …".
  toolErrorText(error: unknown): string;
  isCancelled(): boolean;
  markdown(text: string): void;
  progress(text: string): void;
}

export interface LoopResult {
  finalText: string;
  refs: Ref[];
  lastRefs: Ref[];
  rounds: number;
  hitRoundCap: boolean;
  cancelled: boolean;
}

function refsOf(json: string): Ref[] | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.refs) ? parseRefs(parsed.refs) : undefined;
  } catch {
    return undefined;
  }
}

// Every tool call gets exactly one result, or the model conversation breaks.
export async function runToolLoop<M>(
  host: LoopHost<M>,
  initial: readonly M[],
  allowedTools: ReadonlySet<string>,
  maxRounds = MAX_TOOL_ROUNDS
): Promise<LoopResult> {
  const messages = [...initial];
  let finalText = '';
  const refs: Ref[] = [];
  let lastRefs: Ref[] = [];
  const done = (rounds: number, extra: Partial<LoopResult>): LoopResult => ({
    finalText,
    refs,
    lastRefs,
    rounds,
    hitRoundCap: false,
    cancelled: false,
    ...extra,
  });

  for (let round = 0; round < maxRounds; round++) {
    if (host.isCancelled()) return done(round, { cancelled: true });
    const stream = await host.send(messages);
    const parts: LoopPart[] = [];
    const calls: Extract<LoopPart, { kind: 'call' }>[] = [];
    for await (const part of stream) {
      if (!part) continue;
      parts.push(part);
      if (part.kind === 'text') {
        host.markdown(part.text);
        finalText += part.text;
      } else {
        calls.push(part);
      }
    }
    if (!calls.length) return done(round + 1, {});

    messages.push(host.assistant(parts));
    const results: ToolOutcome[] = [];
    for (const call of calls) {
      if (host.isCancelled()) return done(round + 1, { cancelled: true });
      if (!allowedTools.has(call.name)) {
        results.push({ callId: call.callId, text: `error: tool ${JSON.stringify(call.name)} is not available here` });
        continue;
      }
      host.progress(`Running ${call.name}…`);
      try {
        const text = await host.invokeTool(call.name, call.input);
        results.push({ callId: call.callId, text });
        const found = refsOf(text);
        if (found?.length) {
          refs.push(...found);
          lastRefs = found;
        }
      } catch (e) {
        if (host.isCancelled()) return done(round + 1, { cancelled: true });
        results.push({ callId: call.callId, text: host.toolErrorText(e) });
      }
    }
    messages.push(host.toolResults(results));
  }
  return done(maxRounds, { hitRoundCap: true });
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  command?: string;
}

// The last MAX_HISTORY_TURNS turns, each cut to MAX_HISTORY_CHARS; user turns get their command template.
export function historyMessages(turns: readonly HistoryTurn[], max = MAX_HISTORY_TURNS): HistoryTurn[] {
  return turns
    .slice(-max)
    .map((t) => ({
      role: t.role,
      text: (t.role === 'user' ? buildUserPrompt(t.command, t.text) : t.text).slice(0, MAX_HISTORY_CHARS),
    }))
    .filter((t) => t.text.trim());
}

export function disabledMarkdown(): string {
  return [
    '**OpenTelemetry AI access is turned off.**',
    '',
    'When enabled, `@otel` and the `otel_*` tools read the telemetry held in memory by the local OTLP receiver and send a redacted, size-limited summary to the language model you selected in chat. You confirm each tool call, and you can see exactly what was sent in the **OpenTelemetry AI** output channel (Debug level).',
    '',
    'Enable the `otel.ai.enabled` user setting to continue.',
  ].join('\n');
}

export function emptyStoreMarkdown(receiverRunning: boolean): string {
  return receiverRunning
    ? 'No telemetry has been received yet. Point your app\'s OTLP exporter at the receiver (run **OpenTelemetry: Copy OTLP Endpoint**), exercise it, then ask again.'
    : 'No telemetry has been received yet, and the OTLP receiver is not running. Start it, run your app with an OTLP exporter, then ask again.';
}

export const NO_MODEL_MESSAGE = 'No language model is available. Pick a model in the chat model picker and try again.';
export const NO_TOOLS_MESSAGE =
  'The OpenTelemetry tools are not registered in this window. Reload the window after enabling `otel.ai.enabled`.';
export const ROUND_CAP_MESSAGE = `\n\n_Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls; the answer may be incomplete._`;

const LM_ERRORS: Record<string, string> = {
  NoPermissions: 'This extension is not allowed to use the selected language model. Allow access when VS Code asks, or pick another model.',
  Blocked: 'The language model provider blocked the request (for example a rate limit or content filter). Try again later or pick another model.',
  NotFound: 'The selected language model is no longer available. Pick another model.',
};

// Short, fixed text for chat; the full error goes to the output channel only.
export function chatErrorMessage(error: unknown, languageModelErrorCode?: string): string {
  if (languageModelErrorCode !== undefined) {
    return LM_ERRORS[languageModelErrorCode] ?? `The language model returned an error (${cleanTitle(languageModelErrorCode, 40)}).`;
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/\btools?\b|tool[_ ]?call|function[_ ]?call/i.test(msg)) {
    return 'The selected model may not support tool calling; pick another model.';
  }
  return 'Something went wrong while answering. Details are in the **OpenTelemetry AI** output channel.';
}
