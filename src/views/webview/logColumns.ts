// Pure, framework-agnostic column registry for the logs table, shared by the extension host,
// the webview bundle, and unit tests. Must not import vscode, DOM, or uplot.

import { ATTR_COLUMN_PREFIX, isAttrColumn, parseAttrColumn } from './columnState';

export { ATTR_COLUMN_PREFIX, isAttrColumn, parseAttrColumn };

export type LogColumnGroup = 'core' | 'trace' | 'code' | 'attributes';

// Fixed column ids plus dynamic `attr:<key>` columns promoted from log attributes.
export type FixedLogColumnId =
  | 'select'
  | 'time'
  | 'observedTime'
  | 'level'
  | 'severityNumber'
  | 'message'
  | 'attributes'
  | 'traceId'
  | 'spanId'
  | 'scope'
  | 'codeLocation'
  | 'function';

export type LogColumnId = FixedLogColumnId | `attr:${string}`;

export interface LogColumnDef {
  id: LogColumnId;
  label: string;
  group: LogColumnGroup;
  defaultWidth: number;
  defaultVisible: boolean;
  sortable: boolean;
  minWidth: number;
}

export const MIN_COL_WIDTH = 60;
export const ATTR_KEY_LIMIT = 500;
export const ATTRS_SUMMARY_MAX = 512;
export const DEFAULT_ATTR_COLUMN_WIDTH = 160;

// Default widths for time/level/message/attributes match the pre-migration table exactly.
export const LOG_COLUMNS: LogColumnDef[] = [
  { id: 'select', label: 'Selection checkbox', group: 'core', defaultWidth: 32, defaultVisible: false, sortable: false, minWidth: 32 },
  { id: 'time', label: 'Time', group: 'core', defaultWidth: 200, defaultVisible: true, sortable: true, minWidth: MIN_COL_WIDTH },
  { id: 'observedTime', label: 'Observed Time', group: 'core', defaultWidth: 200, defaultVisible: false, sortable: true, minWidth: MIN_COL_WIDTH },
  { id: 'level', label: 'Level', group: 'core', defaultWidth: 70, defaultVisible: true, sortable: true, minWidth: MIN_COL_WIDTH },
  { id: 'severityNumber', label: 'Severity #', group: 'core', defaultWidth: 90, defaultVisible: false, sortable: true, minWidth: MIN_COL_WIDTH },
  { id: 'message', label: 'Message', group: 'core', defaultWidth: 480, defaultVisible: true, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'attributes', label: 'Attributes', group: 'core', defaultWidth: 360, defaultVisible: true, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'scope', label: 'Scope', group: 'core', defaultWidth: 160, defaultVisible: false, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'traceId', label: 'Trace ID', group: 'trace', defaultWidth: 180, defaultVisible: false, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'spanId', label: 'Span ID', group: 'trace', defaultWidth: 140, defaultVisible: false, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'codeLocation', label: 'Code Location', group: 'code', defaultWidth: 220, defaultVisible: false, sortable: false, minWidth: MIN_COL_WIDTH },
  { id: 'function', label: 'Function', group: 'code', defaultWidth: 160, defaultVisible: false, sortable: false, minWidth: MIN_COL_WIDTH },
];

export const GROUP_LABEL: Record<LogColumnGroup, string> = {
  core: 'Core fields',
  trace: 'Trace context',
  code: 'Code',
  attributes: 'Attributes',
};

export const GROUP_ORDER: LogColumnGroup[] = ['core', 'trace', 'code', 'attributes'];

const BY_ID = new Map<string, LogColumnDef>(LOG_COLUMNS.map((c) => [c.id, c]));

export function attrColumnId(key: string): LogColumnId {
  return `${ATTR_COLUMN_PREFIX}${key}`;
}

export function isLogColumnId(v: unknown): v is LogColumnId {
  if (typeof v !== 'string') return false;
  return BY_ID.has(v) || isAttrColumn(v);
}

export function columnDef(id: LogColumnId): LogColumnDef {
  const fixed = BY_ID.get(id);
  if (fixed) return fixed;
  const key = parseAttrColumn(id) ?? id;
  return {
    id,
    label: key,
    group: 'attributes',
    defaultWidth: DEFAULT_ATTR_COLUMN_WIDTH,
    defaultVisible: false,
    sortable: true,
    minWidth: MIN_COL_WIDTH,
  };
}

export function isSortable(id: LogColumnId): boolean {
  return columnDef(id).sortable;
}

export function columnLabel(id: LogColumnId): string {
  return columnDef(id).label;
}
