// Column registry for the traces table. Pure: no vscode or DOM imports.

import { AttrColumnId, isAttrColumn, parseAttrColumn } from './columnState';

export type FixedTraceColumnId =
  | 'status'
  | 'root'
  | 'traceId'
  | 'start'
  | 'duration'
  | 'spans'
  | 'errors'
  | 'services'
  | 'logs';

export type TraceColumnId = FixedTraceColumnId | AttrColumnId;

export type TraceColumnGroup = 'core' | 'attributes';

export interface TraceColumnDef {
  id: TraceColumnId;
  label: string;
  group: TraceColumnGroup;
  defaultWidth: number;
  defaultVisible: boolean;
  sortable: boolean;
  minWidth: number;
  numeric: boolean;
}

export const TRACE_MIN_COL_WIDTH = 50;
export const DEFAULT_TRACE_ATTR_WIDTH = 160;
export const ROOT_ATTR_KEY_LIMIT = 200;

const col = (
  id: FixedTraceColumnId,
  label: string,
  defaultWidth: number,
  defaultVisible: boolean,
  numeric = false
): TraceColumnDef => ({
  id,
  label,
  group: 'core',
  defaultWidth,
  defaultVisible,
  sortable: true,
  minWidth: TRACE_MIN_COL_WIDTH,
  numeric,
});

export const TRACE_COLUMNS: TraceColumnDef[] = [
  col('status', 'Status', 80, true, true),
  col('root', 'Root span', 320, true),
  col('traceId', 'Trace ID', 160, true),
  col('start', 'Start', 200, true, true),
  col('duration', 'Duration', 100, true, true),
  col('spans', 'Spans', 70, true, true),
  col('errors', 'Errors', 70, false, true),
  col('services', 'Services', 220, true),
  col('logs', 'Logs', 70, false, true),
];

export const TRACE_GROUP_LABEL: Record<TraceColumnGroup, string> = {
  core: 'Trace fields',
  attributes: 'Root span attributes',
};

const BY_ID = new Map<string, TraceColumnDef>(TRACE_COLUMNS.map((c) => [c.id, c]));

export function isTraceColumnId(v: unknown): v is TraceColumnId {
  return typeof v === 'string' && (BY_ID.has(v) || isAttrColumn(v));
}

export function traceColumnDef(id: TraceColumnId): TraceColumnDef {
  const fixed = BY_ID.get(id);
  if (fixed) return fixed;
  return {
    id,
    label: parseAttrColumn(id) ?? id,
    group: 'attributes',
    defaultWidth: DEFAULT_TRACE_ATTR_WIDTH,
    defaultVisible: false,
    sortable: true,
    minWidth: TRACE_MIN_COL_WIDTH,
    numeric: false,
  };
}
