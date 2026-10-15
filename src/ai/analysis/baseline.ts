// SPDX-License-Identifier: Apache-2.0
// otel_compareBaseline: what changed against a saved or captured baseline, per service, call and operation.

import { LIVE_REALM, TelemetryStore } from '../../store/store';
import { Snapshot, SnapshotSourceKind } from '../../views/baseline';
import { BaselineSettings, ComparisonResult, KeyComparison, MetricDelta, Verdict, compareSnapshots } from '../../views/baselineCompare';
import { buildComparedMap } from '../../views/baselineMap';
import { Ref } from '../refs';
import { CompareBaselineInput } from '../toolInputs';
import { AnalysisContext, AnalysisOutput, errorOutput, round1, round3 } from './common';

export interface BaselineCandidate {
  id: string;
  name: string;
  createdMs: number;
  sourceKind: SnapshotSourceKind;
  sourceLabel: string;
  saved: boolean;
  active: boolean;
}

// Prepared by the VS Code adapter: the tool itself never touches files.
export interface BaselineLookup {
  list: BaselineCandidate[];
  bodies: ReadonlyMap<string, Snapshot>;
  settings: BaselineSettings;
}

const MAX_KNOWN = 20;
const MAX_REFS = 6;
const SHOWN: readonly Verdict[] = ['regressed', 'improved', 'new', 'removed'];
const ORDER: Record<Verdict, number> = { regressed: 0, improved: 1, new: 2, removed: 3, untracked: 4, insufficient: 5, unchanged: 6 };

// Exact id, else case-insensitive name; the newest wins when names repeat.
export function matchBaseline(list: readonly BaselineCandidate[], text: string): BaselineCandidate | undefined {
  const byId = list.find((b) => b.id === text);
  if (byId) return byId;
  const lower = text.toLowerCase();
  return list.filter((b) => b.name.toLowerCase() === lower).sort((a, b) => b.createdMs - a.createdMs)[0];
}

const known = (list: readonly BaselineCandidate[]) => list.slice(0, MAX_KNOWN).map((b) => b.name).join(', ') || '(none)';
const iso = (ms: number) => new Date(ms).toISOString();
const pair = (m: MetricDelta | undefined, round: (x: number) => number) =>
  m ? [m.base === null ? null : round(m.base), m.current === null ? null : round(m.current)] : undefined;

function row(k: KeyComparison, labels: Map<string, string>) {
  const name = (id: string) => labels.get(id) ?? id;
  const kind = k.op !== undefined ? 'operation' : k.source !== undefined ? 'call' : 'service';
  const changed = (['p50', 'p95', 'errorRate', 'fanout'] as const).filter((m) => {
    const c = k[m]?.change;
    return c === 'regressed' || c === 'improved';
  });
  const r: Record<string, unknown> = {
    kind,
    verdict: k.verdict,
    ...(k.source !== undefined ? { from: name(k.source), to: name(k.target) } : { service: name(k.target) }),
  };
  if (k.op !== undefined) r.operation = k.op;
  r.calls = [k.base?.count ?? 0, k.current?.count ?? 0];
  r.p50Ms = pair(k.p50, round1);
  r.p95Ms = pair(k.p95, round1);
  r.errorRate = pair(k.errorRate, round3);
  if (k.fanout) r.callsPerRequest = pair(k.fanout, round1);
  if (changed.length) r.changed = changed;
  return r;
}

const byImportance = (a: KeyComparison, b: KeyComparison) =>
  ORDER[a.verdict] - ORDER[b.verdict] ||
  Math.abs((b.p95.delta ?? 0) / (b.p95.base || 1)) - Math.abs((a.p95.delta ?? 0) / (a.p95.base || 1)) ||
  (b.current?.count ?? 0) - (a.current?.count ?? 0);

export function compareBaseline(store: TelemetryStore, input: CompareBaselineInput, ctx: AnalysisContext): AnalysisOutput {
  const lookup = ctx.baselines;
  if (!lookup?.list.length) {
    return errorOutput('No baselines exist yet. Ask the user to capture one: Service Map ▸ Baseline… ▸ Mark now, or the "OpenTelemetry: Mark Baseline Now" command.');
  }
  const base = input.baseline ? matchBaseline(lookup.list, input.baseline) : lookup.list.find((b) => b.active);
  if (!base) {
    return errorOutput(
      input.baseline
        ? `no baseline named ${JSON.stringify(input.baseline)}; known baselines: ${known(lookup.list)}`
        : `no baseline is active; pass "baseline" with one of: ${known(lookup.list)}`
    );
  }
  const snapshot = lookup.bodies.get(base.id);
  if (!snapshot) return errorOutput(`baseline ${JSON.stringify(base.name)} could not be read`);

  let comparison: ComparisonResult | null;
  let against: Record<string, unknown>;
  const againstText = input.against && input.against.toLowerCase() !== 'current' ? input.against : undefined;
  if (againstText) {
    const other = matchBaseline(lookup.list, againstText);
    if (!other) return errorOutput(`no baseline named ${JSON.stringify(againstText)}; known baselines: ${known(lookup.list)}`);
    if (other.id === base.id) return errorOutput('"against" must name a different baseline');
    const otherBody = lookup.bodies.get(other.id);
    if (!otherBody) return errorOutput(`baseline ${JSON.stringify(other.name)} could not be read`);
    comparison = compareSnapshots(snapshot, otherBody, lookup.settings);
    against = { kind: 'baseline', name: other.name, capturedAt: iso(other.createdMs) };
  } else {
    let realm = LIVE_REALM;
    let label = 'live';
    if (input.session) {
      const want = input.session.toLowerCase();
      const s = store.getImportedSessions().find((v) => v.session.id === input.session || v.session.source.toLowerCase() === want);
      if (!s) {
        const names = store.getImportedSessions().map((v) => v.session.source).slice(0, MAX_KNOWN);
        return errorOutput(`no loaded session ${JSON.stringify(input.session)}; loaded sessions: ${names.join(', ') || '(none)'}`);
      }
      realm = s.session.id;
      label = s.session.source;
    }
    const built = buildComparedMap(store.getAllTaggedSpans(realm), { range: 'all' }, snapshot, lookup.settings, realm);
    comparison = built.comparison;
    against = { kind: realm === LIVE_REALM ? 'live' : 'session', name: label };
    if (built.model.cutoffMs !== undefined) against.after = iso(built.model.cutoffMs);
  }

  const baseline = { name: base.name, source: base.sourceKind, sourceLabel: base.sourceLabel, capturedAt: iso(base.createdMs), truncated: snapshot.truncated };
  if (!comparison) {
    return { result: { baseline, against, waiting: true, note: 'No calls after the baseline cut-off yet; exercise the app and ask again.' }, refs: [] };
  }

  const scope = input.scope;
  const inScope = comparison.keys.filter((k) =>
    scope === 'services' ? k.op === undefined && k.source === undefined : scope === 'calls' ? k.op === undefined && k.source !== undefined : scope === 'operations' ? k.op !== undefined : true
  );
  const summary: Record<string, number> = {};
  for (const k of inScope) summary[k.verdict] = (summary[k.verdict] ?? 0) + 1;
  const changed = inScope.filter((k) => SHOWN.includes(k.verdict)).sort(byImportance);
  const labels = new Map(comparison.nodes.map((n) => [n.id, n.label]));

  const refs: Ref[] = [];
  for (const k of changed) {
    if (refs.length >= MAX_REFS) break;
    if (k.verdict !== 'regressed') continue;
    const traceId = k.exemplars.current.find((t) => store.findTraceInstances(t).length > 0);
    if (traceId && !refs.some((r) => r.traceId === traceId)) refs.push({ kind: 'trace', traceId, label: `${labels.get(k.target) ?? k.target}${k.op ? ` ${k.op}` : ''} (now)` });
  }

  return {
    result: {
      baseline,
      against,
      coverage: { missingFromBaselinePct: round1(comparison.coverage.ratio * 100), warn: comparison.coverage.warn },
      summary,
      changes: changed.slice(0, input.limit).map((k) => row(k, labels)),
      note: 'Only statistically significant changes past the minimum thresholds are listed; calls = [baseline, now], metrics = [baseline, now].',
    },
    refs,
    listKey: 'changes',
  };
}
