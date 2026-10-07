// SPDX-License-Identifier: Apache-2.0
// Service map view helpers: formatting, geometry, persisted state and message types. Pure: no vscode or DOM.

import type { CallStats, Health, MapSelection, ModelNode, NodeDetails, ServiceMapModel } from '../serviceMapModel';
import type { NodeBox } from './serviceMapLayout';
import { DEFAULT_TIME_RANGE, TimeRangeKind, isTimeRangeKind } from './timeRange';

// Host -> webview. `seq` changes with every posted update; index-based actions echo it back.
export type HostMessage =
  | { type: 'update'; seq: number; model: ServiceMapModel; details: NodeDetails | null }
  | { type: 'gone' }
  | { type: 'error'; message: string }
  | { type: 'timeZone'; useLocalTime: boolean };

export type OpenTarget = 'traces' | 'logs' | 'metrics';
export type TraceList = 'error' | 'slow';

// Webview -> host. Trace and source actions are indexes into the details of update `seq`.
export type ViewMessage =
  | { type: 'ready'; range: TimeRangeKind; selection: MapSelection | null }
  | { type: 'setRange'; range: TimeRangeKind }
  | { type: 'select'; selection: MapSelection | null }
  | { type: 'open'; target: OpenTarget }
  | { type: 'revealTrace'; seq: number; list: TraceList; index: number }
  | { type: 'openSource'; seq: number; index: number };

export const HEALTH_GLYPH: Record<Health, string> = { ok: '●', warn: '▲', critical: '✖', idle: '○' };
export const HEALTH_LABEL: Record<Health, string> = { ok: 'Healthy', warn: 'Warning', critical: 'Critical', idle: 'Idle' };

const trim1 = (n: number) => n.toFixed(1).replace(/\.0$/, '');

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatRate(perMin: number): string {
  if (perMin >= 10) return `${formatCount(perMin)} req/min`;
  if (perMin >= 1) return `${trim1(perMin)} req/min`;
  return `${perMin.toFixed(2)} req/min`;
}

export function formatCalls(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'call' : 'calls'}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–';
  if (ms < 10) return `${trim1(ms)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim1(ms / 1000)} s`;
  return `${trim1(ms / 60_000)} min`;
}

export function formatPercent(rate: number): string {
  const pct = rate * 100;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${trim1(pct)}%`;
  return `${Math.round(pct)}%`;
}

// Rate when the window allows one, else the call count; error share appended when non-zero.
export function edgeLabel(stats: CallStats): string {
  const volume = stats.ratePerMin !== undefined ? formatRate(stats.ratePerMin) : formatCalls(stats.count);
  return stats.errors ? `${volume} · ${formatPercent(stats.errorRate)} err` : volume;
}

export function nodeSubtitle(stats: CallStats): string {
  if (!stats.count) return 'no calls';
  return `${formatMs(stats.p95)} · ${formatPercent(stats.errorRate)}`;
}

export function nodeAriaLabel(node: ModelNode): string {
  const s = node.stats;
  const parts = [node.label, node.type, HEALTH_LABEL[node.health], formatCalls(s.count)];
  if (s.count) parts.push(`p95 ${formatMs(s.p95)}`, `${formatPercent(s.errorRate)} errors`);
  return parts.join(', ');
}

export function truncateLabel(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  return maxChars <= 1 ? '…' : `${label.slice(0, maxChars - 1)}…`;
}

// Log scale so one hot edge doesn't make every other edge hairline.
export function edgeWidth(count: number, maxCount: number): number {
  if (maxCount <= 0 || count <= 0) return 1;
  return 1 + 3 * (Math.log1p(count) / Math.log1p(maxCount));
}

export function sparklinePath(values: readonly number[], width: number, height: number): string {
  if (!values.length) return '';
  const max = Math.max(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => (max > 0 ? height - (v / max) * height : height);
  const pts = values.map((v, i) => `${+(i * step).toFixed(2)},${+y(v).toFixed(2)}`);
  if (values.length === 1) pts.push(`${width},${+y(values[0]).toFixed(2)}`);
  return `M${pts.join('L')}`;
}

export interface EdgeGeometry {
  d: string;
  labelX: number;
  labelY: number;
}

// Downward edges run bottom-centre to top-centre; back edges loop out to the right so they never overlap.
// Labels sit at t=0.7, near the target, so labels of edges fanning out from one node don't stack.
export function edgePath(a: NodeBox, b: NodeBox, back: boolean): EdgeGeometry {
  let sx: number, sy: number, ex: number, ey: number, c1x: number, c1y: number, c2x: number, c2y: number;
  if (!back && b.y > a.y) {
    [sx, sy, ex, ey] = [a.x, a.y + a.height / 2, b.x, b.y - b.height / 2];
    const dy = (ey - sy) / 2;
    [c1x, c1y, c2x, c2y] = [sx, sy + dy, ex, ey - dy];
  } else {
    [sx, sy, ex, ey] = [a.x + a.width / 2, a.y, b.x + b.width / 2, b.y];
    const bulge = 40 + Math.abs(ey - sy) * 0.25;
    [c1x, c1y, c2x, c2y] = [sx + bulge, sy, ex + bulge, ey];
  }
  const r = (n: number) => +n.toFixed(2);
  const t = 0.7;
  const [k0, k1, k2, k3] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
  return {
    d: `M${r(sx)},${r(sy)} C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(ex)},${r(ey)}`,
    labelX: r(k0 * sx + k1 * c1x + k2 * c2x + k3 * ex),
    labelY: r(k0 * sy + k1 * c1y + k2 * c2y + k3 * ey),
  };
}

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2;
export const LABEL_MIN_SCALE = 0.6;
const FIT_PADDING = 16;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// Never enlarges past 1:1, so a small graph keeps its natural size.
export function fitTransform(contentW: number, contentH: number, viewW: number, viewH: number): ViewTransform {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return { scale: 1, tx: 0, ty: 0 };
  const scale = clampScale(
    Math.min(1, (viewW - 2 * FIT_PADDING) / contentW, (viewH - 2 * FIT_PADDING) / contentH)
  );
  return { scale, tx: (viewW - contentW * scale) / 2, ty: Math.max(0, (viewH - contentH * scale) / 2) };
}

// Zooms by `factor` keeping the screen point (px, py) fixed.
export function zoomAt(t: ViewTransform, factor: number, px: number, py: number): ViewTransform {
  const scale = clampScale(t.scale * factor);
  const k = scale / t.scale;
  return { scale, tx: px - (px - t.tx) * k, ty: py - (py - t.ty) * k };
}

export function centerOn(t: ViewTransform, x: number, y: number, viewW: number, viewH: number): ViewTransform {
  return { scale: t.scale, tx: viewW / 2 - x * t.scale, ty: viewH / 2 - y * t.scale };
}

export interface MapViewState {
  range: TimeRangeKind;
  selection: MapSelection | null;
  view: ViewTransform | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseSelection(v: unknown): MapSelection | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (s.kind === 'node' && isStr(s.id)) return { kind: 'node', id: s.id };
  if (s.kind === 'edge' && isStr(s.source) && isStr(s.target)) return { kind: 'edge', source: s.source, target: s.target };
  return null;
}

export function loadMapState(raw: unknown): MapViewState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const v = r.view && typeof r.view === 'object' ? (r.view as Record<string, unknown>) : undefined;
  const view =
    v && isNum(v.scale) && isNum(v.tx) && isNum(v.ty) ? { scale: clampScale(v.scale), tx: v.tx, ty: v.ty } : null;
  return {
    range: isTimeRangeKind(r.range) ? r.range : DEFAULT_TIME_RANGE,
    selection: parseSelection(r.selection),
    view,
  };
}

export function sameSelection(a: MapSelection | null, b: MapSelection | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'node' && b.kind === 'node') return a.id === b.id;
  if (a.kind === 'edge' && b.kind === 'edge') return a.source === b.source && a.target === b.target;
  return false;
}

export function basename(filepath: string): string {
  return filepath.split(/[\\/]/).pop() || filepath;
}

// What the host last posted; webview messages are only honoured against it.
export interface HostContext {
  seq: number;
  model: ServiceMapModel | null;
  details: NodeDetails | null;
  selection: MapSelection | null;
}

const OPEN_TARGETS: readonly OpenTarget[] = ['traces', 'logs', 'metrics'];

function inModel(model: ServiceMapModel | null, sel: MapSelection): boolean {
  if (!model) return false;
  if (sel.kind === 'node') return model.nodes.some((n) => n.id === sel.id);
  return model.edges.some((e) => e.source === sel.source && e.target === sel.target);
}

function index(v: unknown, length: number): number | undefined {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < length ? (v as number) : undefined;
}

// Validates an untrusted webview message; returns undefined for anything malformed, stale or out of range.
export function parseMapMessage(m: unknown, ctx: HostContext): ViewMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return {
        type: 'ready',
        range: isTimeRangeKind(msg.range) ? msg.range : DEFAULT_TIME_RANGE,
        selection: parseSelection(msg.selection),
      };
    case 'setRange':
      return isTimeRangeKind(msg.range) ? { type: 'setRange', range: msg.range } : undefined;
    case 'select': {
      if (msg.selection === null) return { type: 'select', selection: null };
      const selection = parseSelection(msg.selection);
      return selection && inModel(ctx.model, selection) ? { type: 'select', selection } : undefined;
    }
    case 'open': {
      const sel = ctx.selection;
      const node = sel?.kind === 'node' ? ctx.model?.nodes.find((n) => n.id === sel.id) : undefined;
      const target = OPEN_TARGETS.find((t) => t === msg.target);
      return target && node?.type === 'service' ? { type: 'open', target } : undefined;
    }
    case 'revealTrace': {
      if (msg.seq !== ctx.seq || !ctx.details || (msg.list !== 'error' && msg.list !== 'slow')) return undefined;
      const list = msg.list === 'error' ? ctx.details.errorTraces : ctx.details.slowTraces;
      const i = index(msg.index, list.length);
      return i === undefined ? undefined : { type: 'revealTrace', seq: ctx.seq, list: msg.list, index: i };
    }
    case 'openSource': {
      if (msg.seq !== ctx.seq || !ctx.details) return undefined;
      const i = index(msg.index, ctx.details.sources.length);
      return i === undefined ? undefined : { type: 'openSource', seq: ctx.seq, index: i };
    }
    default:
      return undefined;
  }
}
