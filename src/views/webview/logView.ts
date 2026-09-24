// Pure view-model helpers for the logs table: density, time range, sorting, cell text, and
// the persisted panel state. Shared by the extension host, the webview bundle, and unit tests.
// Must not import vscode, DOM, or uplot.

import { AttributeValue, StoredLogRecord } from '../../store/model';
import { severityLabel } from '../format';
import * as cols from './columnState';
import {
  ATTRS_SUMMARY_MAX,
  ATTR_KEY_LIMIT,
  DEFAULT_ATTR_COLUMN_WIDTH,
  LOG_COLUMNS,
  LogColumnId,
  MIN_COL_WIDTH,
  columnDef,
  isAttrColumn,
  isLogColumnId,
  parseAttrColumn,
} from './logColumns';
import {
  DEFAULT_TIME_RANGE,
  TIME_RANGE_LABEL,
  TIME_RANGE_OPTIONS,
  TIME_RANGE_SECONDS,
  TimeRangeKind,
  isTimeRangeKind,
  windowBounds,
} from './timeRange';

// The record shape posted to the webview. Identical to what the store holds, so the host
// can forward records without reshaping them.
export type WireLog = StoredLogRecord;

// --- Row density -----------------------------------------------------------------------

export type LogDensity = 'raw' | 'one' | 'two' | 'condensed';

export const DENSITY_OPTIONS: LogDensity[] = ['raw', 'one', 'two', 'condensed'];

export const DENSITY_LABEL: Record<LogDensity, string> = {
  raw: 'Rows: Raw',
  one: 'Rows: 1 line',
  two: 'Rows: 2 lines',
  condensed: 'Rows: Condensed',
};

// Max rendered lines per cell; `raw` wraps without limit.
export const DENSITY_LINE_CLAMP: Record<LogDensity, number> = {
  raw: 0,
  one: 1,
  two: 2,
  condensed: 4,
};

export const DEFAULT_DENSITY: LogDensity = 'raw';

export function isLogDensity(v: unknown): v is LogDensity {
  return typeof v === 'string' && v in DENSITY_LABEL;
}

// --- Time range ------------------------------------------------------------------------

export type LogRangeKind = TimeRangeKind;
export const LOG_RANGE_OPTIONS = TIME_RANGE_OPTIONS;
export const LOG_RANGE_SECONDS = TIME_RANGE_SECONDS;
export const LOG_RANGE_LABEL: Record<LogRangeKind, string> = { ...TIME_RANGE_LABEL, all: 'All logs' };
export const DEFAULT_LOG_RANGE: LogRangeKind = DEFAULT_TIME_RANGE;
export const isLogRangeKind = isTimeRangeKind;
export { windowBounds };

export function logTimeMs(l: WireLog): number {
  return l.timeMs || l.observedTimeMs || 0;
}

// --- Sorting ---------------------------------------------------------------------------

export type SortDir = 'asc' | 'desc';

export interface LogSort {
  col: LogColumnId;
  dir: SortDir;
}

export const DEFAULT_SORT: LogSort = { col: 'time', dir: 'desc' };

export function isLogSort(v: unknown): v is LogSort {
  if (!v || typeof v !== 'object') return false;
  const s = v as { col?: unknown; dir?: unknown };
  return isLogColumnId(s.col) && (s.dir === 'asc' || s.dir === 'desc');
}

// Time-like columns start newest-first; everything else starts ascending.
export function nextSortDir(current: LogSort, col: LogColumnId): LogSort {
  if (current.col === col) return { col, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  const descFirst = col === 'time' || col === 'observedTime' || col === 'severityNumber' || col === 'level';
  return { col, dir: descFirst ? 'desc' : 'asc' };
}

// Ordering across mixed attribute value types: numbers, then strings, then booleans, then
// structured values. Absent keys always sort last, independent of direction.
function typeRank(v: AttributeValue): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function compareAttrValues(a: AttributeValue, b: AttributeValue): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return stringifyValue(a).localeCompare(stringifyValue(b));
}

function rawCompare(a: WireLog, b: WireLog, col: LogColumnId): number {
  switch (col) {
    case 'time':
      return logTimeMs(a) - logTimeMs(b);
    case 'observedTime':
      return (a.observedTimeMs ?? a.timeMs ?? 0) - (b.observedTimeMs ?? b.timeMs ?? 0);
    case 'level':
    case 'severityNumber':
      return a.severityNumber - b.severityNumber;
    default:
      return 0;
  }
}

export function compareLogs(a: WireLog, b: WireLog, sort: LogSort): number {
  const flip = sort.dir === 'asc' ? 1 : -1;

  if (isAttrColumn(sort.col)) {
    const key = parseAttrColumn(sort.col) as string;
    const av = a.attrs[key];
    const bv = b.attrs[key];
    const aMissing = av === undefined;
    const bMissing = bv === undefined;
    if (aMissing || bMissing) {
      if (!aMissing) return -1;
      if (!bMissing) return 1;
      return flip * (a.seq - b.seq);
    }
    const d = compareAttrValues(av, bv);
    if (d !== 0) return flip * d;
    return flip * (a.seq - b.seq);
  }

  const d = rawCompare(a, b, sort.col);
  if (d !== 0) return flip * d;
  return flip * (a.seq - b.seq);
}

// --- Cell text -------------------------------------------------------------------------

export function stringifyValue(v: AttributeValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function renderBody(body: AttributeValue): string {
  return stringifyValue(body);
}

export function summarizeAttrs(
  attrs: Record<string, AttributeValue>,
  max = ATTRS_SUMMARY_MAX
): string {
  const keys = Object.keys(attrs);
  if (!keys.length) return '';
  let out = '';
  for (const k of keys) {
    if (out.length >= max) break;
    if (out) out += '  ';
    out += `${k}=${stringifyValue(attrs[k])}`;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function formatCodeLocation(l: WireLog): string {
  const loc = l.codeLocation;
  if (!loc) return '';
  return loc.line ? `${loc.filepath}:${loc.line}` : loc.filepath;
}

// The display string for one cell. Also used as the CSV value for that column.
export function cellText(l: WireLog, col: LogColumnId): string {
  const key = parseAttrColumn(col);
  if (key !== undefined) return stringifyValue(l.attrs[key]);
  switch (col) {
    case 'time':
      return new Date(logTimeMs(l)).toISOString();
    case 'observedTime':
      return l.observedTimeMs ? new Date(l.observedTimeMs).toISOString() : '';
    case 'level':
      return l.severityText || severityLabel(l.severityNumber);
    case 'severityNumber':
      return String(l.severityNumber);
    case 'message':
      return renderBody(l.body);
    case 'attributes':
      return summarizeAttrs(l.attrs);
    case 'traceId':
      return l.traceId ?? '';
    case 'spanId':
      return l.spanId ?? '';
    case 'scope':
      return l.scope ?? '';
    case 'codeLocation':
      return formatCodeLocation(l);
    case 'function':
      return l.codeLocation?.function ?? '';
    default:
      return '';
  }
}

export function severityClass(n: number): string {
  if (n >= 21) return 'sev-fatal';
  if (n >= 17) return 'sev-error';
  if (n >= 13) return 'sev-warn';
  return '';
}

// --- Level filter ----------------------------------------------------------------------

export const LEVEL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'All levels' },
  { value: 1, label: 'Trace+' },
  { value: 5, label: 'Debug+' },
  { value: 9, label: 'Info+' },
  { value: 13, label: 'Warn+' },
  { value: 17, label: 'Error+' },
];

// --- Filter pipeline -------------------------------------------------------------------

export interface LogFilter {
  query: string;
  level: number;
  attrFilter: string;
  range: LogRangeKind;
  // Exact-match correlation; while either is set the time range is ignored.
  traceId?: string;
  spanId?: string;
}

export interface LogHaystack {
  hay: string;
  attrs: string;
}

export function logHaystack(l: WireLog): LogHaystack {
  const attrs = summarizeAttrs(l.attrs).toLowerCase();
  const msg = cellText(l, 'message').toLowerCase();
  const sev = cellText(l, 'level').toLowerCase();
  return { hay: `${msg}\u0000${attrs}\u0000${sev}`, attrs };
}

export function newestTime(logs: readonly WireLog[]): number {
  let newest = 0;
  for (const l of logs) {
    const t = logTimeMs(l);
    if (t > newest) newest = t;
  }
  return newest;
}

// Records can arrive out of order, so the oldest is a scan rather than logs[0].
export function oldestTime(logs: readonly WireLog[]): number {
  let oldest = Infinity;
  for (const l of logs) {
    const t = logTimeMs(l);
    if (t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

// Only true once records have actually been dropped: a short history on a freshly started
// app is not a retention problem.
export function needsMoreRetention(
  logs: readonly WireLog[],
  range: LogRangeKind,
  evicted: boolean
): boolean {
  if (!evicted || !logs.length) return false;
  const [from] = windowBounds(newestTime(logs), range);
  if (from === -Infinity) return false;
  return oldestTime(logs) > from;
}

// `haystack` is injectable so the webview can pass a per-record memoised resolver.
export function filterLogs(
  logs: readonly WireLog[],
  f: LogFilter,
  haystack: (l: WireLog) => LogHaystack = logHaystack,
  newestTimeMs: number = newestTime(logs)
): WireLog[] {
  const text = f.query.toLowerCase();
  const a = f.attrFilter.trim().toLowerCase();
  const correlating = !!(f.traceId || f.spanId);
  const from = correlating ? -Infinity : windowBounds(newestTimeMs, f.range)[0];
  const out: WireLog[] = [];
  for (const l of logs) {
    if (f.traceId && l.traceId !== f.traceId) continue;
    if (f.spanId && l.spanId !== f.spanId) continue;
    if (l.severityNumber < f.level) continue;
    if (from > -Infinity && logTimeMs(l) < from) continue;
    if (text || a) {
      const h = haystack(l);
      if (text && !h.hay.includes(text)) continue;
      if (a && !h.attrs.includes(a)) continue;
    }
    out.push(l);
  }
  return out;
}

export function sortLogs(rows: WireLog[], sort: LogSort): WireLog[] {
  return rows.sort((x, y) => compareLogs(x, y, sort));
}

// --- Selection helpers (pure) -----------------------------------------------------------

// Inclusive range between two rows in current view order; either end may be missing if the
// anchor scrolled out of the filtered set.
export function rangeSelection(
  rows: readonly WireLog[],
  fromSeq: number,
  toSeq: number
): number[] {
  const a = rows.findIndex((l) => l.seq === fromSeq);
  const b = rows.findIndex((l) => l.seq === toSeq);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(rows[i].seq);
  return out;
}

// Drops selected rows the store no longer retains. `live` is anything key-addressable, so a
// Map of records works as well as a Set of ids.
export function pruneSelection(
  selection: Set<number>,
  live: { has(seq: number): boolean }
): Set<number> {
  for (const seq of selection) if (!live.has(seq)) selection.delete(seq);
  return selection;
}

// --- Persisted panel state -------------------------------------------------------------

export type LogColumnState = cols.ColumnState<LogColumnId>;

export interface LogsPanelState {
  v: 2;
  columns: LogColumnState[];
  density: LogDensity;
  range: LogRangeKind;
  sort: LogSort;
  query: string;
  level: number;
  attrFilter: string;
}

export function defaultColumnState(): LogColumnState[] {
  return LOG_COLUMNS.map((c) => ({ id: c.id, visible: c.defaultVisible, width: c.defaultWidth }));
}

// --- Column reducers (pure) ------------------------------------------------------------

export function setColumnVisibility(
  columns: readonly LogColumnState[],
  id: LogColumnId,
  visible: boolean,
  width = DEFAULT_ATTR_COLUMN_WIDTH
): LogColumnState[] {
  return cols.setColumnVisibility(columns, id, visible, width);
}

export function setColumnWidth(
  columns: readonly LogColumnState[],
  id: LogColumnId,
  width: number
): LogColumnState[] {
  return cols.setColumnWidth(columns, id, width, columnDef(id).minWidth);
}

export const moveColumn: (
  columns: readonly LogColumnState[],
  dragId: LogColumnId,
  targetId: LogColumnId,
  after: boolean
) => LogColumnState[] = cols.moveColumn;

// Bounded so a high-cardinality producer cannot flood the column picker.
export function collectAttrKeys(
  into: Set<string>,
  l: WireLog,
  limit = ATTR_KEY_LIMIT
): Set<string> {
  if (into.size >= limit) return into;
  for (const k of Object.keys(l.attrs)) {
    into.add(k);
    if (into.size >= limit) break;
  }
  return into;
}

export function defaultLogsPanelState(): LogsPanelState {
  return {
    v: 2,
    columns: defaultColumnState(),
    density: DEFAULT_DENSITY,
    range: DEFAULT_LOG_RANGE,
    sort: { ...DEFAULT_SORT },
    query: '',
    level: 0,
    attrFilter: '',
  };
}

function clampWidth(id: LogColumnId, w: unknown): number {
  const def = columnDef(id);
  if (typeof w !== 'number' || !Number.isFinite(w)) return def.defaultWidth;
  return Math.max(def.minWidth ?? MIN_COL_WIDTH, Math.round(w));
}

// v1 persisted only `{ colWidths: { 'col-msg', 'col-attrs' } }` from the pre-bundle panel.
function migrateV1(raw: Record<string, unknown>, base: LogsPanelState): LogsPanelState {
  const widths = raw.colWidths;
  if (!widths || typeof widths !== 'object') return base;
  const map = widths as Record<string, unknown>;
  const byOldId: Record<string, LogColumnId> = {
    'col-time': 'time',
    'col-level': 'level',
    'col-msg': 'message',
    'col-attrs': 'attributes',
  };
  for (const [oldId, id] of Object.entries(byOldId)) {
    const w = map[oldId];
    if (typeof w !== 'number') continue;
    const col = base.columns.find((c) => c.id === id);
    if (col) col.width = clampWidth(id, w);
  }
  return base;
}

function loadColumns(raw: unknown): LogColumnState[] {
  if (!Array.isArray(raw)) return defaultColumnState();
  const seen = new Set<string>();
  const out: LogColumnState[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; visible?: unknown; width?: unknown };
    if (!isLogColumnId(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      visible: e.visible === true,
      width: clampWidth(e.id, e.width),
    });
  }
  // Columns added in a later version are appended with their defaults.
  for (const def of LOG_COLUMNS) {
    if (seen.has(def.id)) continue;
    out.push({ id: def.id, visible: def.defaultVisible, width: def.defaultWidth });
  }
  return out.length ? out : defaultColumnState();
}

export function loadLogsPanelState(raw: unknown): LogsPanelState {
  const base = defaultLogsPanelState();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Record<string, unknown>;

  if (s.v !== 2) return migrateV1(s, base);

  return {
    v: 2,
    columns: loadColumns(s.columns),
    density: isLogDensity(s.density) ? s.density : base.density,
    range: isLogRangeKind(s.range) ? s.range : base.range,
    sort: isLogSort(s.sort) ? { col: s.sort.col, dir: s.sort.dir } : base.sort,
    query: typeof s.query === 'string' ? s.query : '',
    level: typeof s.level === 'number' && Number.isFinite(s.level) ? s.level : 0,
    attrFilter: typeof s.attrFilter === 'string' ? s.attrFilter : '',
  };
}
