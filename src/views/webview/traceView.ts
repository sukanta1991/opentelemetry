// Pure view-model for the traces table: query input, wire rows, sorting, cell text and the
// persisted panel state. Shared by the extension host, the webview bundle and unit tests.

import { formatDuration } from '../format';
import * as cols from './columnState';
import {
  DEFAULT_TRACE_ATTR_WIDTH,
  TRACE_COLUMNS,
  TraceColumnId,
  isTraceColumnId,
  traceColumnDef,
} from './traceColumns';
import { DEFAULT_TIME_RANGE, TimeRangeKind, isTimeRangeKind } from './timeRange';

export const MAX_QUERY_LENGTH = 1000;
export const MAX_VISIBLE_ATTR_KEYS = 20;
const MAX_KEY_LENGTH = 256;

// --- Query input (controls + query bar) ------------------------------------------------

export const STATUS_OPTIONS = ['', 'error', 'ok', 'unset'] as const;
export type StatusFilter = (typeof STATUS_OPTIONS)[number];

export const KIND_OPTIONS = ['', 'server', 'client', 'internal', 'producer', 'consumer', 'unspecified'] as const;
export type KindFilter = (typeof KIND_OPTIONS)[number];

export interface TraceQueryInput {
  service: string;
  name: string;
  status: StatusFilter;
  kind: KindFilter;
  attr: string;
  minMs: number | null;
  maxMs: number | null;
  traceId: string;
  range: TimeRangeKind;
  query: string;
}

export function defaultQueryInput(): TraceQueryInput {
  return {
    service: '',
    name: '',
    status: '',
    kind: '',
    attr: '',
    minMs: null,
    maxMs: null,
    traceId: '',
    range: DEFAULT_TIME_RANGE,
    query: '',
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_QUERY_LENGTH) : '';
}

function duration(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// Also the host's validator for untrusted webview messages.
export function sanitizeQueryInput(raw: unknown): TraceQueryInput {
  const base = defaultQueryInput();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  return {
    service: str(r.service),
    name: str(r.name),
    status: (STATUS_OPTIONS as readonly unknown[]).includes(r.status) ? (r.status as StatusFilter) : '',
    kind: (KIND_OPTIONS as readonly unknown[]).includes(r.kind) ? (r.kind as KindFilter) : '',
    attr: str(r.attr),
    minMs: duration(r.minMs),
    maxMs: duration(r.maxMs),
    traceId: str(r.traceId),
    range: isTimeRangeKind(r.range) ? r.range : base.range,
    query: str(r.query),
  };
}

export function sanitizeAttrKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LENGTH || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_VISIBLE_ATTR_KEYS) break;
  }
  return out;
}

// --- Wire rows -----------------------------------------------------------------------

export interface TraceRow {
  traceId: string;
  rootName: string;
  rootService: string;
  startMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  services: string[];
  logCount?: number;
  rootAttrs?: Record<string, string>;
}

// --- Sorting ---------------------------------------------------------------------------

export type SortDir = 'asc' | 'desc';

export interface TraceSort {
  col: TraceColumnId;
  dir: SortDir;
}

export const DEFAULT_TRACE_SORT: TraceSort = { col: 'start', dir: 'desc' };

export function isTraceSort(v: unknown): v is TraceSort {
  if (!v || typeof v !== 'object') return false;
  const s = v as { col?: unknown; dir?: unknown };
  return isTraceColumnId(s.col) && (s.dir === 'asc' || s.dir === 'desc');
}

const DESC_FIRST = new Set<TraceColumnId>(['start', 'duration', 'spans', 'errors', 'logs', 'status']);

export function nextSortDir(current: TraceSort, col: TraceColumnId): TraceSort {
  if (current.col === col) return { col, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { col, dir: DESC_FIRST.has(col) ? 'desc' : 'asc' };
}

function sortValue(r: TraceRow, col: TraceColumnId): number | string {
  const key = cols.parseAttrColumn(col);
  if (key !== undefined) return r.rootAttrs?.[key] ?? '';
  switch (col) {
    case 'status':
    case 'errors':
      return r.errorCount;
    case 'start':
      return r.startMs;
    case 'duration':
      return r.durationMs;
    case 'spans':
      return r.spanCount;
    case 'logs':
      return r.logCount ?? 0;
    case 'root':
      return `${r.rootName}\u0000${r.rootService}`.toLowerCase();
    case 'services':
      return r.services.join(', ').toLowerCase();
    default:
      return r.traceId;
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const an = Number(a);
  const bn = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b));
}

export function compareTraces(a: TraceRow, b: TraceRow, sort: TraceSort): number {
  const d = compareValues(sortValue(a, sort.col), sortValue(b, sort.col));
  const signed = sort.dir === 'asc' ? d : -d;
  return signed || (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0);
}

export function sortTraces(rows: TraceRow[], sort: TraceSort): TraceRow[] {
  return rows.sort((a, b) => compareTraces(a, b, sort));
}

// --- Cell text -------------------------------------------------------------------------

export function traceCellText(r: TraceRow, col: TraceColumnId): string {
  const key = cols.parseAttrColumn(col);
  if (key !== undefined) return r.rootAttrs?.[key] ?? '';
  switch (col) {
    case 'status':
      return r.errorCount ? 'Error' : '';
    case 'root':
      return r.rootName;
    case 'traceId':
      return r.traceId;
    case 'start':
      return new Date(r.startMs).toISOString();
    case 'duration':
      return formatDuration(r.durationMs);
    case 'spans':
      return String(r.spanCount);
    case 'errors':
      return String(r.errorCount);
    case 'services':
      return r.services.join(', ');
    case 'logs':
      return r.logCount === undefined ? '' : String(r.logCount);
    default:
      return '';
  }
}

// --- Persisted panel state -------------------------------------------------------------

export type TraceColumnState = cols.ColumnState<TraceColumnId>;

export interface TracesPanelState {
  v: 1;
  columns: TraceColumnState[];
  sort: TraceSort;
  input: TraceQueryInput;
  showLogs: boolean;
}

export function defaultTraceColumns(): TraceColumnState[] {
  return TRACE_COLUMNS.map((c) => ({ id: c.id, visible: c.defaultVisible, width: c.defaultWidth }));
}

export function defaultTracesPanelState(): TracesPanelState {
  return {
    v: 1,
    columns: defaultTraceColumns(),
    sort: { ...DEFAULT_TRACE_SORT },
    input: defaultQueryInput(),
    showLogs: true,
  };
}

function loadColumns(raw: unknown): TraceColumnState[] {
  if (!Array.isArray(raw)) return defaultTraceColumns();
  const seen = new Set<string>();
  const out: TraceColumnState[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; visible?: unknown; width?: unknown };
    if (!isTraceColumnId(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    const def = traceColumnDef(e.id);
    const w = typeof e.width === 'number' && Number.isFinite(e.width) ? Math.round(e.width) : def.defaultWidth;
    out.push({ id: e.id, visible: e.visible === true, width: Math.max(def.minWidth, w) });
  }
  for (const def of TRACE_COLUMNS) {
    if (!seen.has(def.id)) out.push({ id: def.id, visible: def.defaultVisible, width: def.defaultWidth });
  }
  return out;
}

export function loadTracesPanelState(raw: unknown): TracesPanelState {
  const base = defaultTracesPanelState();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1) return base;
  return {
    v: 1,
    columns: loadColumns(s.columns),
    sort: isTraceSort(s.sort) ? { col: s.sort.col, dir: s.sort.dir } : base.sort,
    input: sanitizeQueryInput(s.input),
    showLogs: s.showLogs !== false,
  };
}

// --- Column reducers -------------------------------------------------------------------

export function setTraceColumnVisibility(
  columns: readonly TraceColumnState[],
  id: TraceColumnId,
  visible: boolean
): TraceColumnState[] {
  return cols.setColumnVisibility(columns, id, visible, DEFAULT_TRACE_ATTR_WIDTH);
}

export function setTraceColumnWidth(
  columns: readonly TraceColumnState[],
  id: TraceColumnId,
  width: number
): TraceColumnState[] {
  return cols.setColumnWidth(columns, id, width, traceColumnDef(id).minWidth);
}

export const moveTraceColumn: (
  columns: readonly TraceColumnState[],
  dragId: TraceColumnId,
  targetId: TraceColumnId,
  after: boolean
) => TraceColumnState[] = cols.moveColumn;

export function visibleAttrKeys(columns: readonly TraceColumnState[]): string[] {
  const out: string[] = [];
  for (const c of columns) {
    const k = c.visible ? cols.parseAttrColumn(c.id) : undefined;
    if (k) out.push(k);
  }
  return out.slice(0, MAX_VISIBLE_ATTR_KEYS);
}
