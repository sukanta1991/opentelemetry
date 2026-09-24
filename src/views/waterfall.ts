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
  hasError: boolean;
  attrs: AttrEntry[];
  events: WaterfallEvent[];
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

export interface AttrFilter {
  key: string;
  // Lowercased; undefined means "attribute is present".
  value?: string;
}

export function parseAttrFilter(text: string): AttrFilter | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const eq = t.indexOf('=');
  if (eq === -1) return { key: t };
  const key = t.slice(0, eq).trim();
  if (!key) return undefined;
  const value = t.slice(eq + 1).trim().toLowerCase();
  return value ? { key, value } : { key };
}

export function traceMatchesAttrFilter(spans: Iterable<Span>, filter: AttrFilter): boolean {
  for (const s of spans) {
    if (!Object.prototype.hasOwnProperty.call(s.attrs, filter.key)) continue;
    if (filter.value === undefined) return true;
    const v = s.attrs[filter.key];
    const text = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (text.toLowerCase().includes(filter.value)) return true;
  }
  return false;
}

export function buildWaterfall(tagged: { span: Span; serviceName: string }[]): WaterfallRow[] {
  const byId = new Map<string, { span: Span; serviceName: string }>();
  for (const t of tagged) byId.set(t.span.spanId, t);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const t of tagged) {
    const parent = t.span.parentSpanId;
    if (parent && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(t.span.spanId);
      children.set(parent, list);
    } else {
      roots.push(t.span.spanId);
    }
  }
  const traceStart = Math.min(...tagged.map((t) => t.span.startMs));
  const rows: WaterfallRow[] = [];
  const sortByStart = (a: string, b: string) =>
    (byId.get(a)!.span.startMs - byId.get(b)!.span.startMs);

  const visit = (spanId: string, depth: number): void => {
    const entry = byId.get(spanId);
    if (!entry) return;
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
      hasError: s.statusCode === 'ERROR',
      attrs: toAttrEntries(s.attrs),
      events: [...s.events]
        .sort((a, b) => a.timeMs - b.timeMs)
        .map((e) => ({ name: e.name, offsetMs: e.timeMs - s.startMs, attrs: toAttrEntries(e.attrs) })),
    });
    const kids = (children.get(spanId) ?? []).sort(sortByStart);
    for (const k of kids) visit(k, depth + 1);
  };
  for (const r of roots.sort(sortByStart)) visit(r, 0);
  return rows;
}
