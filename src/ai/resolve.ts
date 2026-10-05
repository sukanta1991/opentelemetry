// SPDX-License-Identifier: Apache-2.0
// Trace/span id resolution for AI tools. Synchronous so the store can't change mid-lookup.

import { normalizeSpanId } from '../store/ids';
import { TelemetryStore, TracePart } from '../store/store';
import { parseTraceIdInput } from '../views/navigationTargets';

const MAX_CANDIDATES = 5;
const TRACE_PREFIX = /^[0-9a-f]{8,31}$/;
const SPAN_PREFIX = /^[0-9a-f]{8,15}$/;

function cleanHex(raw: string): string {
  const s = raw.trim().toLowerCase();
  return s.startsWith('0x') ? s.slice(2) : s;
}

function quote(raw: string): string {
  return JSON.stringify(raw.length > 64 ? raw.slice(0, 64) + '…' : raw);
}

function ambiguous(what: string, raw: string, matches: string[]): { error: string } {
  const shown = matches.slice(0, MAX_CANDIDATES).join(', ');
  const more = matches.length > MAX_CANDIDATES ? ` and ${matches.length - MAX_CANDIDATES} more` : '';
  return { error: `${what} prefix ${quote(raw)} is ambiguous; candidates: ${shown}${more}. Use a longer prefix or the full id.` };
}

export function resolveTraceId(store: TelemetryStore, raw: unknown): { traceId: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'traceId must be a non-empty string' };
  const full = parseTraceIdInput(raw)?.traceId;
  if (full) {
    if (store.findTraceInstances(full).length) return { traceId: full };
    return { error: `trace ${full} not found; it may have been evicted from the in-memory buffer` };
  }
  const prefix = cleanHex(raw);
  if (!TRACE_PREFIX.test(prefix)) {
    return { error: `traceId ${quote(raw)} is not a 32-hex trace id, a W3C traceparent or an 8–31 hex prefix` };
  }
  const matches = new Set<string>();
  for (const inst of store.getAllInstances()) {
    for (const id of inst.traces.keys()) if (id.startsWith(prefix)) matches.add(id);
  }
  if (matches.size === 1) return { traceId: [...matches][0] };
  if (!matches.size) return { error: `no trace matches prefix ${prefix}; it may have been evicted from the in-memory buffer` };
  return ambiguous('trace', raw, [...matches].sort());
}

export function resolveSpanId(parts: readonly TracePart[], raw: unknown): { spanId: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'spanId must be a non-empty string' };
  const full = normalizeSpanId(raw);
  if (full) {
    if (parts.some((p) => p.trace.spans.has(full))) return { spanId: full };
    return { error: `span ${full} not found in this trace` };
  }
  const prefix = cleanHex(raw);
  if (!SPAN_PREFIX.test(prefix)) {
    return { error: `spanId ${quote(raw)} is not a 16-hex span id or an 8–15 hex prefix` };
  }
  const matches = new Set<string>();
  for (const p of parts) {
    for (const id of p.trace.spans.keys()) if (id.startsWith(prefix)) matches.add(id);
  }
  if (matches.size === 1) return { spanId: [...matches][0] };
  if (!matches.size) return { error: `no span in this trace matches prefix ${prefix}` };
  return ambiguous('span', raw, [...matches].sort());
}

// Unique trace ids across instances, newest first by earliest start; ties broken by id.
export function allTraceIds(store: TelemetryStore, limit = Infinity): string[] {
  const start = new Map<string, number>();
  for (const inst of store.getAllInstances()) {
    for (const [id, trace] of inst.traces) {
      const prev = start.get(id);
      if (prev === undefined || trace.startMs < prev) start.set(id, trace.startMs);
    }
  }
  return [...start.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

export function latestTraceId(
  store: TelemetryStore,
  predicate?: (traceId: string, parts: TracePart[]) => boolean,
  limit = Infinity
): string | undefined {
  for (const id of allTraceIds(store, limit)) {
    if (!predicate || predicate(id, store.getTraceParts(id))) return id;
  }
  return undefined;
}
