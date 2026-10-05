// SPDX-License-Identifier: Apache-2.0
// otel_findSpans: span-level search across the newest traces, with self-time and grouping.

import { TaggedSpan, TelemetryStore } from '../../store/store';
import { parseTraceQuery } from '../../views/traceQuery';
import { buildWaterfall } from '../../views/waterfall';
import { quantile } from '../../views/webview/stats';
import { defaultQueryInput } from '../../views/webview/traceView';
import { MAX_SCAN_TRACES } from '../limits';
import { Ref } from '../refs';
import { allTraceIds } from '../resolve';
import { FindSpansInput } from '../toolInputs';
import {
  AnalysisContext,
  AnalysisOutput,
  codeOf,
  refLabel,
  round1,
  round3,
  selfTimes,
  sourceRef,
  spanRef,
  spansById,
  usefulAttrs,
} from './common';

interface Hit {
  t: TaggedSpan;
  traceId: string;
  selfMs: number;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byIds = (a: Hit, b: Hit) => cmpStr(a.traceId, b.traceId) || cmpStr(a.t.span.spanId, b.t.span.spanId);

function q(values: number[], p: number): number | null {
  const v = quantile(values, p);
  return v === null ? null : round1(v);
}

function groupFields(h: Hit, groupBy: FindSpansInput['groupBy']): { key: string; service?: string; name?: string } {
  const service = h.t.serviceName;
  const name = h.t.span.name;
  if (groupBy === 'service') return { key: service, service };
  if (groupBy === 'name') return { key: name, name };
  return { key: `${service}\u0000${name}`, service, name };
}

export function findSpans(store: TelemetryStore, input: FindSpansInput, ctx: AnalysisContext): AnalysisOutput {
  const queryInput = defaultQueryInput();
  queryInput.service = input.service ?? '';
  queryInput.status = input.status ?? '';
  queryInput.query = input.query ?? '';
  const { query, errors } = parseTraceQuery(queryInput);
  const notes: string[] = [];
  if (query.trace.length || query.words.length) {
    notes.push('Trace-level predicates (dur, trace) and bare words are ignored here; use otel_searchTraces for those.');
  }
  const from = input.sinceMinutes !== undefined ? ctx.now - input.sinceMinutes * 60_000 : undefined;
  const min = input.minDurationMs;
  const matches = (t: TaggedSpan) =>
    (from === undefined || t.span.startMs >= from) &&
    (min === undefined || t.span.durationMs >= min) &&
    query.span.every((p) => p(t));

  const all = allTraceIds(store);
  const ids = all.slice(0, MAX_SCAN_TRACES);
  const hits: Hit[] = [];
  let totalSelf = 0;
  for (const traceId of ids) {
    const tagged = store.getSpansForTrace(traceId);
    const matched = [...spansById(tagged).values()].filter(matches);
    if (!matched.length) continue;
    const self = selfTimes(buildWaterfall(tagged));
    for (const t of matched) {
      const selfMs = self.get(t.span.spanId) ?? 0;
      hits.push({ t, traceId, selfMs });
      totalSelf += selfMs;
    }
  }
  if (all.length > ids.length) notes.push(`Only the newest ${ids.length} of ${all.length} traces were scanned.`);

  const result: Record<string, unknown> = {
    scannedTraces: ids.length,
    totalTraces: all.length,
    matchedSpans: hits.length,
    sort: input.sort,
    groupBy: input.groupBy,
    notes: notes.length ? notes : undefined,
    queryErrors: errors.length ? errors : undefined,
  };
  const refs: Ref[] = [];
  const bySort =
    input.sort === 'selfTime'
      ? (a: Hit, b: Hit) => b.selfMs - a.selfMs || byIds(a, b)
      : (a: Hit, b: Hit) => b.t.span.durationMs - a.t.span.durationMs || byIds(a, b);

  if (input.groupBy === 'none') {
    const rows = [...hits].sort(bySort).slice(0, input.limit);
    result.spans = rows.map((h) => ({
      traceId: h.traceId,
      spanId: h.t.span.spanId,
      service: h.t.serviceName,
      name: h.t.span.name,
      kind: h.t.span.kind,
      status: h.t.span.statusCode,
      durationMs: round1(h.t.span.durationMs),
      selfMs: round1(h.selfMs),
      attrs: usefulAttrs(h.t.span.attrs, ctx.redactor),
      code: codeOf(h.t.span.codeLocation),
    }));
    for (const h of rows) {
      const label = refLabel(ctx.redactor, h.t.span.name);
      refs.push(spanRef(h.traceId, h.t.span.spanId, h.t.instanceId, label));
      const code = codeOf(h.t.span.codeLocation);
      if (code) refs.push(sourceRef(code, label, h.traceId, h.t.span.spanId));
    }
    return { result, refs, listKey: 'spans' };
  }

  const groups = new Map<string, { fields: ReturnType<typeof groupFields>; members: Hit[] }>();
  for (const h of hits) {
    const fields = groupFields(h, input.groupBy);
    const g = groups.get(fields.key) ?? { fields, members: [] };
    g.members.push(h);
    groups.set(fields.key, g);
  }
  const out = [...groups.values()].map(({ fields, members }) => {
    const durations = members.map((m) => m.t.span.durationMs);
    const self = members.reduce((a, m) => a + m.selfMs, 0);
    const ex = [...members].sort((a, b) => b.t.span.durationMs - a.t.span.durationMs || byIds(a, b))[0];
    return {
      key: fields.key,
      example: ex,
      row: {
        service: fields.service,
        name: fields.name,
        count: members.length,
        errorCount: members.filter((m) => m.t.span.statusCode === 'ERROR').length,
        totalSelfMs: round1(self),
        p50Ms: q(durations, 0.5),
        p95Ms: q(durations, 0.95),
        shareOfSelfTime: totalSelf > 0 ? round3(self / totalSelf) : null,
        exampleTraceId: ex.traceId,
        exampleSpanId: ex.t.span.spanId,
      },
    };
  });
  out.sort(
    (a, b) =>
      (input.sort === 'selfTime' ? b.row.totalSelfMs - a.row.totalSelfMs : (b.row.p95Ms ?? 0) - (a.row.p95Ms ?? 0)) ||
      cmpStr(a.key, b.key)
  );
  const top = out.slice(0, input.limit);
  result.groups = top.map((g) => g.row);
  for (const { example: ex } of top) {
    refs.push(spanRef(ex.traceId, ex.t.span.spanId, ex.t.instanceId, refLabel(ctx.redactor, ex.t.span.name)));
  }
  return { result, refs, listKey: 'groups' };
}
