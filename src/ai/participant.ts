// SPDX-License-Identifier: Apache-2.0
// Registers the @otel chat participant. The loop, history handling and messages live in chatLoop.ts.

import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readAiSettings } from '../settings';
import {
  HistoryTurn,
  LoopHost,
  LoopPart,
  NO_MODEL_MESSAGE,
  NO_TOOLS_MESSAGE,
  ROUND_CAP_MESSAGE,
  chatErrorMessage,
  disabledMarkdown,
  emptyStoreMarkdown,
  historyMessages,
  runToolLoop,
} from './chatLoop';
import { INSTRUCTIONS, buildUserPrompt } from './prompt';
import { selectButtons } from './refs';
import { TOOL_NAMES } from './toolNames';

const PARTICIPANT_ID = 'otel.chat';
const MAX_TOOL_ERROR = 300;

export function registerOtelParticipant(
  context: vscode.ExtensionContext,
  controller: OtelController,
  log: vscode.LogOutputChannel
): void {
  // Forks without the API, and the activation test's vscode stand-in, have no chat namespace.
  if (typeof vscode.chat?.createChatParticipant !== 'function') return;
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, chatContext, stream, token) =>
    handle(request, chatContext, stream, token, controller, log)
  );
  participant.iconPath = vscode.Uri.joinPath(controller.extensionUri, 'media', 'otel.svg');
  context.subscriptions.push(participant);
}

function historyOf(chatContext: vscode.ChatContext): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      turns.push({ role: 'user', text: turn.prompt, command: turn.command });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
        .map((p) => p.value.value)
        .join('');
      turns.push({ role: 'assistant', text });
    }
  }
  return historyMessages(turns);
}

async function pickModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat | undefined> {
  if (request.model) return request.model;
  const [first] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return first;
}

async function handle(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  controller: OtelController,
  log: vscode.LogOutputChannel
): Promise<vscode.ChatResult> {
  const result: vscode.ChatResult = { metadata: { command: request.command } };
  try {
    if (!readAiSettings().enabled) {
      stream.markdown(disabledMarkdown());
      stream.button({ command: 'workbench.action.openSettings', title: 'Open Setting', arguments: ['otel.ai.enabled'] });
      return result;
    }
    if (!controller.store.getAllInstances().length) {
      const running = controller.isRunning();
      stream.markdown(emptyStoreMarkdown(running));
      if (!running) stream.button({ command: 'otel.start', title: 'Start Receiver' });
      return result;
    }

    const allowed = new Set<string>(TOOL_NAMES);
    const tools: vscode.LanguageModelChatTool[] = vscode.lm.tools
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    if (!tools.length) {
      stream.markdown(NO_TOOLS_MESSAGE);
      return result;
    }
    const model = await pickModel(request);
    if (!model) {
      stream.markdown(NO_MODEL_MESSAGE);
      return result;
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(INSTRUCTIONS),
      ...historyOf(chatContext).map((t) =>
        t.role === 'user' ? vscode.LanguageModelChatMessage.User(t.text) : vscode.LanguageModelChatMessage.Assistant(t.text)
      ),
      vscode.LanguageModelChatMessage.User(buildUserPrompt(request.command, request.prompt)),
    ];

    const host: LoopHost<vscode.LanguageModelChatMessage> = {
      async send(msgs) {
        const response = await model.sendRequest(msgs, { tools }, token);
        return mapStream(response.stream);
      },
      assistant: (parts) =>
        vscode.LanguageModelChatMessage.Assistant(
          parts.map((p) =>
            p.kind === 'text' ? new vscode.LanguageModelTextPart(p.text) : new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input)
          )
        ),
      toolResults: (results) =>
        vscode.LanguageModelChatMessage.User(
          results.map((r) => new vscode.LanguageModelToolResultPart(r.callId, [new vscode.LanguageModelTextPart(r.text)]))
        ),
      async invokeTool(name, input) {
        const out = await vscode.lm.invokeTool(name, { input, toolInvocationToken: request.toolInvocationToken }, token);
        return out.content
          .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
          .map((p) => p.value)
          .join('');
      },
      toolErrorText(e) {
        if (e instanceof vscode.CancellationError) return 'user declined';
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg.replace(/\s+/g, ' ').slice(0, MAX_TOOL_ERROR)}`;
      },
      isCancelled: () => token.isCancellationRequested,
      markdown: (text) => stream.markdown(text),
      progress: (text) => stream.progress(text),
    };

    const loop = await runToolLoop(host, messages, allowed);
    if (loop.cancelled) return result;
    if (loop.hitRoundCap) stream.markdown(ROUND_CAP_MESSAGE);
    for (const b of selectButtons(loop.refs, loop.finalText, loop.lastRefs)) stream.button(b);
    log.info(`@otel ${request.command ? `/${request.command} ` : ''}answered in ${loop.rounds} round(s), ${loop.refs.length} refs`);
    return result;
  } catch (e) {
    if (token.isCancellationRequested || e instanceof vscode.CancellationError) return result;
    const code = e instanceof vscode.LanguageModelError ? e.code : undefined;
    log.error(`@otel request failed${code ? ` (${code})` : ''}: ${e instanceof Error ? e.message : String(e)}`);
    stream.markdown(chatErrorMessage(e, code));
    return result;
  }
}

async function* mapStream(parts: AsyncIterable<unknown>): AsyncIterable<LoopPart | undefined> {
  for await (const p of parts) {
    if (p instanceof vscode.LanguageModelTextPart) yield { kind: 'text', text: p.value };
    else if (p instanceof vscode.LanguageModelToolCallPart) yield { kind: 'call', callId: p.callId, name: p.name, input: p.input };
    else yield undefined;
  }
}
