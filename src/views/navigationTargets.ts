// SPDX-License-Identifier: Apache-2.0
// Pure target resolution for cross-panel navigation. No vscode import so it can be unit-tested.

import { normalizeSpanId, normalizeTraceId } from '../store/ids';
import { CodeLocation } from '../store/model';
import { LIVE_REALM, TelemetryStore } from '../store/store';

export interface TraceTarget {
  traceId: string;
  spanId?: string;
}

function target(traceId: string | undefined, spanId: unknown): TraceTarget | undefined {
  if (!traceId) return undefined;
  const span = normalizeSpanId(spanId);
  return span ? { traceId, spanId: span } : { traceId };
}

export function parseTraceTarget(raw: unknown): TraceTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return target(normalizeTraceId(r.traceId), r.spanId);
}

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

// Accepts a bare trace id or a W3C traceparent (optionally prefixed "traceparent:").
export function parseTraceIdInput(text: string): TraceTarget | undefined {
  const t = text.trim().replace(/^traceparent\s*:\s*/i, '');
  const tp = TRACEPARENT.exec(t);
  if (tp) return target(normalizeTraceId(tp[1]), tp[2]);
  return target(normalizeTraceId(t), undefined);
}

const MAX_SOURCE_PATH = 4096;
const MAX_SOURCE_FUNCTION = 256;

// Argument of otel._openSource. Invalid line/column/function are dropped; an invalid path rejects it.
export function parseSourceTarget(raw: unknown): CodeLocation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.filepath !== 'string' || !r.filepath.trim() || r.filepath.length > MAX_SOURCE_PATH) return undefined;
  const pos = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
  const fn = typeof r.function === 'string' && r.function.length <= MAX_SOURCE_FUNCTION ? r.function : undefined;
  return { filepath: r.filepath, line: pos(r.line), column: pos(r.column), function: fn };
}

// Stays in the caller's realm (live if none) when it has the trace, then the caller's instance,
// then the one holding the earliest root span, then the first.
export function pickTraceInstance(
  store: TelemetryStore,
  traceId: string,
  preferInstanceId?: string
): string | undefined {
  const realm = (preferInstanceId && store.getInstance(preferInstanceId)?.realm) || LIVE_REALM;
  let ids = store.findTraceInstances(traceId, realm);
  if (!ids.length) ids = store.findTraceInstances(traceId);
  if (!ids.length) return undefined;
  if (preferInstanceId && ids.includes(preferInstanceId)) return preferInstanceId;
  let best: string | undefined;
  let bestStart = Infinity;
  for (const id of ids) {
    const trace = store.getInstance(id)?.traces.get(traceId);
    const root = trace?.rootSpanId ? trace.spans.get(trace.rootSpanId) : undefined;
    if (root && root.startMs < bestStart) {
      best = id;
      bestStart = root.startMs;
    }
  }
  return best ?? ids[0];
}
