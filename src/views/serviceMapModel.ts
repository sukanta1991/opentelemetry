// SPDX-License-Identifier: Apache-2.0
// Live service map: windowed call stats per node/edge and drill-down details. No vscode import.

import { CodeLocation, KeyValueMap, Span } from '../store/model';
import type { KeyDelta, MapDelta } from './baselineCompare';
import { MapNode, NodeType, classifySpanTarget, svcId } from './serviceGraph';
import { quantileSorted } from './webview/stats';
import { TIME_RANGE_SECONDS, TimeRangeKind, windowBounds } from './webview/timeRange';

// Structurally the store's TaggedSpan; not imported so the webview bundle can import this module's types.
export interface TaggedSpan {
  span: Span;
  serviceName: string;
  instanceId: string;
}

export const MAX_NODES = 250;
export const SPARK_BUCKETS = 30;
// Below this, a per-minute rate is mostly noise.
const MIN_RATE_WINDOW_MS = 10_000;
// Fewer calls than this can be at most 'warn': one failure in two calls is not an outage.
export const MIN_SAMPLES_FOR_CRITICAL = 5;

export type Health = 'ok' | 'warn' | 'critical' | 'idle';

export interface ServiceMapThresholds {
  latencyWarnMs: number;
  latencyCriticalMs: number;
  errorRateWarn: number;
  errorRateCritical: number;
}

export const DEFAULT_THRESHOLDS: Readonly<ServiceMapThresholds> = Object.freeze({
  latencyWarnMs: 300,
  latencyCriticalMs: 1000,
  errorRateWarn: 0.01,
  errorRateCritical: 0.05,
});

export interface CallStats {
  count: number;
  errors: number;
  errorRate: number;
  p50: number | null;
  p95: number | null;
  ratePerMin?: number;
}

export interface NodeStats extends CallStats {
  lastSeenMs: number;
  spark: { count: number[]; errors: number[] };
}

export interface ModelNode extends MapNode {
  stats: NodeStats;
  health: Health;
  // Baseline mode only.
  cmp?: MapDelta;
  opChanges?: { regressed: number; improved: number };
  // Known only from the baseline: no calls in the current topology.
  ghost?: true;
}

export interface ModelEdge {
  source: string;
  target: string;
  stats: CallStats;
  health: Health;
  cmp?: MapDelta;
  opChanges?: { regressed: number; improved: number };
  ghost?: true;
}

export interface ServiceMapModel {
  range: TimeRangeKind;
  anchorMs: number;
  fromMs: number;
  // Baseline mode within the baseline's realm: only spans ending after this count.
  cutoffMs?: number;
  effectiveWindowMs: number;
  partial: boolean;
  hiddenNodes: number;
  nodes: ModelNode[];
  edges: ModelEdge[];
}

export interface ServiceMapOptions {
  range: TimeRangeKind;
  thresholds?: ServiceMapThresholds;
  buckets?: number;
  maxNodes?: number;
  // Collect per-operation stats (baseline mode).
  ops?: boolean;
  cutoffMs?: number;
}

export type MapSelection = { kind: 'node'; id: string } | { kind: 'edge'; source: string; target: string };

export interface TraceRef {
  traceId: string;
  spanId: string;
  instanceId: string;
  serviceName: string;
  name: string;
  startMs: number;
  durationMs: number;
  error: boolean;
}

export interface OperationStats extends CallStats {
  name: string;
  cmp?: KeyDelta;
}

export interface SourceRef {
  location: CodeLocation;
  count: number;
}

export interface NodeDetails {
  selection: MapSelection;
  inbound: ModelEdge[];
  outbound: ModelEdge[];
  operations: OperationStats[];
  errorTraces: TraceRef[];
  slowTraces: TraceRef[];
  sources: SourceRef[];
  instanceIds: string[];
  // Baseline mode: full deltas for the selected node or edge, and its example traces still in the store.
  cmp?: KeyDelta;
  baselineTraces?: string[];
}

export interface DetailCaps {
  operations: number;
  traces: number;
  sources: number;
}

export const DEFAULT_DETAIL_CAPS: DetailCaps = { operations: 10, traces: 5, sources: 10 };

const TYPE_ORDER: Record<NodeType, number> = { service: 0, database: 1, queue: 2, external: 3 };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const compareModelNodes = (a: MapNode, b: MapNode) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || cmp(a.id, b.id);
export const compareModelEdges = (a: ModelEdge, b: ModelEdge) => cmp(a.source, b.source) || cmp(a.target, b.target);

export const MAX_OPERATION_KEY_LENGTH = 200;

function attrText(attrs: KeyValueMap, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' ? v.trim() || undefined : undefined;
}

// Low-cardinality operation name: route or db operation before the span name, which may carry ids.
export function operationKey(span: Span): string {
  const a = span.attrs;
  let key: string | undefined;
  const route = attrText(a, 'http.route');
  if (route) {
    const method = attrText(a, 'http.request.method') ?? attrText(a, 'http.method');
    key = method ? `${method} ${route}` : route;
  } else {
    const op = attrText(a, 'db.operation.name') ?? attrText(a, 'db.operation');
    if (op) {
      const collection = attrText(a, 'db.collection.name') ?? attrText(a, 'db.sql.table');
      key = collection ? `${op} ${collection}` : op;
    }
  }
  key ??= span.name;
  return key.length > MAX_OPERATION_KEY_LENGTH ? key.slice(0, MAX_OPERATION_KEY_LENGTH) : key;
}

function threshold(v: unknown, fallback: number, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
}

// Settings are user input: bad values fall back to defaults and warn never exceeds critical.
export function sanitizeThresholds(raw: unknown): ServiceMapThresholds {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_THRESHOLDS;
  const latencyCriticalMs = threshold(r.latencyCriticalMs, d.latencyCriticalMs);
  const errorRateCritical = threshold(r.errorRateCritical, d.errorRateCritical, 1);
  return {
    latencyWarnMs: Math.min(threshold(r.latencyWarnMs, d.latencyWarnMs), latencyCriticalMs),
    latencyCriticalMs,
    errorRateWarn: Math.min(threshold(r.errorRateWarn, d.errorRateWarn, 1), errorRateCritical),
    errorRateCritical,
  };
}

// Worse of error rate and p95; boundaries count as breached.
export function classifyHealth(stats: CallStats, t: ServiceMapThresholds): Health {
  if (!stats.count) return 'idle';
  let level = 0;
  if (stats.errors > 0) {
    if (stats.errorRate >= t.errorRateCritical) level = 2;
    else if (stats.errorRate >= t.errorRateWarn) level = 1;
  }
  if (stats.p95 !== null) {
    if (stats.p95 >= t.latencyCriticalMs) level = 2;
    else if (stats.p95 >= t.latencyWarnMs) level = Math.max(level, 1);
  }
  if (stats.count < MIN_SAMPLES_FOR_CRITICAL) level = Math.min(level, 1);
  return level === 2 ? 'critical' : level === 1 ? 'warn' : 'ok';
}

export interface Prepared {
  // traceId -> spanId -> span; span ids are only unique within a trace.
  index: Map<string, Map<string, TaggedSpan>>;
  serviceNodes: Map<string, MapNode>;
  serviceNames: Set<string>;
  anchorMs: number;
  oldestMs: number;
}

export function prepare(tagged: readonly TaggedSpan[]): Prepared {
  const index = new Map<string, Map<string, TaggedSpan>>();
  const serviceNodes = new Map<string, MapNode>();
  let anchorMs = -Infinity;
  let oldestMs = Infinity;
  for (const t of tagged) {
    const { span, serviceName } = t;
    if (!serviceNodes.has(serviceName)) {
      serviceNodes.set(serviceName, { id: svcId(serviceName), label: serviceName, type: 'service' });
    }
    let byId = index.get(span.traceId);
    if (!byId) index.set(span.traceId, (byId = new Map()));
    byId.set(span.spanId, t);
    if (span.endMs > anchorMs) anchorMs = span.endMs;
    if (span.startMs < oldestMs) oldestMs = span.startMs;
  }
  return { index, serviceNodes, serviceNames: new Set(serviceNodes.keys()), anchorMs, oldestMs };
}

// `caller` is the span whose code issued the call: the parent for cross-service calls, else the span itself.
type CallVisitor = (
  source: string | undefined,
  target: MapNode,
  t: TaggedSpan,
  nodeMs: number,
  edgeMs: number,
  caller: TaggedSpan
) => void;

// Entry spans (no parent, or parent in another service) are calls into their service;
// spans that classify as db/queue/external are calls from their service to that node.
function visitCalls(tagged: readonly TaggedSpan[], p: Prepared, visit: CallVisitor): void {
  for (const t of tagged) {
    const { span, serviceName } = t;
    const self = p.serviceNodes.get(serviceName)!;
    const parent = span.parentSpanId ? p.index.get(span.traceId)?.get(span.parentSpanId) : undefined;
    if (!parent) {
      visit(undefined, self, t, span.durationMs, span.durationMs, t);
    } else if (parent.serviceName !== serviceName) {
      const callerSide = parent.span.kind === 'CLIENT' || parent.span.kind === 'PRODUCER';
      const edgeMs = callerSide ? parent.span.durationMs : span.durationMs;
      visit(p.serviceNodes.get(parent.serviceName)!.id, self, t, span.durationMs, edgeMs, parent);
    }
    const target = classifySpanTarget(span, p.serviceNames);
    if (target) visit(self.id, target, t, span.durationMs, span.durationMs, t);
  }
}

interface Window {
  startMs: number;
  effectiveWindowMs: number;
  partial: boolean;
  rateWindowMs?: number;
}

// A cut-off narrows the window on purpose, so it never marks the window partial.
function windowFor(range: TimeRangeKind, anchorMs: number, oldestMs: number, cutoffMs = -Infinity): Window {
  const rangeStartMs = Math.max(windowBounds(anchorMs, range)[0], oldestMs);
  const startMs = Math.max(rangeStartMs, cutoffMs);
  const effectiveWindowMs = Math.max(0, anchorMs - startMs);
  const windowed = range !== 'all' || cutoffMs > -Infinity;
  return {
    startMs,
    effectiveWindowMs,
    partial: range !== 'all' && anchorMs - rangeStartMs < TIME_RANGE_SECONDS[range] * 1000,
    rateWindowMs: windowed && effectiveWindowMs >= MIN_RATE_WINDOW_MS ? effectiveWindowMs : undefined,
  };
}

export interface CallAcc {
  count: number;
  errors: number;
  durations: number[];
  lastSeenMs: number;
  slowestMs: number;
  slowestTrace?: string;
  lastErrorMs: number;
  lastErrorTrace?: string;
}

const newAcc = (): CallAcc => ({ count: 0, errors: 0, durations: [], lastSeenMs: 0, slowestMs: -Infinity, lastErrorMs: -Infinity });

function record(acc: CallAcc, ms: number, error: boolean, t: TaggedSpan, inWindow: boolean): void {
  const { endMs, traceId } = t.span;
  if (endMs > acc.lastSeenMs) acc.lastSeenMs = endMs;
  if (!inWindow) return;
  acc.count++;
  if (error) {
    acc.errors++;
    if (endMs > acc.lastErrorMs) {
      acc.lastErrorMs = endMs;
      acc.lastErrorTrace = traceId;
    }
  }
  if (Number.isFinite(ms)) {
    acc.durations.push(ms);
    if (ms > acc.slowestMs) {
      acc.slowestMs = ms;
      acc.slowestTrace = traceId;
    }
  }
}

// Typed-array sort is numeric and native; the comparator form costs ~15% of buildServiceMap.
export const sortedDurations = (acc: CallAcc): Float64Array => Float64Array.from(acc.durations).sort();

function finish(acc: CallAcc, rateWindowMs: number | undefined): CallStats {
  const sorted = sortedDurations(acc);
  const stats: CallStats = {
    count: acc.count,
    errors: acc.errors,
    errorRate: acc.count ? acc.errors / acc.count : 0,
    p50: quantileSorted(sorted, 0.5),
    p95: quantileSorted(sorted, 0.95),
  };
  if (rateWindowMs !== undefined) stats.ratePerMin = acc.count / (rateWindowMs / 60_000);
  return stats;
}

function emptyModel(range: TimeRangeKind): ServiceMapModel {
  return { range, anchorMs: 0, fromMs: 0, effectiveWindowMs: 0, partial: false, hiddenNodes: 0, nodes: [], edges: [] };
}

export interface ScopeAcc {
  acc: CallAcc;
  // Operation name -> stats; only filled when collecting operations.
  ops: Map<string, CallAcc>;
}

export interface CollectedNode extends ScopeAcc {
  node: MapNode;
  spark?: { count: number[]; errors: number[] };
}

export interface Collected {
  nodes: Map<string, CollectedNode>;
  // source -> target -> stats, avoiding a composite string key per call.
  edges: Map<string, Map<string, ScopeAcc>>;
}

export interface CollectOptions {
  inWindow: (endMs: number) => boolean;
  ops?: boolean;
  onNodeCall?: (node: CollectedNode, endMs: number, error: boolean) => void;
}

const scopeAcc = (): ScopeAcc => ({ acc: newAcc(), ops: new Map() });

function opAcc(ops: Map<string, CallAcc>, name: string): CallAcc {
  let acc = ops.get(name);
  if (!acc) ops.set(name, (acc = newAcc()));
  return acc;
}

// Every call shapes the topology and lastSeenMs; only calls inWindow are counted.
export function collectCalls(tagged: readonly TaggedSpan[], p: Prepared, opts: CollectOptions): Collected {
  const nodes = new Map<string, CollectedNode>();
  const nodeAcc = (node: MapNode): CollectedNode => {
    let n = nodes.get(node.id);
    if (!n) nodes.set(node.id, (n = { node, ...scopeAcc() }));
    return n;
  };
  for (const node of p.serviceNodes.values()) nodeAcc(node);
  const edges = new Map<string, Map<string, ScopeAcc>>();
  const { inWindow: isIn, ops: withOps, onNodeCall } = opts;

  visitCalls(tagged, p, (source, target, t, nodeMs, edgeMs) => {
    const inWindow = isIn(t.span.endMs);
    const error = t.span.statusCode === 'ERROR';
    const n = nodeAcc(target);
    record(n.acc, nodeMs, error, t, inWindow);
    const op = withOps && inWindow ? operationKey(t.span) : undefined;
    if (op !== undefined) record(opAcc(n.ops, op), nodeMs, error, t, true);
    if (inWindow && onNodeCall) onNodeCall(n, t.span.endMs, error);
    if (source === undefined) return;
    let bySource = edges.get(source);
    if (!bySource) edges.set(source, (bySource = new Map()));
    let e = bySource.get(target.id);
    if (!e) bySource.set(target.id, (e = scopeAcc()));
    record(e.acc, edgeMs, error, t, inWindow);
    if (op !== undefined) record(opAcc(e.ops, op), edgeMs, error, t, true);
  });
  return { nodes, edges };
}

export function buildServiceMap(tagged: readonly TaggedSpan[], opts: ServiceMapOptions): ServiceMapModel {
  return buildServiceMapCollected(tagged, opts).model;
}

// Also returns the untrimmed collector result, so baseline mode compares in the same pass.
export function buildServiceMapCollected(
  tagged: readonly TaggedSpan[],
  opts: ServiceMapOptions
): { model: ServiceMapModel; collected: Collected } {
  const { range } = opts;
  if (!tagged.length) return { model: emptyModel(range), collected: { nodes: new Map(), edges: new Map() } };
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const buckets = Math.max(1, Math.floor(opts.buckets ?? SPARK_BUCKETS));
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const p = prepare(tagged);
  const cutoffMs = opts.cutoffMs;
  const w = windowFor(range, p.anchorMs, p.oldestMs, cutoffMs);
  const bucketMs = w.effectiveWindowMs / buckets;

  const newSpark = () => ({ count: new Array<number>(buckets).fill(0), errors: new Array<number>(buckets).fill(0) });
  const collected = collectCalls(tagged, p, {
    inWindow: cutoffMs === undefined ? (endMs) => endMs >= w.startMs : (endMs) => endMs >= w.startMs && endMs > cutoffMs,
    ops: opts.ops,
    onNodeCall: (n, endMs, error) => {
      const b = bucketMs > 0 ? Math.min(buckets - 1, Math.max(0, Math.floor((endMs - w.startMs) / bucketMs))) : buckets - 1;
      const spark = (n.spark ??= newSpark());
      spark.count[b]++;
      if (error) spark.errors[b]++;
    },
  });
  const { nodes, edges } = collected;

  const visible = new Set(nodes.keys());
  if (visible.size > maxNodes) {
    const droppable = [...nodes.values()]
      .filter((n) => n.node.type !== 'service')
      .sort((a, b) => a.acc.count - b.acc.count || a.acc.lastSeenMs - b.acc.lastSeenMs || cmp(a.node.id, b.node.id));
    for (const n of droppable) {
      if (visible.size <= maxNodes) break;
      visible.delete(n.node.id);
    }
  }

  const outNodes: ModelNode[] = [...nodes.values()]
    .filter((n) => visible.has(n.node.id))
    .map(({ node, acc, spark }) => {
      const stats = { ...finish(acc, w.rateWindowMs), lastSeenMs: acc.lastSeenMs, spark: spark ?? newSpark() };
      return { ...node, stats, health: classifyHealth(stats, thresholds) };
    })
    .sort(compareModelNodes);

  const outEdges: ModelEdge[] = [];
  for (const [source, byTarget] of edges) {
    if (!visible.has(source)) continue;
    for (const [target, { acc }] of byTarget) {
      if (!visible.has(target)) continue;
      const stats = finish(acc, w.rateWindowMs);
      outEdges.push({ source, target, stats, health: classifyHealth(stats, thresholds) });
    }
  }
  outEdges.sort(compareModelEdges);

  const model: ServiceMapModel = {
    range,
    anchorMs: p.anchorMs,
    fromMs: w.startMs,
    effectiveWindowMs: w.effectiveWindowMs,
    partial: w.partial,
    hiddenNodes: nodes.size - visible.size,
    nodes: outNodes,
    edges: outEdges,
  };
  if (cutoffMs !== undefined) model.cutoffMs = cutoffMs;
  return { model, collected };
}

interface Candidate {
  t: TaggedSpan;
  ms: number;
  error: boolean;
}

function traceRefs(candidates: Candidate[], cap: number): TraceRef[] {
  const seen = new Set<string>();
  const out: TraceRef[] = [];
  for (const { t, ms, error } of candidates) {
    if (out.length >= cap) break;
    if (seen.has(t.span.traceId)) continue;
    seen.add(t.span.traceId);
    out.push({
      traceId: t.span.traceId,
      spanId: t.span.spanId,
      instanceId: t.instanceId,
      serviceName: t.serviceName,
      name: t.span.name,
      startMs: t.span.startMs,
      durationMs: ms,
      error,
    });
  }
  return out;
}

function addSource(sources: Map<string, SourceRef>, loc: CodeLocation | undefined): void {
  if (!loc) return;
  const key = `${loc.filepath}\u0000${loc.line ?? ''}`;
  const s = sources.get(key);
  if (s) s.count++;
  else sources.set(key, { location: loc, count: 1 });
}

// Pass the same spans the model was built from; returns undefined if the selection is not in the model.
export function buildNodeDetails(
  tagged: readonly TaggedSpan[],
  model: ServiceMapModel,
  selection: MapSelection,
  caps: DetailCaps = DEFAULT_DETAIL_CAPS
): NodeDetails | undefined {
  const node = selection.kind === 'node' ? model.nodes.find((n) => n.id === selection.id) : undefined;
  if (selection.kind === 'node' && !node) return undefined;
  if (
    selection.kind === 'edge' &&
    !model.edges.some((e) => e.source === selection.source && e.target === selection.target)
  ) {
    return undefined;
  }

  const p = prepare(tagged);
  const ops = new Map<string, CallAcc>();
  const candidates: Candidate[] = [];
  const sources = new Map<string, SourceRef>();
  const service = node?.type === 'service' ? node.label : undefined;
  const cutoffMs = model.cutoffMs ?? -Infinity;
  const inWindow = (endMs: number) => endMs >= model.fromMs && endMs > cutoffMs;

  visitCalls(tagged, p, (source, target, t, nodeMs, edgeMs, caller) => {
    if (!inWindow(t.span.endMs)) return;
    let ms: number;
    if (selection.kind === 'node') {
      if (target.id !== selection.id) return;
      ms = nodeMs;
    } else {
      if (source !== selection.source || target.id !== selection.target) return;
      ms = edgeMs;
    }
    const error = t.span.statusCode === 'ERROR';
    record(opAcc(ops, operationKey(t.span)), ms, error, t, true);
    candidates.push({ t, ms, error });
    if (!service) addSource(sources, caller.span.codeLocation);
  });

  const instanceIds = new Set<string>();
  if (service) {
    for (const t of tagged) {
      if (t.serviceName !== service) continue;
      instanceIds.add(t.instanceId);
      if (inWindow(t.span.endMs)) addSource(sources, t.span.codeLocation);
    }
  }

  const operations = [...ops]
    .map(([name, acc]) => ({ name, ...finish(acc, undefined) }))
    .sort((a, b) => b.count - a.count || cmp(a.name, b.name))
    .slice(0, caps.operations);
  const errorTraces = traceRefs(
    candidates.filter((c) => c.error).sort((a, b) => b.t.span.endMs - a.t.span.endMs),
    caps.traces
  );
  const slowTraces = traceRefs([...candidates].sort((a, b) => b.ms - a.ms), caps.traces);
  const sourceList = [...sources.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        cmp(a.location.filepath, b.location.filepath) ||
        (a.location.line ?? 0) - (b.location.line ?? 0)
    )
    .slice(0, caps.sources);

  const id = selection.kind === 'node' ? selection.id : undefined;
  return {
    selection,
    inbound: id ? model.edges.filter((e) => e.target === id) : [],
    outbound: id ? model.edges.filter((e) => e.source === id) : [],
    operations,
    errorTraces,
    slowTraces,
    sources: sourceList,
    instanceIds: [...instanceIds].sort(cmp),
  };
}
