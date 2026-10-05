// SPDX-License-Identifier: Apache-2.0
// Registers the otel_* language model tools. The pipeline itself lives in toolRunner.ts.

import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readAiSettings } from '../settings';
import { TOOL_NAMES, ToolName } from './toolNames';
import { describeInvocation, runTool } from './toolRunner';

export function registerAiTools(
  context: vscode.ExtensionContext,
  controller: OtelController,
  log: vscode.LogOutputChannel
): void {
  // Forks without the API, and the activation test's vscode stand-in, have no lm namespace.
  if (typeof vscode.lm?.registerTool !== 'function') return;
  for (const name of TOOL_NAMES) {
    context.subscriptions.push(vscode.lm.registerTool(name, createTool(name, controller, log)));
  }
}

function createTool(name: ToolName, controller: OtelController, log: vscode.LogOutputChannel): vscode.LanguageModelTool<unknown> {
  return {
    prepareInvocation(options) {
      const text = describeInvocation(name, options.input, readAiSettings());
      return {
        invocationMessage: text.invocationMessage,
        confirmationMessages: { title: text.title, message: new vscode.MarkdownString(text.message) },
      };
    },
    invoke(options, token) {
      const run = runTool(name, options.input, {
        store: controller.store,
        settings: readAiSettings(),
        receiverRunning: controller.isRunning(),
        now: Date.now(),
        checkCancelled: () => {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
        },
      });
      log.info(
        `${name} ${run.inputSummary || '(no input)'} → ${run.json.length} chars, ${run.itemCount} items${run.truncated ? ' (truncated)' : ''}`
      );
      log.debug(`${name} result sent to the model: ${run.json}`);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(run.json)]);
    },
  };
}
