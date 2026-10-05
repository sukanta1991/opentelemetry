// SPDX-License-Identifier: Apache-2.0
// otel_searchTraces: filter traces with the trace query syntax, then list or group them.

import { TelemetryStore } from '../../store/store';
import { isEmptyQuery, matchesTrace, parseTraceQuery } from '../../views/traceQuery';
import { TraceSummary, TraceSummaryCache, rootAttrValue } from '../../views/traceSummary';
import { quantile } from '../../views/webview/stats';
import { defaultQueryInput } from '../../views/webview/traceView';
import { Ref } from '../refs';
import { allTraceIds } from '../resolve';
import { iso } from '../serialize';
import { SearchTracesInput } from '../toolInputs';
import { AnalysisContext, AnalysisOutput, refLabel, round1, round3, taggedSpans, traceRef } from './common';

const TIME_BUCKETS = 12;

// One cache for all calls; pruned to the live trace ids on every call so it can't grow unbounded.
export const summaryCache = new TraceSummaryCache();

const byId = (a: TraceSummary, b: TraceSummary) => (a.row.traceId < b.row.traceId ? -1 : a.row.traceId > b.row.traceId ? 1 : 0);

function q(values: number[], p: number): number | null {
  const v = quantile(values, p);
  return v === null ? null : round1(v);
}

function stats(members: readonly TraceSummary[]) {
  const durations = members.map((m) => m.row.durationMs);
  const errorTraces = members.filter((m) => m.row.errorCount > 0).length;
  return {
    count: members.length,
    errorTraces,
    errorRate: members.length ? round3(errorTraces / members.length) : null,
    p50Ms: q(durations, 0.5),
    p95Ms: q(durations, 0.95),
    maxMs: durations.length ? round1(durations.reduce((a, b) => Math.max(a, b), 0)) : null,
  };
}

// Slowest failing trace if any failed, else the slowest trace.
function example(members: readonly TraceSummary[]): TraceSummary | undefined {
  const failing = members.filter((m) => m.row.errorCount > 0);
  const pool = failing.length ? failing : members;
  return [...pool].sort((a, b) => b.row.durationMs - a.row.durationMs || byId(a, b))[0];
}

function group(key: string, members: readonly TraceSummary[]) {
  const s = stats(members);
  return {
    key,
    count: s.count,
    errorCount: s.errorTraces,
    errorRate: s.errorRate,
    p50Ms: s.p50Ms,
    p95Ms: s.p95Ms,
    maxMs: s.maxMs,
    exampleTraceId: example(members)?.row.traceId,
  };
}

type Group = ReturnType<typeof group>;

function rowCompare(sort: SearchTracesInput['sort']): (a: TraceSummary, b: TraceSummary) => number {
  switch (sort) {
    case 'duration':
      return (a, b) => b.row.durationMs - a.row.durationMs || byId(a, b);
    case 'errors':
      return (a, b) => b.row.errorCount - a.row.errorCount || b.row.durationMs - a.row.durationMs || byId(a, b);
    default:
      return (a, b) => b.row.startMs - a.row.startMs || byId(a, b);
  }
}

function groupCompare(sort: SearchTracesInput['sort']): (a: Group, b: Group) => number {
  const byKey = (a: Group, b: Group) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  switch (sort) {
    case 'duration':
      return (a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || byKey(a, b);
    case 'errors':
      return (a, b) => b.errorCount - a.errorCount || (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || byKey(a, b);
    default:
      return (a, b) => b.count - a.count || byKey(a, b);
  }
}

function timeGroups(matches: readonly TraceSummary[], from: number | undefined, now: number): Group[] {
  if (!matches.length && from === undefined) return [];
  const starts = matches.map((m) => m.row.startMs);
  const lo = from ?? starts.reduce((a, b) => Math.min(a, b), Infinity);
  const hi = from !== undefined ? now : starts.reduce((a, b) => Math.max(a, b), -Infinity);
  const width = Math.max(1, (hi - lo) / TIME_BUCKETS);
  const buckets: TraceSummary[][] = Array.from({ length: TIME_BUCKETS }, () => []);
  for (const m of matches) {
    const i = Math.min(TIME_BUCKETS - 1, Math.max(0, Math.floor((m.row.startMs - lo) / width)));
    buckets[i].push(m);
  }
  return buckets.map((members, i) => group(iso(lo + i * width) ?? String(lo + i * width), members));
}

function keyOf(s: TraceSummary, groupBy: string): string {
  if (groupBy === 'rootName') return s.row.rootName;
  if (groupBy === 'rootService') return s.row.rootService || '(unknown)';
  return rootAttrValue(s.root, groupBy) ?? '(missing)';
}

export function searchTraces(store: TelemetryStore, input: SearchTracesInput, ctx: AnalysisContext): AnalysisOutput {
  const queryInput = defaultQueryInput();
  queryInput.service = input.service ?? '';
  queryInput.status = input.status ?? '';
  queryInput.minMs = input.minDurationMs ?? null;
  queryInput.query = input.query ?? '';
  const { query, errors } = parseTraceQuery(queryInput);
  const filtering = !isEmptyQuery(query);
  const from = input.sinceMinutes !== undefined ? ctx.now - input.sinceMinutes * 60_000 : undefined;

  const ids = allTraceIds(store);
  const matches: TraceSummary[] = [];
  for (const id of ids) {
    const parts = store.getTraceParts(id);
    const summary = summaryCache.get(id, parts);
    if (from !== undefined && summary.row.startMs < from) continue;
    if (filtering && !matchesTrace(taggedSpans(parts), summary.row, query)) continue;
    matches.push(summary);
  }
  summaryCache.prune(new Set(ids));

  const result: Record<string, unknown> = {
    scannedTraces: ids.length,
    matched: matches.length,
    sort: input.sort,
    sinceMinutes: input.sinceMinutes,
    queryErrors: errors.length ? errors : undefined,
    stats: stats(matches),
  };
  const refs: Ref[] = [];
  const summaries = new Map(matches.map((m) => [m.row.traceId, m]));
  const addRef = (traceId: string | undefined) => {
    const s = traceId ? summaries.get(traceId) : undefined;
    if (s) refs.push(traceRef(store, s.row.traceId, refLabel(ctx.redactor, s.row.rootName)));
  };

  if (input.groupBy) {
    let groups: Group[];
    if (input.groupBy === 'time') {
      groups = timeGroups(matches, from, ctx.now);
    } else {
      const byKey = new Map<string, TraceSummary[]>();
      for (const m of matches) {
        const k = keyOf(m, input.groupBy);
        const list = byKey.get(k) ?? [];
        list.push(m);
        byKey.set(k, list);
      }
      groups = [...byKey.entries()]
        .map(([k, members]) => group(k, members))
        .sort(groupCompare(input.sort))
        .slice(0, input.limit);
    }
    result.groupBy = input.groupBy;
    result.groups = groups;
    for (const g of groups) addRef(g.exampleTraceId);
    return { result, refs, listKey: 'groups' };
  }
  const rows = [...matches].sort(rowCompare(input.sort)).slice(0, input.limit);
  result.rows = rows.map(({ row }) => ({
    traceId: row.traceId,
    rootName: row.rootName,
    rootService: row.rootService,
    start: iso(row.startMs),
    durationMs: round1(row.durationMs),
    spanCount: row.spanCount,
    errorCount: row.errorCount,
    services: row.services,
  }));
  for (const { row } of rows) addRef(row.traceId);
  return { result, refs, listKey: 'rows' };
}
