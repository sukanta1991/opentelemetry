// Trace list query engine: the toolbar controls and the query bar compile to one TraceQuery.
// Span-level predicates must all hold on the same span. User input never becomes a regex.

import { AttributeValue, SpanKind, StatusCode } from '../store/model';
import { TaggedSpan } from '../store/store';
import { MAX_QUERY_LENGTH, TraceQueryInput, TraceRow } from './webview/traceView';

export const MAX_CLAUSES = 20;

export type SpanPredicate = (s: TaggedSpan) => boolean;
export type TracePredicate = (row: TraceRow) => boolean;

export interface TraceQuery {
  span: SpanPredicate[];
  trace: TracePredicate[];
  // Bare words: each must match the trace id or some span name (lowercased).
  words: string[];
}

export interface QueryError {
  token: string;
  message: string;
}

type Op = '=' | '!=' | '>' | '<' | '>=' | '<=' | ':';

interface Term {
  raw: string;
  key: string;
  op?: Op;
  value: string;
  quoted?: boolean;
}

// --- Tokenizer -------------------------------------------------------------------------

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
}

function scan(text: string, errors: QueryError[]): Term[] {
  const terms: Term[] = [];
  let i = 0;
  const n = text.length;

  const readQuoted = (): string => {
    let out = '';
    i++;
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        out += text[i + 1];
        i += 2;
      } else {
        out += text[i++];
      }
    }
    if (i >= n) errors.push({ token: text.slice(0, 40), message: 'unterminated quote' });
    else i++;
    return out;
  };

  const opAt = (j: number): Op | undefined => {
    const c = text[j];
    const next = text[j + 1];
    if ((c === '!' || c === '>' || c === '<') && next === '=') return (c + '=') as Op;
    if (c === '=' || c === '>' || c === '<' || c === ':') return c;
    return undefined;
  };

  while (i < n) {
    while (i < n && isSpace(text[i])) i++;
    if (i >= n) break;
    const start = i;
    if (text[i] === '"') {
      const value = readQuoted();
      terms.push({ raw: text.slice(start, i), key: '', value, quoted: true });
      continue;
    }
    while (i < n && !isSpace(text[i]) && !opAt(i)) i++;
    const key = text.slice(start, i);
    const op = i < n ? opAt(i) : undefined;
    if (!op) {
      terms.push({ raw: key, key, value: '' });
      continue;
    }
    i += op.length;
    let value = '';
    if (text[i] === '"') value = readQuoted();
    else {
      const vs = i;
      while (i < n && !isSpace(text[i])) i++;
      value = text.slice(vs, i);
    }
    terms.push({ raw: text.slice(start, i), key, op, value });
  }
  return terms;
}

// --- Value helpers -----------------------------------------------------------------------

function attrText(v: AttributeValue): string {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function attrNumber(v: AttributeValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const DURATION = /^(\d+(?:\.\d+)?)(us|µs|ms|s|m|h)?$/;
const UNIT_MS: Record<string, number> = { us: 0.001, µs: 0.001, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDurationMs(text: string): number | undefined {
  const m = DURATION.exec(text.trim().toLowerCase());
  if (!m) return undefined;
  return Number(m[1]) * UNIT_MS[m[2] ?? 'ms'];
}

function compare(op: Op, a: number, b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    default:
      return a === b;
  }
}

const STATUS: Record<string, StatusCode> = { error: 'ERROR', ok: 'OK', unset: 'UNSET' };
const KIND: Record<string, SpanKind> = {
  server: 'SERVER',
  client: 'CLIENT',
  internal: 'INTERNAL',
  producer: 'PRODUCER',
  consumer: 'CONSUMER',
  unspecified: 'UNSPECIFIED',
};

// --- Term compilation --------------------------------------------------------------------

function attrPredicate(t: Term, errors: QueryError[]): SpanPredicate | undefined {
  const fail = (message: string): undefined => {
    errors.push({ token: t.raw, message });
    return undefined;
  };
  if (!t.op) {
    if (t.key.startsWith('-') && t.key.length > 1) {
      const key = t.key.slice(1);
      return (s) => !Object.prototype.hasOwnProperty.call(s.span.attrs, key);
    }
    const key = t.key;
    return (s) => Object.prototype.hasOwnProperty.call(s.span.attrs, key);
  }
  if (!t.key) return fail('missing attribute name');
  const key = t.key;
  const has = (s: TaggedSpan) => Object.prototype.hasOwnProperty.call(s.span.attrs, key);
  if (t.op === '=' || t.op === ':') {
    if (!t.value) return has;
    const v = t.value.toLowerCase();
    return (s) => has(s) && attrText(s.span.attrs[key]).toLowerCase().includes(v);
  }
  if (t.op === '!=') {
    if (!t.value) return fail('missing value');
    const v = t.value.toLowerCase();
    return (s) => !has(s) || !attrText(s.span.attrs[key]).toLowerCase().includes(v);
  }
  const n = Number(t.value);
  if (t.value === '' || !Number.isFinite(n)) return fail('expected a number');
  const op = t.op;
  return (s) => {
    const a = attrNumber(s.span.attrs[key]);
    return a !== undefined && compare(op, a, n);
  };
}

function compileTerm(t: Term, q: TraceQuery, errors: QueryError[]): void {
  const fail = (message: string): void => {
    errors.push({ token: t.raw, message });
  };
  // Undotted bare words search names and ids; dotted ones (http.route) test attribute presence.
  if (t.quoted || (!t.op && !t.key.startsWith('-') && !t.key.includes('.'))) {
    if (t.value || t.key) q.words.push((t.quoted ? t.value : t.key).toLowerCase());
    return;
  }
  const key = t.key.toLowerCase();
  const value = t.value.toLowerCase();
  switch (t.op ? key : '') {
    case 'service':
      if (t.op !== '=' && t.op !== '!=' && t.op !== ':') return fail('use service= or service!=');
      if (!value) return fail('missing value');
      q.span.push(t.op === '!=' ? (s) => s.serviceName.toLowerCase() !== value : (s) => s.serviceName.toLowerCase() === value);
      return;
    case 'name':
      if (!value) return fail('missing value');
      if (t.op === ':') q.span.push((s) => s.span.name.toLowerCase().includes(value));
      else if (t.op === '=') q.span.push((s) => s.span.name.toLowerCase() === value);
      else if (t.op === '!=') q.span.push((s) => s.span.name.toLowerCase() !== value);
      else fail('use name: (contains), name= or name!=');
      return;
    case 'status': {
      const code = STATUS[value];
      if (!code) return fail('expected error, ok or unset');
      if (t.op === '!=') q.span.push((s) => s.span.statusCode !== code);
      else if (t.op === '=' || t.op === ':') q.span.push((s) => s.span.statusCode === code);
      else fail('use status= or status!=');
      return;
    }
    case 'kind': {
      const kind = KIND[value];
      if (!kind) return fail(`expected one of ${Object.keys(KIND).join(', ')}`);
      if (t.op === '!=') q.span.push((s) => s.span.kind !== kind);
      else if (t.op === '=' || t.op === ':') q.span.push((s) => s.span.kind === kind);
      else fail('use kind= or kind!=');
      return;
    }
    case 'dur':
    case 'duration': {
      if (t.op !== '>' && t.op !== '<' && t.op !== '>=' && t.op !== '<=') return fail('use dur> or dur<');
      const ms = parseDurationMs(t.value);
      if (ms === undefined) return fail('expected a duration such as 250ms, 1.5s or 2m');
      const op = t.op;
      q.trace.push((r) => compare(op, r.durationMs, ms));
      return;
    }
    case 'trace':
    case 'traceid':
      if (t.op !== ':' && t.op !== '=') return fail('use trace: or trace=');
      if (!value) return fail('missing value');
      q.trace.push((r) => r.traceId.includes(value));
      return;
    case 'has': {
      if (t.op !== ':' || !t.value) return fail('use has:<attribute>');
      const p = attrPredicate({ raw: t.raw, key: t.value, value: '' }, errors);
      if (p) q.span.push(p);
      return;
    }
    default: {
      const p = attrPredicate(t, errors);
      if (p) q.span.push(p);
    }
  }
}

function compileText(text: string, q: TraceQuery, errors: QueryError[], attrOnly: boolean): void {
  let source = text;
  if (source.length > MAX_QUERY_LENGTH) {
    errors.push({ token: `${source.slice(0, 20)}…`, message: `longer than ${MAX_QUERY_LENGTH} characters; truncated` });
    source = source.slice(0, MAX_QUERY_LENGTH);
  }
  const terms = scan(source, errors);
  if (terms.length > MAX_CLAUSES) {
    errors.push({ token: terms[MAX_CLAUSES].raw, message: `only the first ${MAX_CLAUSES} terms are applied` });
  }
  for (const t of terms.slice(0, MAX_CLAUSES)) {
    if (!attrOnly) {
      compileTerm(t, q, errors);
    } else if (t.quoted) {
      errors.push({ token: t.raw, message: 'expected key or key=value' });
    } else {
      const p = attrPredicate(t, errors);
      if (p) q.span.push(p);
    }
  }
}

export function parseTraceQuery(input: TraceQueryInput): { query: TraceQuery; errors: QueryError[] } {
  const q: TraceQuery = { span: [], trace: [], words: [] };
  const errors: QueryError[] = [];

  const service = input.service.trim().toLowerCase();
  if (service) q.span.push((s) => s.serviceName.toLowerCase() === service);
  const name = input.name.trim().toLowerCase();
  if (name) q.span.push((s) => s.span.name.toLowerCase().includes(name));
  const status = input.status ? STATUS[input.status] : undefined;
  if (status) q.span.push((s) => s.span.statusCode === status);
  const kind = input.kind ? KIND[input.kind] : undefined;
  if (kind) q.span.push((s) => s.span.kind === kind);
  if (input.attr.trim()) compileText(input.attr, q, errors, true);

  const { minMs, maxMs } = input;
  if (minMs !== null) q.trace.push((r) => r.durationMs >= minMs);
  if (maxMs !== null) q.trace.push((r) => r.durationMs <= maxMs);
  const tid = input.traceId.trim().toLowerCase();
  if (tid) q.trace.push((r) => r.traceId.includes(tid));

  if (input.query.trim()) compileText(input.query, q, errors, false);
  return { query: q, errors };
}

export function isEmptyQuery(q: TraceQuery): boolean {
  return !q.span.length && !q.trace.length && !q.words.length;
}

// Single pass over the spans: stops as soon as every word and the span predicates are satisfied.
export function matchesTrace(spans: Iterable<TaggedSpan>, row: TraceRow, q: TraceQuery): boolean {
  for (const p of q.trace) if (!p(row)) return false;
  const pending = q.words.filter((w) => !row.traceId.includes(w));
  let spanOk = q.span.length === 0;
  if (spanOk && !pending.length) return true;
  for (const s of spans) {
    if (!spanOk && q.span.every((p) => p(s))) spanOk = true;
    if (pending.length) {
      const name = s.span.name.toLowerCase();
      for (let i = pending.length - 1; i >= 0; i--) if (name.includes(pending[i])) pending.splice(i, 1);
    }
    if (spanOk && !pending.length) return true;
  }
  return false;
}
