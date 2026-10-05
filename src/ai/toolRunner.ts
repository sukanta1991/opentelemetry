// SPDX-License-Identifier: Apache-2.0
// Tool pipeline without vscode: validate input, run the analysis, redact, size-limit. Also builds
// the confirmation text. src/ai/tools.ts adapts this to the VS Code language model tool API.

import { TelemetryStore } from '../store/store';
import { AiSettings } from './aiSettings';
import { AnalysisContext, AnalysisOutput } from './analysis/common';
import { compareTraces } from './analysis/compare';
import { genAiSummary } from './analysis/genai';
import { queryLogs } from './analysis/logs';
import { queryMetrics } from './analysis/metrics';
import { listServices } from './analysis/services';
import { getServiceMap } from './analysis/serviceMap';
import { findSpans } from './analysis/spans';
import { getTraceDetail } from './analysis/trace';
import { searchTraces } from './analysis/traces';
import { MAX_RESULT_CHARS } from './limits';
import { createRedactor } from './redact';
import { cleanTitle } from './refs';
import { fitResult } from './serialize';
import * as inputs from './toolInputs';
import { TOOL_NAMES, ToolName } from './toolNames';

export const DISABLED_MESSAGE =
  "OpenTelemetry AI access is disabled. Ask the user to enable the 'otel.ai.enabled' setting.";

const MAX_SHOWN_INPUT = 200;
const MAX_ERROR_MESSAGE = 300;

interface ToolSpec {
  title: string;
  verb: string;
  parse(raw: unknown, maxItems: number): inputs.Parsed<any>;
  run(store: TelemetryStore, input: any, ctx: AnalysisContext): AnalysisOutput;
}

const SPECS: Record<ToolName, ToolSpec> = {
  otel_listServices: {
    title: 'List OpenTelemetry Services',
    verb: 'Listing OpenTelemetry services',
    parse: (raw) => inputs.parseListServicesInput(raw),
    run: listServices,
  },
  otel_searchTraces: {
    title: 'Search OpenTelemetry Traces',
    verb: 'Searching traces',
    parse: inputs.parseSearchTracesInput,
    run: searchTraces,
  },
  otel_findSpans: {
    title: 'Find OpenTelemetry Spans',
    verb: 'Finding spans',
    parse: inputs.parseFindSpansInput,
    run: findSpans,
  },
  otel_getTrace: {
    title: 'Explain OpenTelemetry Trace',
    verb: 'Explaining trace',
    parse: (raw) => inputs.parseGetTraceInput(raw),
    run: getTraceDetail,
  },
  otel_compareTraces: {
    title: 'Compare OpenTelemetry Traces',
    verb: 'Comparing traces',
    parse: (raw) => inputs.parseCompareTracesInput(raw),
    run: compareTraces,
  },
  otel_queryLogs: {
    title: 'Query OpenTelemetry Logs',
    verb: 'Querying logs',
    parse: inputs.parseQueryLogsInput,
    run: queryLogs,
  },
  otel_queryMetrics: {
    title: 'Query OpenTelemetry Metrics',
    verb: 'Querying metrics',
    parse: inputs.parseQueryMetricsInput,
    run: queryMetrics,
  },
  otel_getServiceMap: {
    title: 'Get OpenTelemetry Service Map',
    verb: 'Reading the service map',
    parse: inputs.parseGetServiceMapInput,
    run: getServiceMap,
  },
  otel_genAiSummary: {
    title: 'Summarize AI Agent Run',
    verb: 'Summarizing AI agent run',
    parse: inputs.parseGenAiSummaryInput,
    run: genAiSummary,
  },
};

export function isToolName(v: unknown): v is ToolName {
  return (TOOL_NAMES as readonly unknown[]).includes(v);
}

export function toolTitle(name: ToolName): string {
  return SPECS[name].title;
}

export function parseToolInput(name: ToolName, raw: unknown, maxItems: number): inputs.Parsed<unknown> {
  return SPECS[name].parse(raw, maxItems);
}

// Thrown for input the model can correct; the message is safe to show.
export class ToolInputError extends Error {}

export interface ToolDeps {
  store: TelemetryStore;
  settings: AiSettings;
  receiverRunning: boolean;
  now: number;
  // Called after validation and before any store access; may throw to cancel.
  checkCancelled?: () => void;
}

export interface ToolRun {
  json: string;
  inputSummary: string;
  itemCount: number;
  truncated: boolean;
}

// "key=value, key=value" of the fields actually set, one line, cut to 200 characters.
export function summarizeInput(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return cleanTitle(parts.join(', '), MAX_SHOWN_INPUT);
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, (c) => `\\${c}`);
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return cleanTitle(msg, MAX_ERROR_MESSAGE);
}

export function runTool(name: ToolName, raw: unknown, deps: ToolDeps): ToolRun {
  if (!deps.settings.enabled) throw new Error(DISABLED_MESSAGE);
  const spec = SPECS[name];
  const parsed = spec.parse(raw, deps.settings.maxResultItems);
  if ('error' in parsed) throw new ToolInputError(`Invalid input for ${name}: ${parsed.error}`);
  deps.checkCancelled?.();

  try {
    const redactor = createRedactor(deps.settings.redactAttributeKeys);
    const ctx: AnalysisContext = {
      now: deps.now,
      redactor,
      maxItems: deps.settings.maxResultItems,
      receiverRunning: deps.receiverRunning,
    };
    const out = spec.run(deps.store, parsed.value, ctx);
    // Redact the whole result before fitResult, so truncation can't split a secret.
    const payload = { ...redactor.value(out.result), refs: out.refs };
    const json = fitResult(payload, out.listKey ?? '', MAX_RESULT_CHARS);
    const fitted = JSON.parse(json) as Record<string, unknown>;
    const list = out.listKey ? fitted[out.listKey] : undefined;
    return {
      json,
      inputSummary: summarizeInput(parsed.value),
      itemCount: Array.isArray(list) ? list.length : 0,
      truncated: fitted.truncated === true,
    };
  } catch (e) {
    throw new Error(`otel tool failed: ${errorMessage(e)}`);
  }
}

export interface InvocationText {
  invocationMessage: string;
  title: string;
  // Markdown; every user- or model-controlled part is escaped.
  message: string;
}

export function describeInvocation(name: ToolName, raw: unknown, settings: AiSettings): InvocationText {
  const spec = SPECS[name];
  const parsed = spec.parse(raw, settings.maxResultItems);
  const summary = 'error' in parsed ? summarizeInput(raw) : summarizeInput(parsed.value);
  const limit = 'error' in parsed ? undefined : (parsed.value as { limit?: number }).limit;
  const lines = [
    `**${spec.title}** (\`${name}\`) reads telemetry collected by the local OpenTelemetry receiver and sends the result to the language model selected in chat.`,
    '',
    `- Input: ${summary ? escapeMarkdown(summary) : 'none'}`,
    `- Size: ${limit ? `up to ${limit} items, ` : ''}at most ${MAX_RESULT_CHARS.toLocaleString('en-US')} characters`,
    `- Secrets are redacted before sending${
      settings.redactAttributeKeys.length ? `, including ${settings.redactAttributeKeys.length} extra key(s) from \`otel.ai.redactAttributeKeys\`` : ''
    }`,
  ];
  return {
    invocationMessage: summary ? cleanTitle(`${spec.verb}: ${summary}`, MAX_SHOWN_INPUT) : spec.verb,
    title: 'Send OpenTelemetry data to the model?',
    message: lines.join('\n'),
  };
}
