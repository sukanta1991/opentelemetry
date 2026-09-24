// Generic column-state reducers shared by the logs and traces tables. Pure: no vscode or DOM.

export interface ColumnState<Id extends string = string> {
  id: Id;
  visible: boolean;
  width: number;
}

export const ATTR_COLUMN_PREFIX = 'attr:';

export type AttrColumnId = `attr:${string}`;

export function attrColumnId(key: string): AttrColumnId {
  return `${ATTR_COLUMN_PREFIX}${key}`;
}

// Attribute keys may themselves contain ':', so only the first separator is consumed.
export function parseAttrColumn(id: string): string | undefined {
  return id.startsWith(ATTR_COLUMN_PREFIX) ? id.slice(ATTR_COLUMN_PREFIX.length) : undefined;
}

export function isAttrColumn(id: string): boolean {
  return id.startsWith(ATTR_COLUMN_PREFIX) && id.length > ATTR_COLUMN_PREFIX.length;
}

// A column absent from the list is appended; this is how `attr:<key>` columns are created.
export function setColumnVisibility<Id extends string>(
  columns: readonly ColumnState<Id>[],
  id: Id,
  visible: boolean,
  width: number
): ColumnState<Id>[] {
  const next = columns.map((c) => (c.id === id ? { ...c, visible } : c));
  if (!next.some((c) => c.id === id) && visible) next.push({ id, visible: true, width });
  return next;
}

export function setColumnWidth<Id extends string>(
  columns: readonly ColumnState<Id>[],
  id: Id,
  width: number,
  minWidth: number
): ColumnState<Id>[] {
  return columns.map((c) => (c.id === id ? { ...c, width: Math.max(minWidth, Math.round(width)) } : c));
}

export function moveColumn<Id extends string>(
  columns: readonly ColumnState<Id>[],
  dragId: Id,
  targetId: Id,
  after: boolean
): ColumnState<Id>[] {
  const next = columns.slice();
  if (dragId === targetId) return next;
  const from = next.findIndex((c) => c.id === dragId);
  if (from < 0) return next;
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((c) => c.id === targetId);
  if (to < 0) return columns.slice();
  next.splice(after ? to + 1 : to, 0, moved);
  return next;
}
