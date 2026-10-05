// SPDX-License-Identifier: Apache-2.0
// otel_getTrace: one trace explained — critical path, self-time, errors, services and logs.

import { TelemetryStore } from '../../store/store';
import { severityLabel } from '../../views/format';
import { summarizeTrace } from '../../views/traceSummary';
import { WaterfallRow, buildWaterfall } from '../../views/waterfall';
import { renderBody } from '../../views/webview/logView';
import { MAX_SCAN_TRACES } from '../limits';
import { Ref } from '../refs';
import { latestTraceId, resolveSpanId, resolveTraceId } from '../resolve';
import { iso, safeValue, setOwn, truncateString } from '../serialize';
import { GetTraceInput } from '../toolInputs';
import {
  AnalysisContext,
  AnalysisOutput,
  childrenOf,
  codeOf,
  errorOutput,
  pct,
  refLabel,
  round1,
  rowEnd,
  selfTimes,
  sourceRef,
  spanRef,
  spansById,
  traceRef,
} from './common';

const MAX_PATH_STEPS = 30;
const TOP_N = 10;
const MAX_LOGS = 20;
const MAX_EXCEPTIONS_PER_SPAN = 3;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// From `start`, repeatedly step to the child that ends last among those starting by the current end.
export function criticalPath(start: WaterfallRow, children: Map<string, WaterfallRow[]>): { path: WaterfallRow[]; truncated: boolean } {
  const path = [start];
  const seen = new Set([start.spanId]);
  let cur = start;
  for (;;) {
    const end = rowEnd(cur);
    let next: WaterfallRow | undefined;
    for (const c of children.get(cur.spanId) ?? []) {
      if (c.startMs > end || seen.has(c.spanId)) continue;
      if (!next || rowEnd(c) > rowEnd(next) || (rowEnd(c) === rowEnd(next) && c.spanId < next.spanId)) next = c;
    }
    if (!next) return { path, truncated: false };
    if (path.length >= MAX_PATH_STEPS) return { path, truncated: true };
    seen.add(next.spanId);
    path.push(next);
    cur = next;
  }
}

export function getTraceDetail(store: TelemetryStore, input: GetTraceInput, ctx: AnalysisContext): AnalysisOutput {
  const r = ctx.redactor;
  let traceId: string;
  if (input.traceId) {
    const res = resolveTraceId(store, input.traceId);
    if ('error' in res) return errorOutput(res.error);
    traceId = res.traceId;
  } else {
    const latest = latestTraceId(store, undefined, MAX_SCAN_TRACES);
    if (!latest) return errorOutput('no traces have been received yet');
    traceId = latest;
  }

  const parts = store.getTraceParts(traceId);
  const tagged = store.getSpansForTrace(traceId);
  const rows = buildWaterfall(tagged);
  if (!rows.length) return errorOutput(`trace ${traceId} not found; it may have been evicted from the in-memory buffer`);
  const spans = spansById(tagged);
  const children = childrenOf(rows);
  const self = selfTimes(rows, children);
  const selfOf = (row: WaterfallRow) => self.get(row.spanId) ?? 0;
  const summary = summarizeTrace(traceId, parts).row;
  const total = summary.durationMs;

  let scope = rows;
  let zoom: WaterfallRow | undefined;
  if (input.spanId) {
    const res = resolveSpanId(parts, input.spanId);
    if ('error' in res) return errorOutput(res.error);
    const i = rows.findIndex((x) => x.spanId === res.spanId);
    zoom = rows[i];
    let j = i + 1;
    while (j < rows.length && rows[j].depth > zoom.depth) j++;
    scope = rows.slice(i, j);
  }

  const start =
    zoom ??
    rows
      .filter((x) => x.depth === 0)
      .sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs || cmpStr(a.spanId, b.spanId))[0];
  const { path, truncated: pathTruncated } = criticalPath(start, children);

  const step = (x: WaterfallRow, share: number) => ({
    spanId: x.spanId,
    name: x.name,
    service: x.service,
    durationMs: round1(x.durationMs),
    selfMs: round1(selfOf(x)),
    pctOfTrace: pct(share, total),
  });

  const topSelf = [...scope]
    .sort((a, b) => selfOf(b) - selfOf(a) || cmpStr(a.spanId, b.spanId))
    .slice(0, TOP_N)
    .map((x) => step(x, selfOf(x)));

  const errorRows = scope.filter((x) => x.hasError);
  const errors = errorRows.slice(0, TOP_N).map((x) => {
    const span = spans.get(x.spanId)!.span;
    const exceptions = span.events
      .filter((e) => e.name === 'exception' || Object.keys(e.attrs).some((k) => k.startsWith('exception.')))
      .slice(0, MAX_EXCEPTIONS_PER_SPAN)
      .map((e) => {
        const picked: Record<string, unknown> = {};
        for (const k of Object.keys(e.attrs).filter((k) => k.startsWith('exception.')).sort()) setOwn(picked, k, e.attrs[k]);
        return safeValue(r.value(picked));
      });
    return {
      spanId: x.spanId,
      name: x.name,
      service: x.service,
      statusMessage: span.statusMessage ? truncateString(r.text(span.statusMessage)) : undefined,
      exceptions,
      eventNames: [...new Set(span.events.map((e) => e.name))].slice(0, TOP_N).map((n) => truncateString(r.text(n))),
    };
  });

  const serviceSelf = new Map<string, number>();
  let scopeSelf = 0;
  for (const x of scope) {
    serviceSelf.set(x.service, (serviceSelf.get(x.service) ?? 0) + selfOf(x));
    scopeSelf += selfOf(x);
  }
  const byService = [...serviceSelf.entries()]
    .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
    .map(([service, ms]) => ({ service, selfMs: round1(ms), pct: pct(ms, scopeSelf) }));

  const result: Record<string, unknown> = {
    trace: {
      traceId,
      rootName: summary.rootName,
      rootService: summary.rootService,
      start: iso(summary.startMs),
      durationMs: round1(total),
      spanCount: summary.spanCount,
      errorCount: summary.errorCount,
      services: summary.services,
      orphanCount: rows.filter((x) => x.orphan).length,
    },
    zoom: zoom ? { spanId: zoom.spanId, name: zoom.name, service: zoom.service, spanCount: scope.length } : undefined,
    criticalPath: path.map((x) => step(x, x.durationMs)),
    criticalPathTruncated: pathTruncated || undefined,
    topSelfTime: topSelf,
    errors,
    byService,
  };

  let logInstances = new Set<string>();
  let logCount = 0;
  if (input.includeLogs) {
    const { items, truncated } = store.getLogsForTrace(traceId, { spanId: zoom?.spanId, limit: MAX_LOGS });
    logInstances = new Set(items.map((i) => i.instanceId));
    logCount = items.length;
    result.logs = items.map(({ instanceId, log }) => ({
      time: iso(log.timeMs),
      severity: severityLabel(log.severityNumber) || log.severityText,
      body: truncateString(r.text(renderBody(log.body))),
      spanId: log.spanId,
      instanceId,
      seq: log.seq,
    }));
    result.logsTruncated = truncated || undefined;
  }

  const refs: Ref[] = [traceRef(store, traceId, refLabel(r, summary.rootName))];
  const bottleneck = [...path].sort((a, b) => selfOf(b) - selfOf(a))[0];
  refs.push(spanRef(traceId, bottleneck.spanId, bottleneck.instanceId, refLabel(r, bottleneck.name)));
  const firstError = errorRows[0];
  if (firstError && firstError.spanId !== bottleneck.spanId) {
    refs.push(spanRef(traceId, firstError.spanId, firstError.instanceId, refLabel(r, firstError.name)));
  }
  if (logCount) {
    refs.push({
      kind: 'logs',
      traceId,
      spanId: zoom?.spanId,
      instanceId: logInstances.size === 1 ? [...logInstances][0] : undefined,
      label: 'View Logs',
    });
  }
  const code = codeOf(spans.get(bottleneck.spanId)!.span.codeLocation);
  if (code) refs.push(sourceRef(code, refLabel(r, bottleneck.name), traceId, bottleneck.spanId));
  return { result, refs, listKey: 'logs' };
}
