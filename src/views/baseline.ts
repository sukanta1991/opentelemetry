// SPDX-License-Identifier: Apache-2.0
// Baseline snapshots: frozen per-node, per-edge and per-operation call stats for later comparison. No vscode import.

import { NodeType } from './serviceGraph';
import { CallAcc, ScopeAcc, TaggedSpan, collectCalls, prepare, sortedDurations } from './serviceMapModel';
import { quantileSorted } from './webview/stats';

export type SnapshotSourceKind = 'window' | 'mark' | 'time' | 'session' | 'file';

export interface SnapshotSource {
  kind: SnapshotSourceKind;
  label: string;
  realm: string;
  // Covers spans with fromMs <= endMs <= toMs; toMs is the cut-off when comparing within the same realm.
  fromMs: number;
  toMs: number;
}

export interface SnapshotNode {
  id: string;
  label: string;
  type: NodeType;
}

// Node: target only. Edge: source + target. Operations add `op` to either.
export interface SnapshotEntry {
  source?: string;
  target: string;
  op?: string;
  count: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  // Sorted ascending, at most one point per evenly spaced quantile when thinned.
  samples: number[];
  exemplars: string[];
  opsTruncated?: boolean;
}

export interface Snapshot {
  source: SnapshotSource;
  nodes: SnapshotNode[];
  entries: SnapshotEntry[];
  // Some node or edge entries were dropped by the key cap.
  truncated: boolean;
}

export interface SnapshotCaps {
  opsPerScope: number;
  keys: number;
  samplesPerKey: number;
  totalSamples: number;
  minSamplesPerKey: number;
}

export const DEFAULT_SNAPSHOT_CAPS: Readonly<SnapshotCaps> = Object.freeze({
  opsPerScope: 50,
  keys: 2000,
  samplesPerKey: 1000,
  totalSamples: 200_000,
  minSamplesPerKey: 100,
});

export interface CaptureRequest {
  kind: SnapshotSourceKind;
  label: string;
  realm: string;
  fromMs?: number;
  toMs?: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

// Evenly spaced quantiles keep the distribution's shape deterministically, unlike random reservoir sampling.
export function thinSamples(sorted: Float64Array, cap: number): number[] {
  if (sorted.length <= cap) return Array.from(sorted, round2);
  const n = Math.max(2, cap);
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = round2(quantileSorted(sorted, k / (n - 1))!);
  return out;
}

interface Pending {
  source?: string;
  target: string;
  op?: string;
  acc: CallAcc;
  scope?: Pending;
  opsTruncated?: boolean;
}

function scopeEntries(scopes: Pending[], target: string, s: ScopeAcc, source: string | undefined, opsPerScope: number, ops: Pending[]): void {
  if (!s.acc.count) return;
  const scope: Pending = { source, target, acc: s.acc };
  scopes.push(scope);
  const sorted = [...s.ops].sort(([an, a], [bn, b]) => b.count - a.count || cmp(an, bn));
  if (sorted.length > opsPerScope) scope.opsTruncated = true;
  for (const [op, acc] of sorted.slice(0, opsPerScope)) ops.push({ source, target, op, acc, scope });
}

const byCount = (a: Pending, b: Pending) =>
  b.acc.count - a.acc.count || cmp(a.source ?? '', b.source ?? '') || cmp(a.target, b.target) || cmp(a.op ?? '', b.op ?? '');

function entryOrder(a: SnapshotEntry, b: SnapshotEntry): number {
  return (
    cmp(a.source ?? '', b.source ?? '') ||
    cmp(a.target, b.target) ||
    (a.op === undefined ? (b.op === undefined ? 0 : -1) : b.op === undefined ? 1 : cmp(a.op, b.op))
  );
}

export function captureSnapshot(tagged: readonly TaggedSpan[], req: CaptureRequest, caps: SnapshotCaps = DEFAULT_SNAPSHOT_CAPS): Snapshot {
  const source: SnapshotSource = { kind: req.kind, label: req.label, realm: req.realm, fromMs: 0, toMs: 0 };
  if (!tagged.length) return { source, nodes: [], entries: [], truncated: false };
  const p = prepare(tagged);
  const fromMs = Math.max(req.fromMs ?? -Infinity, p.oldestMs);
  const toMs = Math.min(req.toMs ?? Infinity, p.anchorMs);
  source.fromMs = fromMs;
  source.toMs = toMs;
  const { nodes, edges } = collectCalls(tagged, p, { inWindow: (endMs) => endMs >= fromMs && endMs <= toMs, ops: true });

  const scopes: Pending[] = [];
  const ops: Pending[] = [];
  for (const [id, n] of nodes) scopeEntries(scopes, id, n, undefined, caps.opsPerScope, ops);
  for (const [src, byTarget] of edges) {
    for (const [target, s] of byTarget) scopeEntries(scopes, target, s, src, caps.opsPerScope, ops);
  }

  scopes.sort(byCount);
  const truncated = scopes.length > caps.keys;
  const keptScopes = new Set(scopes.slice(0, caps.keys));
  const opBudget = Math.max(0, caps.keys - keptScopes.size);
  const keptOps: Pending[] = [];
  for (const op of ops.filter((o) => keptScopes.has(o.scope!)).sort(byCount)) {
    if (keptOps.length < opBudget) keptOps.push(op);
    else op.scope!.opsTruncated = true;
  }

  const kept = [...keptScopes, ...keptOps];
  const perKey = Math.min(caps.samplesPerKey, Math.max(caps.minSamplesPerKey, Math.floor(caps.totalSamples / kept.length)));
  const entries = kept.map((k): SnapshotEntry => {
    const sorted = sortedDurations(k.acc);
    const entry: SnapshotEntry = {
      target: k.target,
      count: k.acc.count,
      errors: k.acc.errors,
      p50: quantileSorted(sorted, 0.5),
      p95: quantileSorted(sorted, 0.95),
      samples: thinSamples(sorted, perKey),
      exemplars: [...new Set([k.acc.slowestTrace, k.acc.lastErrorTrace])].filter((t): t is string => t !== undefined),
    };
    if (k.source !== undefined) entry.source = k.source;
    if (k.op !== undefined) entry.op = k.op;
    if (k.opsTruncated) entry.opsTruncated = true;
    return entry;
  });
  entries.sort(entryOrder);

  const ids = new Set<string>();
  for (const e of entries) {
    ids.add(e.target);
    if (e.source !== undefined) ids.add(e.source);
  }
  const snapshotNodes = [...ids]
    .sort(cmp)
    .map((id): SnapshotNode => {
      const { label, type } = nodes.get(id)!.node;
      return { id, label, type };
    });
  return { source, nodes: snapshotNodes, entries, truncated };
}
