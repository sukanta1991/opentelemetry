// Pure target resolution for cross-panel navigation. No vscode import so it can be unit-tested.

import { normalizeSpanId, normalizeTraceId } from '../store/ids';
import { TelemetryStore } from '../store/store';

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

// Prefers the caller's instance, then the one holding the earliest root span, then the first.
export function pickTraceInstance(
  store: TelemetryStore,
  traceId: string,
  preferInstanceId?: string
): string | undefined {
  const ids = store.findTraceInstances(traceId);
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
