// Cross-instance trace summaries for the trace list, cached until any part of the trace changes.

import { AttributeValue, Span } from '../store/model';
import { TracePart } from '../store/store';
import { ROOT_ATTR_KEY_LIMIT } from './webview/traceColumns';
import { TraceRow } from './webview/traceView';

const ROOT_ATTR_MAX = 200;

export interface TraceSummary {
  row: TraceRow;
  root?: Span;
}

// lastUpdated has millisecond resolution, so span count guards same-millisecond updates.
export function traceSignature(parts: readonly TracePart[]): string {
  return parts.map((p) => `${p.instanceId}:${p.trace.lastUpdated}:${p.trace.spans.size}`).join('|');
}

export function summarizeTrace(traceId: string, parts: readonly TracePart[]): TraceSummary {
  const ids = new Set<string>();
  for (const p of parts) for (const id of p.trace.spans.keys()) ids.add(id);

  let startMs = Infinity;
  let endMs = -Infinity;
  let errorCount = 0;
  let spanCount = 0;
  const seen = new Set<string>();
  const services = new Set<string>();
  // Candidates by preference: parentless, then parent-missing, then any.
  const best: ({ span: Span; service: string } | undefined)[] = [undefined, undefined, undefined];

  for (const p of parts) {
    services.add(p.serviceName);
    startMs = Math.min(startMs, p.trace.startMs);
    endMs = Math.max(endMs, p.trace.endMs);
    for (const span of p.trace.spans.values()) {
      if (seen.has(span.spanId)) continue;
      seen.add(span.spanId);
      spanCount++;
      if (span.statusCode === 'ERROR') errorCount++;
      const rank = !span.parentSpanId ? 0 : !ids.has(span.parentSpanId) ? 1 : 2;
      for (let r = rank; r < 3; r++) {
        const cur = best[r];
        if (!cur || span.startMs < cur.span.startMs) best[r] = { span, service: p.serviceName };
      }
    }
  }

  const root = best[0] ?? best[1] ?? best[2];
  if (!Number.isFinite(startMs)) startMs = 0;
  return {
    root: root?.span,
    row: {
      traceId,
      rootName: root?.span.name || '(unknown)',
      rootService: root?.service ?? '',
      startMs,
      durationMs: Math.max(0, endMs - startMs),
      spanCount,
      errorCount,
      services: [...services].sort(),
    },
  };
}

export function rootAttrValue(span: Span | undefined, key: string): string | undefined {
  if (!span || !Object.prototype.hasOwnProperty.call(span.attrs, key)) return undefined;
  const v: AttributeValue = span.attrs[key];
  const text = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
  return text.length > ROOT_ATTR_MAX ? `${text.slice(0, ROOT_ATTR_MAX)}…` : text;
}

export function collectRootAttrKeys(summaries: Iterable<TraceSummary>, limit = ROOT_ATTR_KEY_LIMIT): string[] {
  const keys = new Set<string>();
  outer: for (const s of summaries) {
    if (!s.root) continue;
    for (const k of Object.keys(s.root.attrs)) {
      keys.add(k);
      if (keys.size >= limit) break outer;
    }
  }
  return [...keys].sort();
}

export class TraceSummaryCache {
  private entries = new Map<string, { sig: string; summary: TraceSummary }>();

  get(traceId: string, parts: readonly TracePart[]): TraceSummary {
    const sig = traceSignature(parts);
    const hit = this.entries.get(traceId);
    if (hit && hit.sig === sig) return hit.summary;
    const summary = summarizeTrace(traceId, parts);
    this.entries.set(traceId, { sig, summary });
    return summary;
  }

  prune(live: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}
