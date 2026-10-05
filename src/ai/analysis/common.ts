// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the analysis functions. No vscode import.

import { CodeLocation, KeyValueMap } from '../../store/model';
import { Instance, TaggedSpan, TelemetryStore, TracePart } from '../../store/store';
import { pickTraceInstance } from '../../views/navigationTargets';
import { WaterfallRow } from '../../views/waterfall';
import { Redactor } from '../redact';
import { Ref } from '../refs';
import { safeValue, setOwn, truncateString } from '../serialize';

export interface AnalysisContext {
  now: number;
  redactor: Redactor;
  maxItems: number;
  receiverRunning?: boolean;
}

export interface AnalysisOutput {
  result: Record<string, unknown>;
  refs: Ref[];
  // The result list that fitResult may shorten.
  listKey?: string;
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
export const pct = (part: number, whole: number): number | null => (whole > 0 ? round1((part / whole) * 100) : null);

export function errorOutput(error: string): AnalysisOutput {
  return { result: { error }, refs: [] };
}

const MAX_KNOWN = 20;

// Instances matching an optional exact instance id and case-insensitive service name.
export function selectInstances(
  store: TelemetryStore,
  service: string | undefined,
  instanceId: string | undefined
): { instances: Instance[] } | { error: string } {
  const all = store.getAllInstances();
  if (instanceId && !all.some((i) => i.id === instanceId)) {
    const known = all.map((i) => i.id).sort().slice(0, MAX_KNOWN);
    return { error: `instance ${JSON.stringify(instanceId)} not found; known instances: ${known.join(', ') || '(none)'}` };
  }
  const svc = service?.toLowerCase();
  const instances = all.filter((i) => (!instanceId || i.id === instanceId) && (!svc || i.serviceName.toLowerCase() === svc));
  if (service && !instances.length) {
    const known = [...new Set(all.map((i) => i.serviceName))].sort().slice(0, MAX_KNOWN);
    return { error: `no instance of service ${JSON.stringify(service)}; known services: ${known.join(', ') || '(none)'}` };
  }
  return { instances };
}

export function* taggedSpans(parts: readonly TracePart[]): Iterable<TaggedSpan> {
  for (const p of parts) {
    for (const span of p.trace.spans.values()) {
      yield { span, serviceName: p.serviceName, instanceId: p.instanceId };
    }
  }
}

// Keeps the same copy buildWaterfall keeps when a span was exported more than once.
export function spansById(tagged: readonly TaggedSpan[]): Map<string, TaggedSpan> {
  const byId = new Map<string, TaggedSpan>();
  for (const t of tagged) {
    const prev = byId.get(t.span.spanId);
    if (!prev || t.span.endMs >= prev.span.endMs) byId.set(t.span.spanId, t);
  }
  return byId;
}

// Waterfall children by parent span id; orphan and cycle roots (depth 0) have no parent here.
export function childrenOf(rows: readonly WaterfallRow[]): Map<string, WaterfallRow[]> {
  const out = new Map<string, WaterfallRow[]>();
  for (const r of rows) {
    if (r.depth === 0 || !r.parentSpanId) continue;
    const list = out.get(r.parentSpanId) ?? [];
    list.push(r);
    out.set(r.parentSpanId, list);
  }
  return out;
}

export const rowEnd = (r: WaterfallRow): number => r.startMs + r.durationMs;

// Duration minus the merged length of child ranges clipped to the parent. Never negative.
export function selfTimes(rows: readonly WaterfallRow[], children = childrenOf(rows)): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const start = r.startMs;
    const end = rowEnd(r);
    const ranges: [number, number][] = [];
    for (const c of children.get(r.spanId) ?? []) {
      const s = Math.max(start, c.startMs);
      const e = Math.min(end, rowEnd(c));
      if (e > s) ranges.push([s, e]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curS = -Infinity;
    let curE = -Infinity;
    for (const [s, e] of ranges) {
      if (s > curE) {
        if (curE > curS) covered += curE - curS;
        curS = s;
        curE = e;
      } else if (e > curE) {
        curE = e;
      }
    }
    if (curE > curS) covered += curE - curS;
    out.set(r.spanId, Math.max(0, r.durationMs - covered));
  }
  return out;
}

const USEFUL_PREFIXES = ['http.', 'url.', 'db.', 'rpc.', 'messaging.', 'gen_ai.'];
const USEFUL_KEYS = new Set(['error.type', 'exception.type', 'server.address', 'peer.service']);
const GENAI_CONTENT = /^gen_ai\.(prompt|completion|input\.messages|output\.messages|system_instructions)/;

// Prompt/completion content is never sent to the model, whichever tool reads the span.
export function isGenAiContentKey(key: string): boolean {
  return GENAI_CONTENT.test(key);
}

export function usefulAttrs(attrs: KeyValueMap, redactor: Redactor, max = 10): Record<string, unknown> {
  const picked: KeyValueMap = {};
  const keys = Object.keys(attrs)
    .filter((k) => (USEFUL_KEYS.has(k) || USEFUL_PREFIXES.some((p) => k.startsWith(p))) && !isGenAiContentKey(k))
    .sort()
    .slice(0, max);
  for (const k of keys) setOwn(picked, k, attrs[k]);
  return safeValue(redactor.attrs(picked)) as Record<string, unknown>;
}

export function codeOf(c: CodeLocation | undefined): CodeLocation | undefined {
  if (!c) return undefined;
  return { filepath: c.filepath, line: c.line, column: c.column, function: c.function };
}

export function refLabel(redactor: Redactor, text: string): string {
  return truncateString(redactor.text(text), 60);
}

export function traceRef(store: TelemetryStore, traceId: string, label: string): Ref {
  return { kind: 'trace', traceId, instanceId: pickTraceInstance(store, traceId), label };
}

export function spanRef(traceId: string, spanId: string, instanceId: string | undefined, label: string): Ref {
  return { kind: 'span', traceId, spanId, instanceId, label };
}

export function sourceRef(code: CodeLocation, label: string, traceId?: string, spanId?: string): Ref {
  return { kind: 'source', traceId, spanId, code, label };
}
