// SPDX-License-Identifier: Apache-2.0
// Service map view helpers: formatting, geometry, persisted state and message types. Pure: no vscode or DOM.

import type { DeltaMetric, MapDelta, MetricDelta, Verdict } from '../baselineCompare';
import type { BaselineInfo, ColorMode } from '../baselineMap';
import type { CallStats, Health, MapSelection, ModelNode, NodeDetails, ServiceMapModel } from '../serviceMapModel';
import type { NodeBox } from './serviceMapLayout';
import { DEFAULT_TIME_RANGE, TimeRangeKind, isTimeRangeKind } from './timeRange';

// Host -> webview. `seq` changes with every posted update; index-based actions echo it back.
export type HostMessage =
  | {
      type: 'update';
      seq: number;
      model: ServiceMapModel;
      details: NodeDetails | null;
      colorMode: ColorMode;
      baseline: BaselineInfo | null;
      // A baseline is active, so the colour-mode toggle applies even while `baseline` is null.
      hasBaseline: boolean;
      // Baseline-vs-baseline map: no spans behind it, so no range, drill-down or capture.
      readOnly: boolean;
    }
  | { type: 'gone' }
  | { type: 'error'; message: string }
  | { type: 'timeZone'; useLocalTime: boolean };

export type OpenTarget = 'traces' | 'logs' | 'metrics';
export type TraceList = 'error' | 'slow' | 'baseline';

// Webview -> host. Trace, source and bucket actions are indexes into what update `seq` carried.
export type ViewMessage =
  | { type: 'ready'; range: TimeRangeKind; selection: MapSelection | null; colorMode?: ColorMode }
  | { type: 'setRange'; range: TimeRangeKind }
  | { type: 'select'; selection: MapSelection | null }
  | { type: 'setColorMode'; colorMode: ColorMode }
  | { type: 'baselineMenu' }
  | { type: 'captureAtBucket'; seq: number; index: number }
  | { type: 'open'; target: OpenTarget }
  | { type: 'revealTrace'; seq: number; list: TraceList; index: number }
  | { type: 'openSource'; seq: number; index: number };

export const isColorMode = (v: unknown): v is ColorMode => v === 'absolute' || v === 'baseline';

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

// Glyphs differ from the health ones so the two modes are never confused.
export const VERDICT_GLYPH: Record<Verdict, string> = {
  regressed: '⬆',
  improved: '⬇',
  unchanged: '●',
  insufficient: '?',
  new: '✚',
  removed: '⊖',
  untracked: '◌',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  regressed: 'Regressed',
  improved: 'Improved',
  unchanged: 'No significant change',
  insufficient: 'Too few calls to compare',
  new: 'New since baseline',
  removed: 'Not seen since baseline',
  untracked: 'Not tracked by the baseline',
};

const SHORT: Partial<Record<Verdict, string>> = { new: 'new', removed: 'not seen', insufficient: 'n too small', untracked: 'untracked' };
const METRIC_MARK: Partial<Record<DeltaMetric, string>> = { errorRate: 'errors', fanout: 'calls/req' };

// "+42%" / "−12%"; empty when there is no meaningful base.
export function signedPercent(base: number | null, current: number | null): string {
  if (base === null || current === null || base <= 0) return '';
  const pct = ((current - base) / base) * 100;
  const r = Math.abs(pct) < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
  if (r === 0) return '±0%';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}%`;
}

// Map label for a node or edge in baseline mode, e.g. "p95 120 ms (+42%) · errors".
export function deltaLabel(d: MapDelta): string {
  const short = SHORT[d.verdict];
  if (short) return short;
  const [base, current] = d.p95;
  const pct = signedPercent(base, current);
  const marks = (d.changed ?? []).map((m) => METRIC_MARK[m]).filter((m): m is string => !!m);
  return [`p95 ${formatMs(current)}${pct ? ` (${pct})` : ''}`, ...marks].join(' · ');
}

export function opChangesText(c: { regressed: number; improved: number } | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.regressed) parts.push(`${c.regressed} op${c.regressed === 1 ? '' : 's'} ${VERDICT_GLYPH.regressed}`);
  if (c.improved) parts.push(`${c.improved} op${c.improved === 1 ? '' : 's'} ${VERDICT_GLYPH.improved}`);
  return parts.join(' ');
}

// Nodes are sized for their name, so the subtitle stays short: "936 ms +297% · err · 1⬆".
export function nodeDeltaSubtitle(node: ModelNode): string {
  const d = node.cmp;
  if (!d) return nodeSubtitle(node.stats);
  const parts = [SHORT[d.verdict] ?? `${formatMs(d.p95[1])} ${signedPercent(d.p95[0], d.p95[1])}`.trim()];
  if (!SHORT[d.verdict]) {
    if (d.changed?.includes('errorRate')) parts.push('err');
    if (d.changed?.includes('fanout')) parts.push('calls');
  }
  const c = node.opChanges;
  if (c?.regressed) parts.push(`${c.regressed}${VERDICT_GLYPH.regressed}`);
  if (c?.improved) parts.push(`${c.improved}${VERDICT_GLYPH.improved}`);
  return parts.join(' · ');
}

export function deltaAriaLabel(name: string, kind: string, d: MapDelta, opChanges?: { regressed: number; improved: number }): string {
  const [base, current] = d.p95;
  const parts = [name, kind, VERDICT_LABEL[d.verdict], `p95 ${formatMs(base)} before, ${formatMs(current)} now`];
  for (const m of d.changed ?? []) if (METRIC_MARK[m]) parts.push(`${METRIC_MARK[m]} changed`);
  const ops = opChanges && (opChanges.regressed || opChanges.improved);
  if (ops) parts.push(`${opChanges!.regressed} operations regressed, ${opChanges!.improved} improved`);
  return parts.join(', ');
}

// Sidebar row: "12 ms → 18 ms (+50%)"; error rates move in percentage points.
export function metricDeltaText(m: MetricDelta, kind: 'ms' | 'rate' | 'ratio'): string {
  if (kind === 'rate') {
    const fmt = (v: number | null) => (v === null ? '–' : formatPercent(v));
    const pp = m.delta === null ? '' : ` (${m.delta >= 0 ? '+' : '−'}${trim1(Math.abs(m.delta * 100))} pp)`;
    return `${fmt(m.base)} → ${fmt(m.current)}${pp}`;
  }
  const fmt = kind === 'ms' ? formatMs : (v: number | null) => (v === null ? '–' : trim1(v));
  const pct = signedPercent(m.base, m.current);
  return `${fmt(m.base)} → ${fmt(m.current)}${pct ? ` (${pct})` : ''}`;
}

// Capturing "up to" a sparkline bucket includes the whole bucket.
export function bucketEndMs(model: ServiceMapModel, index: number): number {
  const buckets = model.nodes[0]?.stats.spark.count.length || 1;
  return model.fromMs + ((index + 1) * model.effectiveWindowMs) / buckets;
}

const SOURCE_TEXT: Record<BaselineInfo['sourceKind'], string> = {
  window: 'map window',
  mark: 'mark',
  time: 'time cut-off',
  session: 'session',
  file: 'file',
};

// Toolbar badge for the active comparison; `time` formats a clock time in the user's zone.
export function baselineBadge(b: BaselineInfo, time: (ms: number) => string): { text: string; title: string } {
  const lines = [`Baseline “${b.name}”: ${SOURCE_TEXT[b.sourceKind]}${b.sourceLabel ? ` (${b.sourceLabel})` : ''}, captured ${time(b.createdMs)}.`];
  if (b.cutoffMs !== undefined) lines.push(`Comparing calls that ended after ${time(b.cutoffMs)}.`);
  if (b.truncated) lines.push('The baseline hit its size limit, so some quiet calls were left out and show as “not tracked”.');
  let text: string;
  if (b.against) text = `“${b.name}” → “${b.against}”`;
  else if (b.waiting) text = `vs “${b.name}” · waiting${b.cutoffMs !== undefined ? ` for calls after ${time(b.cutoffMs)}` : ''}`;
  else text = `vs “${b.name}”${b.cutoffMs !== undefined ? ` · since ${time(b.cutoffMs)}` : ''}`;
  if (b.summary && (b.summary.regressed || b.summary.improved)) {
    text += ` · ${VERDICT_GLYPH.regressed}${b.summary.regressed} ${VERDICT_GLYPH.improved}${b.summary.improved}`;
    lines.push(`${b.summary.regressed} services or calls regressed, ${b.summary.improved} improved.`);
  }
  return { text, title: lines.join(' ') };
}

export function coverageNote(b: BaselineInfo): { text: string; title: string } | undefined {
  const c = b.coverage;
  if (!c?.warn) return undefined;
  const pct = Math.round(c.ratio * 100);
  return {
    text: `⚠ ${pct}% not in baseline`,
    title:
      `${c.missingFromBase} of ${c.currentNodes} services and dependencies with calls now are missing from the baseline, ` +
      'so it may be from a different setup. Capture a new one if the comparison looks off (threshold: otel.serviceMap.baseline.coverageWarnPct).',
  };
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
  // Only once the user picked one; the host chooses otherwise.
  colorMode?: ColorMode;
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
  const out: MapViewState = {
    range: isTimeRangeKind(r.range) ? r.range : DEFAULT_TIME_RANGE,
    selection: parseSelection(r.selection),
    view,
  };
  if (isColorMode(r.colorMode)) out.colorMode = r.colorMode;
  return out;
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
  readOnly?: boolean;
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
  const live = !ctx.readOnly;
  switch (msg.type) {
    case 'ready': {
      const ready: ViewMessage = {
        type: 'ready',
        range: isTimeRangeKind(msg.range) ? msg.range : DEFAULT_TIME_RANGE,
        selection: parseSelection(msg.selection),
      };
      if (isColorMode(msg.colorMode)) ready.colorMode = msg.colorMode;
      return ready;
    }
    case 'setRange':
      return live && isTimeRangeKind(msg.range) ? { type: 'setRange', range: msg.range } : undefined;
    case 'select': {
      if (msg.selection === null) return { type: 'select', selection: null };
      const selection = parseSelection(msg.selection);
      return selection && inModel(ctx.model, selection) ? { type: 'select', selection } : undefined;
    }
    case 'setColorMode':
      return isColorMode(msg.colorMode) ? { type: 'setColorMode', colorMode: msg.colorMode } : undefined;
    case 'baselineMenu':
      return { type: 'baselineMenu' };
    case 'captureAtBucket': {
      if (!live || msg.seq !== ctx.seq || !ctx.model) return undefined;
      const i = index(msg.index, ctx.model.nodes[0]?.stats.spark.count.length ?? 0);
      return i === undefined ? undefined : { type: 'captureAtBucket', seq: ctx.seq, index: i };
    }
    case 'open': {
      const sel = ctx.selection;
      const node = sel?.kind === 'node' ? ctx.model?.nodes.find((n) => n.id === sel.id) : undefined;
      const target = OPEN_TARGETS.find((t) => t === msg.target);
      return live && target && node?.type === 'service' && !node.ghost ? { type: 'open', target } : undefined;
    }
    case 'revealTrace': {
      if (msg.seq !== ctx.seq || !ctx.details) return undefined;
      let length: number;
      if (msg.list === 'baseline') length = ctx.details.baselineTraces?.length ?? 0;
      else if (live && msg.list === 'error') length = ctx.details.errorTraces.length;
      else if (live && msg.list === 'slow') length = ctx.details.slowTraces.length;
      else return undefined;
      const i = index(msg.index, length);
      return i === undefined ? undefined : { type: 'revealTrace', seq: ctx.seq, list: msg.list, index: i };
    }
    case 'openSource': {
      if (!live || msg.seq !== ctx.seq || !ctx.details) return undefined;
      const i = index(msg.index, ctx.details.sources.length);
      return i === undefined ? undefined : { type: 'openSource', seq: ctx.seq, index: i };
    }
    default:
      return undefined;
  }
}
