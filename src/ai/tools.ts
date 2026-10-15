// SPDX-License-Identifier: Apache-2.0
// Registers the otel_* language model tools. The pipeline itself lives in toolRunner.ts.

import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readAiSettings, readBaselineSettings } from '../settings';
import { BaselineRegistry } from '../views/baselineRegistry';
import type { Snapshot } from '../views/baseline';
import { BaselineLookup, matchBaseline } from './analysis/baseline';
import { TOOL_NAMES, ToolName } from './toolNames';
import { describeInvocation, runTool } from './toolRunner';

export function registerAiTools(
  context: vscode.ExtensionContext,
  controller: OtelController,
  log: vscode.LogOutputChannel,
  baselines?: BaselineRegistry
): void {
  // Forks without the API, and the activation test's vscode stand-in, have no lm namespace.
  if (typeof vscode.lm?.registerTool !== 'function') return;
  for (const name of TOOL_NAMES) {
    context.subscriptions.push(vscode.lm.registerTool(name, createTool(name, controller, log, baselines)));
  }
}

// Loads only the active baseline and any the input names, since tool runs themselves are synchronous.
async function baselineLookup(registry: BaselineRegistry, input: unknown): Promise<BaselineLookup> {
  const active = registry.activeId;
  const list = registry.list().map((m) => ({
    id: m.id,
    name: m.name,
    createdMs: m.createdMs,
    sourceKind: m.sourceKind,
    sourceLabel: m.sourceLabel,
    saved: m.saved,
    active: m.id === active,
  }));
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const wanted = new Set<string>(active ? [active] : []);
  for (const key of ['baseline', 'against']) {
    const v = r[key];
    const hit = typeof v === 'string' ? matchBaseline(list, v.trim()) : undefined;
    if (hit) wanted.add(hit.id);
  }
  const bodies = new Map<string, Snapshot>();
  for (const id of wanted) {
    const b = await registry.load(id);
    if (b) bodies.set(id, b.snapshot);
  }
  return { list, bodies, settings: readBaselineSettings() };
}

function createTool(
  name: ToolName,
  controller: OtelController,
  log: vscode.LogOutputChannel,
  registry: BaselineRegistry | undefined
): vscode.LanguageModelTool<unknown> {
  return {
    prepareInvocation(options) {
      const text = describeInvocation(name, options.input, readAiSettings());
      return {
        invocationMessage: text.invocationMessage,
        confirmationMessages: { title: text.title, message: new vscode.MarkdownString(text.message) },
      };
    },
    async invoke(options, token) {
      const baselines = name === 'otel_compareBaseline' && registry ? await baselineLookup(registry, options.input) : undefined;
      const run = runTool(name, options.input, {
        store: controller.store,
        settings: readAiSettings(),
        receiverRunning: controller.isRunning(),
        now: Date.now(),
        baselines,
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
