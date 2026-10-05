// SPDX-License-Identifier: Apache-2.0
// otel_compareTraces: where a trace spent more time than a baseline (explicit or median of peers).

import { TelemetryStore } from '../../store/store';
import { TraceSummary, summarizeTrace } from '../../views/traceSummary';
import { buildWaterfall } from '../../views/waterfall';
import { quantile } from '../../views/webview/stats';
import { MAX_SCAN_TRACES } from '../limits';
import { Ref } from '../refs';
import { allTraceIds, resolveTraceId } from '../resolve';
import { CompareTracesInput } from '../toolInputs';
import {
  AnalysisContext,
  AnalysisOutput,
  errorOutput,
  refLabel,
  round1,
  round3,
  selfTimes,
  spanRef,
  traceRef,
} from './common';

const MAX_BASELINE = 50;
const TOP_N = 10;

interface GroupStat {
  service: string;
  name: string;
  selfMs: number;
  errors: number;
  // Span with the most self-time in this group, for the target's span ref.
  topSpanId: string;
  topSpanSelf: number;
  instanceId: string;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const median = (xs: number[]) => quantile(xs, 0.5) ?? 0;
const ratio = (a: number, b: number) => (b > 0 ? round3(a / b) : null);

function groupSelf(store: TelemetryStore, traceId: string): Map<string, GroupStat> {
  const rows = buildWaterfall(store.getSpansForTrace(traceId));
  const self = selfTimes(rows);
  const out = new Map<string, GroupStat>();
  for (const r of rows) {
    const key = `${r.service}\u0000${r.name}`;
    const s = self.get(r.spanId) ?? 0;
    const g = out.get(key) ?? {
      service: r.service,
      name: r.name,
      selfMs: 0,
      errors: 0,
      topSpanId: r.spanId,
      topSpanSelf: -1,
      instanceId: r.instanceId,
    };
    g.selfMs += s;
    if (r.hasError) g.errors++;
    if (s > g.topSpanSelf) {
      g.topSpanSelf = s;
      g.topSpanId = r.spanId;
      g.instanceId = r.instanceId;
    }
    out.set(key, g);
  }
  return out;
}

export function compareTraces(store: TelemetryStore, input: CompareTracesInput, ctx: AnalysisContext): AnalysisOutput {
  const target = resolveTraceId(store, input.traceId);
  if ('error' in target) return errorOutput(target.error);
  const targetSummary = summarizeTrace(target.traceId, store.getTraceParts(target.traceId)).row;

  let baseline: TraceSummary['row'][];
  let mode: 'explicit' | 'median';
  if (input.baselineTraceId) {
    const b = resolveTraceId(store, input.baselineTraceId);
    if ('error' in b) return errorOutput(`baseline: ${b.error}`);
    if (b.traceId === target.traceId) return errorOutput('baselineTraceId must differ from traceId');
    baseline = [summarizeTrace(b.traceId, store.getTraceParts(b.traceId)).row];
    mode = 'explicit';
  } else {
    const candidates = allTraceIds(store, MAX_SCAN_TRACES)
      .filter((id) => id !== target.traceId)
      .map((id) => summarizeTrace(id, store.getTraceParts(id)).row)
      .filter((r) => r.rootName === targetSummary.rootName && r.rootService === targetSummary.rootService);
    if (!candidates.length) return errorOutput(`no comparable traces with root '${targetSummary.rootName}'`);
    const healthy = candidates.filter((r) => r.errorCount === 0);
    baseline = (healthy.length ? healthy : candidates).slice(0, MAX_BASELINE);
    mode = 'median';
  }

  const baselineMs = median(baseline.map((r) => r.durationMs));
  const representative = [...baseline].sort(
    (a, b) => Math.abs(a.durationMs - baselineMs) - Math.abs(b.durationMs - baselineMs) || cmpStr(a.traceId, b.traceId)
  )[0];

  const targetGroups = groupSelf(store, target.traceId);
  const baselineGroups = baseline.map((r) => groupSelf(store, r.traceId));
  const baselineKeys = new Map<string, { service: string; name: string }>();
  for (const m of baselineGroups) for (const [k, g] of m) if (!baselineKeys.has(k)) baselineKeys.set(k, g);
  // A group absent from one baseline trace contributes 0 to that trace's sum.
  const baselineSelf = (key: string) => median(baselineGroups.map((m) => m.get(key)?.selfMs ?? 0));
  const baselineErrors = (key: string) => baselineGroups.reduce((n, m) => n + (m.get(key)?.errors ?? 0), 0);

  const deltas = [...targetGroups.entries()]
    .map(([key, g]) => {
      const base = baselineSelf(key);
      return { key, g, base, diff: g.selfMs - base };
    })
    .filter((d) => d.diff > 0)
    .sort((a, b) => b.diff - a.diff || cmpStr(a.key, b.key));

  const groupRef = (g: { service: string; name: string }) => ({ service: g.service, name: g.name });
  const newInTarget = [...targetGroups.entries()]
    .filter(([k]) => !baselineKeys.has(k))
    .sort((a, b) => b[1].selfMs - a[1].selfMs || cmpStr(a[0], b[0]))
    .slice(0, TOP_N)
    .map(([, g]) => ({ ...groupRef(g), selfMs: round1(g.selfMs) }));
  const missingInTarget = [...baselineKeys.entries()]
    .filter(([k]) => !targetGroups.has(k))
    .sort((a, b) => cmpStr(a[0], b[0]))
    .slice(0, TOP_N)
    .map(([k, g]) => ({ ...groupRef(g), baselineSelfMs: round1(baselineSelf(k)) }));
  const newErrorGroups = [...targetGroups.entries()]
    .filter(([k, g]) => g.errors > 0 && baselineErrors(k) === 0)
    .sort((a, b) => cmpStr(a[0], b[0]))
    .slice(0, TOP_N)
    .map(([, g]) => ({ ...groupRef(g), errorSpans: g.errors }));

  const result: Record<string, unknown> = {
    target: {
      traceId: target.traceId,
      rootName: targetSummary.rootName,
      rootService: targetSummary.rootService,
      durationMs: round1(targetSummary.durationMs),
      errorCount: targetSummary.errorCount,
    },
    baseline: {
      mode,
      durationMs: round1(baselineMs),
      traceId: representative.traceId,
    },
    baselineCount: baseline.length,
    durationRatio: ratio(targetSummary.durationMs, baselineMs),
    durationDiffMs: round1(targetSummary.durationMs - baselineMs),
    deltas: deltas.slice(0, TOP_N).map((d) => ({
      ...groupRef(d.g),
      targetSelfMs: round1(d.g.selfMs),
      baselineSelfMs: round1(d.base),
      diffMs: round1(d.diff),
      ratio: ratio(d.g.selfMs, d.base),
    })),
    newInTarget,
    missingInTarget,
    errors: {
      targetErrorSpans: targetSummary.errorCount,
      baselineErrorSpans: median(baseline.map((r) => r.errorCount)),
      newErrorGroups,
    },
  };

  const refs: Ref[] = [
    traceRef(store, target.traceId, refLabel(ctx.redactor, targetSummary.rootName)),
    traceRef(store, representative.traceId, refLabel(ctx.redactor, `baseline ${representative.rootName}`)),
  ];
  const top = deltas[0];
  if (top) refs.push(spanRef(target.traceId, top.g.topSpanId, top.g.instanceId, refLabel(ctx.redactor, top.g.name)));
  return { result, refs, listKey: 'deltas' };
}
