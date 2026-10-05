// SPDX-License-Identifier: Apache-2.0
// Links from tool results back to telemetry, and the chat buttons built from them.
// Button arguments come only from validated refs, never from text the model wrote.

import { normalizeSpanId, normalizeTraceId } from '../store/ids';
import { CodeLocation } from '../store/model';
import { parseSourceTarget } from '../views/navigationTargets';
import { MAX_BUTTONS } from './limits';

export type RefKind = 'trace' | 'span' | 'logs' | 'source';

export interface Ref {
  kind: RefKind;
  // Absent only for a source ref from an uncorrelated log.
  traceId?: string;
  spanId?: string;
  instanceId?: string;
  focusSeq?: number;
  code?: CodeLocation;
  label: string;
}

export interface Button {
  command: string;
  title: string;
  arguments: [Record<string, unknown>];
}

const MAX_TITLE = 60;
const MAX_INSTANCE_ID = 512;
const MAX_REFS_PER_RESULT = 100;
const KIND_ORDER: RefKind[] = ['trace', 'span', 'logs', 'source'];

// One line of plain text: control characters and line breaks become spaces.
export function cleanTitle(text: string, max = MAX_TITLE): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function parseRef(raw: unknown): Ref | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind = KIND_ORDER.find((k) => k === r.kind);
  if (!kind) return undefined;
  const traceId = normalizeTraceId(r.traceId);
  const spanId = normalizeSpanId(r.spanId);
  const code = parseSourceTarget(r.code);
  if (kind !== 'source' && !traceId) return undefined;
  if (kind === 'span' && !spanId) return undefined;
  if (kind === 'source' && !code) return undefined;
  const instanceId =
    typeof r.instanceId === 'string' && r.instanceId && r.instanceId.length <= MAX_INSTANCE_ID ? r.instanceId : undefined;
  const focusSeq = Number.isSafeInteger(r.focusSeq) && (r.focusSeq as number) >= 0 ? (r.focusSeq as number) : undefined;
  return {
    kind,
    traceId,
    spanId,
    instanceId,
    focusSeq: kind === 'logs' ? focusSeq : undefined,
    code: kind === 'source' ? code : undefined,
    label: cleanTitle(typeof r.label === 'string' ? r.label : ''),
  };
}

// Validates refs read back from a tool result; malformed entries are dropped.
export function parseRefs(raw: unknown): Ref[] {
  if (!Array.isArray(raw)) return [];
  const out: Ref[] = [];
  for (const item of raw.slice(0, MAX_REFS_PER_RESULT)) {
    const ref = parseRef(item);
    if (ref) out.push(ref);
  }
  return out;
}

function refKey(r: Ref): string {
  const code = r.code ? `${r.code.filepath}:${r.code.line ?? ''}` : '';
  return [r.kind, r.traceId ?? '', r.spanId ?? '', r.focusSeq ?? '', code].join('|');
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

// Source refs without a trace match on the file name instead.
function mentioned(r: Ref, answer: string): boolean {
  if (r.traceId) return answer.includes(r.traceId) || answer.includes(r.traceId.slice(0, 8));
  return !!r.code && answer.includes(basename(r.code.filepath).toLowerCase());
}

// Drops undefined fields so arguments carry exactly the keys the command reads.
function args(fields: Record<string, unknown>): [Record<string, unknown>] {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return [out];
}

export function toButton(r: Ref): Button | undefined {
  const short = r.traceId?.slice(0, 8) ?? '';
  switch (r.kind) {
    case 'trace':
      if (!r.traceId) return undefined;
      return {
        command: 'otel._revealTrace',
        title: cleanTitle(`Open Trace ${short}`),
        arguments: args({ traceId: r.traceId, preferInstanceId: r.instanceId }),
      };
    case 'span':
      if (!r.traceId || !r.spanId) return undefined;
      return {
        command: 'otel._revealTrace',
        title: cleanTitle(`Open Span ${r.label || r.spanId.slice(0, 8)}`),
        arguments: args({ traceId: r.traceId, spanId: r.spanId, preferInstanceId: r.instanceId }),
      };
    case 'logs':
      if (!r.traceId) return undefined;
      return {
        command: 'otel._revealLogs',
        title: cleanTitle(`View Logs ${short}`),
        arguments: args({ traceId: r.traceId, spanId: r.spanId, instanceId: r.instanceId, focusSeq: r.focusSeq }),
      };
    case 'source': {
      if (!r.code) return undefined;
      const { filepath, line, column, function: fn } = r.code;
      return {
        command: 'otel._openSource',
        title: cleanTitle(`Open Source ${basename(filepath)}${line ? `:${line}` : ''}`),
        arguments: args({ filepath, line, column, function: fn }),
      };
    }
  }
}

// `refs`: every ref collected during the answer; `lastRefs`: the final tool result's, used as fallback.
export function selectButtons(refs: readonly Ref[], answerText: string, lastRefs: readonly Ref[] = []): Button[] {
  const dedupe = (list: readonly Ref[]) => {
    const seen = new Set<string>();
    return list.filter((r) => {
      const k = refKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const answer = answerText.toLowerCase();
  let picked = dedupe(refs).filter((r) => mentioned(r, answer));
  if (!picked.length) picked = dedupe(lastRefs);
  const ordered = KIND_ORDER.flatMap((k) => picked.filter((r) => r.kind === k));
  const buttons: Button[] = [];
  for (const r of ordered) {
    const b = toButton(r);
    if (b) buttons.push(b);
    if (buttons.length >= MAX_BUTTONS) break;
  }
  return buttons;
}
