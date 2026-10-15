// SPDX-License-Identifier: Apache-2.0
// Service map in baseline mode: comparison results attached to the model and details. No vscode import.

import { Snapshot, SnapshotEntry, SnapshotSourceKind } from './baseline';
import {
  BaselineSettings,
  ComparisonResult,
  Coverage,
  DeltaMetric,
  KeyComparison,
  KeyDelta,
  MapDelta,
  Verdict,
  compareSnapshots,
  compareToCurrent,
} from './baselineCompare';
import {
  CallStats,
  DEFAULT_DETAIL_CAPS,
  DEFAULT_THRESHOLDS,
  DetailCaps,
  MAX_NODES,
  MapSelection,
  ModelEdge,
  ModelNode,
  NodeDetails,
  OperationStats,
  ServiceMapModel,
  ServiceMapOptions,
  TaggedSpan,
  buildServiceMapCollected,
  classifyHealth,
  compareModelEdges,
  compareModelNodes,
} from './serviceMapModel';

export type ColorMode = 'absolute' | 'baseline';

export interface BaselineLabel {
  name: string;
  createdMs: number;
  sourceKind: SnapshotSourceKind;
  sourceLabel: string;
}

export interface BaselineInfo extends BaselineLabel {
  cutoffMs?: number;
  // Name of the second baseline in a read-only baseline-vs-baseline map.
  against?: string;
  // No calls after the cut-off yet, so nothing is compared.
  waiting: boolean;
  truncated: boolean;
  // Nodes and edges only; operations are counted per scope in opChanges.
  summary: Record<Verdict, number> | null;
  coverage: Coverage | null;
}

export interface ComparedMap {
  model: ServiceMapModel;
  comparison: ComparisonResult | null;
}

type MapOptions = Pick<ServiceMapOptions, 'thresholds' | 'maxNodes'>;

const scopeKey = (source: string | undefined, target: string) => JSON.stringify([source ?? null, target]);

function toDelta(k: KeyComparison): KeyDelta {
  const d: KeyDelta = { verdict: k.verdict, p50: k.p50, p95: k.p95, errorRate: k.errorRate };
  if (k.base) d.base = k.base;
  if (k.current) d.current = k.current;
  if (k.fanout) d.fanout = k.fanout;
  return d;
}

const METRICS: readonly DeltaMetric[] = ['p50', 'p95', 'errorRate', 'fanout'];

const round2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

function toMapDelta(k: KeyComparison): MapDelta {
  const d: MapDelta = { verdict: k.verdict, p95: [round2(k.p95.base), round2(k.p95.current)] };
  const changed = METRICS.filter((m) => {
    const c = k[m]?.change;
    return c === 'regressed' || c === 'improved';
  });
  if (changed.length) d.changed = changed;
  return d;
}

const ZERO_STATS = (): ModelNode['stats'] => ({
  count: 0,
  errors: 0,
  errorRate: 0,
  p50: null,
  p95: null,
  lastSeenMs: 0,
  spark: { count: [], errors: [] },
});

// Attaches deltas, counts changed operations per scope, and adds baseline-only nodes and edges as ghosts.
export function applyComparison(model: ServiceMapModel, comparison: ComparisonResult, opts: MapOptions = {}): ServiceMapModel {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const scopes = new Map<string, KeyComparison>();
  const opChanges = new Map<string, { regressed: number; improved: number }>();
  for (const k of comparison.keys) {
    const key = scopeKey(k.source, k.target);
    if (k.op === undefined) scopes.set(key, k);
    else if (k.verdict === 'regressed' || k.verdict === 'improved') {
      let c = opChanges.get(key);
      if (!c) opChanges.set(key, (c = { regressed: 0, improved: 0 }));
      c[k.verdict]++;
    }
  }
  const decorate = <T extends ModelNode | ModelEdge>(item: T, key: string): T => {
    const out = { ...item };
    const k = scopes.get(key);
    if (k) out.cmp = toMapDelta(k);
    const c = opChanges.get(key);
    if (c) out.opChanges = c;
    return out;
  };

  const nodes = model.nodes.map((n) => decorate(n, scopeKey(undefined, n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  let hiddenNodes = model.hiddenNodes;
  for (const n of comparison.nodes) {
    const k = scopes.get(scopeKey(undefined, n.id));
    // Nodes with current calls were left out by the node cap, not by the comparison.
    if (ids.has(n.id) || !k || k.current) continue;
    if (nodes.length >= maxNodes) {
      hiddenNodes++;
      continue;
    }
    nodes.push(decorate({ ...n, stats: ZERO_STATS(), health: 'idle', ghost: true }, scopeKey(undefined, n.id)));
    ids.add(n.id);
  }

  const edges = model.edges.map((e) => decorate(e, scopeKey(e.source, e.target)));
  const present = new Set(edges.map((e) => scopeKey(e.source, e.target)));
  for (const [key, k] of scopes) {
    if (k.source === undefined || present.has(key) || k.current || !ids.has(k.source) || !ids.has(k.target)) continue;
    edges.push(decorate({ source: k.source, target: k.target, stats: entryStats(undefined), health: 'idle', ghost: true }, key));
  }

  return { ...model, hiddenNodes, nodes: nodes.sort(compareModelNodes), edges: edges.sort(compareModelEdges) };
}

// One collector pass gives both the map and the current side of the comparison.
export function buildComparedMap(
  tagged: readonly TaggedSpan[],
  opts: ServiceMapOptions,
  baseline: Snapshot,
  settings: BaselineSettings,
  realm: string
): ComparedMap {
  const cutoffMs = baseline.source.realm === realm ? baseline.source.toMs : undefined;
  const { model, collected } = buildServiceMapCollected(tagged, { ...opts, ops: true, cutoffMs });
  let calls = false;
  for (const n of collected.nodes.values()) {
    if (n.acc.count) {
      calls = true;
      break;
    }
  }
  if (!calls) return { model, comparison: null };
  const comparison = compareToCurrent(baseline, collected, settings);
  return { model: applyComparison(model, comparison, opts), comparison };
}

function entryStats(e: SnapshotEntry | undefined): CallStats {
  if (!e) return { count: 0, errors: 0, errorRate: 0, p50: null, p95: null };
  return { count: e.count, errors: e.errors, errorRate: e.count ? e.errors / e.count : 0, p50: e.p50, p95: e.p95 };
}

// Read-only map of baseline `b` compared with baseline `a`; there are no spans behind it.
export function buildSnapshotMap(a: Snapshot, b: Snapshot, settings: BaselineSettings, opts: MapOptions = {}): ComparedMap {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const comparison = compareSnapshots(a, b, settings);
  const scopes = new Map<string, SnapshotEntry>();
  for (const e of b.entries) if (e.op === undefined) scopes.set(scopeKey(e.source, e.target), e);

  const all = b.nodes
    .map((n): ModelNode => {
      const stats = { ...entryStats(scopes.get(scopeKey(undefined, n.id))), lastSeenMs: 0, spark: { count: [], errors: [] } };
      return { ...n, stats, health: classifyHealth(stats, thresholds) };
    })
    .sort((x, y) => (x.type === 'service' ? 0 : 1) - (y.type === 'service' ? 0 : 1) || y.stats.count - x.stats.count || compareModelNodes(x, y));
  const nodes = all.slice(0, maxNodes);
  const ids = new Set(nodes.map((n) => n.id));
  const edges: ModelEdge[] = [];
  for (const e of scopes.values()) {
    if (e.source === undefined || !ids.has(e.source) || !ids.has(e.target)) continue;
    const stats = entryStats(e);
    edges.push({ source: e.source, target: e.target, stats, health: classifyHealth(stats, thresholds) });
  }
  const model: ServiceMapModel = {
    range: 'all',
    anchorMs: b.source.toMs,
    fromMs: b.source.fromMs,
    effectiveWindowMs: Math.max(0, b.source.toMs - b.source.fromMs),
    partial: false,
    hiddenNodes: all.length - nodes.length,
    nodes: nodes.sort(compareModelNodes),
    edges: edges.sort(compareModelEdges),
  };
  return { model: applyComparison(model, comparison, opts), comparison };
}

const SEVERITY: Record<Verdict, number> = { regressed: 0, improved: 1, new: 2, removed: 3, untracked: 4, insufficient: 5, unchanged: 6 };

function selectionScope(sel: MapSelection): [string | undefined, string] {
  return sel.kind === 'edge' ? [sel.source, sel.target] : [undefined, sel.id];
}

// Every compared operation of the selected scope, most significant changes first.
function comparedOperations(comparison: ComparisonResult, sel: MapSelection, cap: number): OperationStats[] {
  const [source, target] = selectionScope(sel);
  return comparison.keys
    .filter((k) => k.op !== undefined && k.source === source && k.target === target)
    .sort(
      (a, b) =>
        SEVERITY[a.verdict] - SEVERITY[b.verdict] ||
        (b.current?.count ?? 0) - (a.current?.count ?? 0) ||
        (a.op! < b.op! ? -1 : a.op! > b.op! ? 1 : 0)
    )
    .slice(0, cap)
    .map((k) => {
      const count = k.current?.count ?? 0;
      const errors = k.current?.errors ?? 0;
      return { name: k.op!, count, errors, errorRate: count ? errors / count : 0, p50: k.p50.current, p95: k.p95.current, cmp: toDelta(k) };
    });
}

function scopeComparison(comparison: ComparisonResult, sel: MapSelection): KeyComparison | undefined {
  const [source, target] = selectionScope(sel);
  return comparison.keys.find((x) => x.op === undefined && x.source === source && x.target === target);
}

function withScopeDeltas(details: NodeDetails, comparison: ComparisonResult, hasTrace: (traceId: string) => boolean): NodeDetails {
  const k = scopeComparison(comparison, details.selection);
  const out: NodeDetails = { ...details, baselineTraces: (k?.exemplars.base ?? []).filter(hasTrace) };
  if (k) out.cmp = toDelta(k);
  return out;
}

export function compareDetails(
  details: NodeDetails,
  comparison: ComparisonResult,
  hasTrace: (traceId: string) => boolean,
  caps: DetailCaps = DEFAULT_DETAIL_CAPS
): NodeDetails {
  return withScopeDeltas({ ...details, operations: comparedOperations(comparison, details.selection, caps.operations) }, comparison, hasTrace);
}

// Details for the read-only map: operations and example traces only, since there are no spans behind it.
export function snapshotDetails(
  model: ServiceMapModel,
  comparison: ComparisonResult,
  selection: MapSelection,
  hasTrace: (traceId: string) => boolean,
  caps: DetailCaps = DEFAULT_DETAIL_CAPS
): NodeDetails | undefined {
  const id = selection.kind === 'node' ? selection.id : undefined;
  const found =
    selection.kind === 'node'
      ? model.nodes.some((n) => n.id === selection.id)
      : model.edges.some((e) => e.source === selection.source && e.target === selection.target);
  if (!found) return undefined;
  const details: NodeDetails = {
    selection,
    inbound: id ? model.edges.filter((e) => e.target === id) : [],
    outbound: id ? model.edges.filter((e) => e.source === id) : [],
    operations: comparedOperations(comparison, selection, caps.operations),
    errorTraces: [],
    slowTraces: [],
    sources: [],
    instanceIds: [],
  };
  return withScopeDeltas(details, comparison, hasTrace);
}

export function baselineInfo(
  label: BaselineLabel,
  snapshot: Snapshot,
  comparison: ComparisonResult | null,
  extra: { cutoffMs?: number; against?: string } = {}
): BaselineInfo {
  let summary: Record<Verdict, number> | null = null;
  if (comparison) {
    summary = { regressed: 0, improved: 0, unchanged: 0, insufficient: 0, new: 0, removed: 0, untracked: 0 };
    for (const k of comparison.keys) if (k.op === undefined) summary[k.verdict]++;
  }
  const info: BaselineInfo = {
    name: label.name,
    createdMs: label.createdMs,
    sourceKind: label.sourceKind,
    sourceLabel: label.sourceLabel,
    waiting: comparison === null,
    truncated: snapshot.truncated,
    summary,
    coverage: comparison?.coverage ?? null,
  };
  if (extra.cutoffMs !== undefined) info.cutoffMs = extra.cutoffMs;
  if (extra.against !== undefined) info.against = extra.against;
  return info;
}
