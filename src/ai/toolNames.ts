// SPDX-License-Identifier: Apache-2.0
// Single source of truth for tool names: package.json, registration and tests all check against it.

export const TOOL_NAMES = [
  'otel_listServices',
  'otel_searchTraces',
  'otel_findSpans',
  'otel_getTrace',
  'otel_compareTraces',
  'otel_queryLogs',
  'otel_queryMetrics',
  'otel_getServiceMap',
  'otel_genAiSummary',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
