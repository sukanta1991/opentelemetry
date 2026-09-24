import { KeyValueMap, Span, SpanKind, StatusCode } from '../store/model';

export interface AttrEntry {
  key: string;
  value: string;
  // True for arrays/objects, whose value is pretty-printed JSON.
  structured: boolean;
}

export interface WaterfallEvent {
  name: string;
  offsetMs: number;
  attrs: AttrEntry[];
}

export interface WaterfallLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attrs: AttrEntry[];
  // Whether the linked trace is in collected data, so the UI can offer to open it.
  available: boolean;
}

export interface WaterfallRow {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  depth: number;
  startMs: number;
  offsetMs: number;
  durationMs: number;
  kind: SpanKind;
  status: StatusCode;
  statusMessage?: string;
  scope?: string;
  service: string;
  instanceId: string;
  hasError: boolean;
  // Has a parent id but is shown as a root: the parent is missing or part of a cycle.
  orphan: boolean;
  attrs: AttrEntry[];
  events: WaterfallEvent[];
  links: WaterfallLink[];
  code?: { filepath: string; line?: number; function?: string };
  logCount: number;
}

export function toAttrEntries(attrs: KeyValueMap): AttrEntry[] {
  return Object.keys(attrs)
    .sort()
    .map((key) => {
      const v = attrs[key];
      if (v !== null && typeof v === 'object') {
        return { key, value: JSON.stringify(v, null, 2), structured: true };
      }
      return { key, value: String(v), structured: false };
    });
}

export interface WaterfallInput {
  span: Span;
  serviceName: string;
  instanceId?: string;
}

// --- Wire payload (shared with the webview) ---------------------------------------------

export interface WfLog {
  seq: number;
  instanceId: string;
  spanId?: string;
  offsetMs: number;
  severityNumber: number;
  severityText: string;
  message: string;
  skew?: 'before' | 'after';
}

export interface WfResource {
  serviceName: string;
  attrs: AttrEntry[];
}

export interface WaterfallPayload {
  traceId: string;
  rows: WaterfallRow[];
  totalMs: number;
  resources: Record<string, WfResource>;
  logsBySpan: Record<string, WfLog[]>;
  traceLogs: WfLog[];
  truncated: boolean;
}

export interface WaterfallOptions {
  linkAvailable?: (traceId: string) => boolean;
}

export function buildWaterfall(tagged: readonly WaterfallInput[], opts: WaterfallOptions = {}): WaterfallRow[] {
  // Re-exported spans collapse to the most complete copy.
  const byId = new Map<string, WaterfallInput>();
  for (const t of tagged) {
    const prev = byId.get(t.span.spanId);
    if (!prev || t.span.endMs >= prev.span.endMs) byId.set(t.span.spanId, t);
  }
  if (!byId.size) return [];

  let traceStart = Infinity;
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [id, t] of byId) {
    traceStart = Math.min(traceStart, t.span.startMs);
    const parent = t.span.parentSpanId;
    if (parent && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    } else {
      roots.push(id);
    }
  }
  const byStart = (a: string, b: string) => byId.get(a)!.span.startMs - byId.get(b)!.span.startMs;
  const linkAvailable = opts.linkAvailable ?? (() => false);

  const rows: WaterfallRow[] = [];
  const visited = new Set<string>();

  // Iterative DFS so a very deep trace cannot overflow the call stack.
  const walk = (rootId: string): void => {
    const stack: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
    while (stack.length) {
      const { id, depth } = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const entry = byId.get(id)!;
      const s = entry.span;
      rows.push({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        depth,
        startMs: s.startMs,
        offsetMs: Math.max(0, s.startMs - traceStart),
        durationMs: s.durationMs,
        kind: s.kind,
        status: s.statusCode,
        statusMessage: s.statusMessage,
        scope: s.scope,
        service: entry.serviceName,
        instanceId: entry.instanceId ?? '',
        hasError: s.statusCode === 'ERROR',
        orphan: depth === 0 && !!s.parentSpanId,
        attrs: toAttrEntries(s.attrs),
        events: [...s.events]
          .sort((a, b) => a.timeMs - b.timeMs)
          .map((e) => ({ name: e.name, offsetMs: e.timeMs - s.startMs, attrs: toAttrEntries(e.attrs) })),
        links: (s.links ?? []).map((l) => ({
          traceId: l.traceId,
          spanId: l.spanId,
          traceState: l.traceState,
          attrs: toAttrEntries(l.attrs),
          available: linkAvailable(l.traceId),
        })),
        code: s.codeLocation
          ? { filepath: s.codeLocation.filepath, line: s.codeLocation.line, function: s.codeLocation.function }
          : undefined,
        logCount: 0,
      });
      const kids = (children.get(id) ?? []).slice().sort(byStart);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: depth + 1 });
    }
  };

  for (const r of roots.sort(byStart)) walk(r);
  // Spans only reachable through a parent cycle (including self-parents).
  const rest = [...byId.keys()].filter((id) => !visited.has(id)).sort(byStart);
  for (const id of rest) walk(id);
  return rows;
}
