// Logs table webview app. Owns all DOM work for the logs panel; every value that reaches the
// DOM goes through esc(). Pure view logic lives in logColumns.ts / logView.ts.

import {
  ATTR_KEY_LIMIT,
  GROUP_LABEL,
  GROUP_ORDER,
  LOG_COLUMNS,
  LogColumnGroup,
  LogColumnId,
  attrColumnId,
  columnDef,
  isSortable,
  parseAttrColumn,
} from './logColumns';
import {
  DENSITY_LABEL,
  DENSITY_LINE_CLAMP,
  DENSITY_OPTIONS,
  LEVEL_OPTIONS,
  LOG_RANGE_LABEL,
  LOG_RANGE_OPTIONS,
  LogColumnState,
  LogDensity,
  LogHaystack,
  LogRangeKind,
  LogsPanelState,
  WireLog,
  cellText,
  collectAttrKeys,
  defaultColumnState,
  filterLogs,
  isLogDensity,
  isLogRangeKind,
  loadLogsPanelState,
  logHaystack,
  moveColumn,
  needsMoreRetention,
  newestTime,
  nextSortDir,
  oldestTime,
  pruneSelection as prune,
  rangeSelection,
  setColumnVisibility,
  setColumnWidth,
  severityClass,
  sortLogs,
} from './logView';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const OVERSCAN = 8;
const DEFAULT_ROW_HEIGHT = 24;

const state: LogsPanelState = loadLogsPanelState(vscode.getState());

// All retained records, ascending by seq (the order the host sends them in).
let logs: WireLog[] = [];
const bySeq = new Map<number, WireLog>();

// Multi-selection; `focused` is the row Navigate/Open act on, `anchor` seeds Shift+click ranges.
const selection = new Set<number>();
let focusedSeq = -1;
let anchorSeq = -1;

// True once the host reports that the ring buffer has dropped records.
let evicted = false;

// While paused the view is frozen and incoming records queue here instead.
let paused = false;
let pending: WireLog[] = [];
let pendingOldestSeq = -1;
const PENDING_LIMIT = 20000;

// The current view: filtered + sorted, with prefix offsets for virtualization.
let filtered: WireLog[] = [];
let offsets: number[] = [0];
let indexBySeq = new Map<number, number>();
let winStart = 0;
let winEnd = 0;
let estimate = DEFAULT_ROW_HEIGHT;

const rowsEl = document.querySelector<HTMLDivElement>('.rows') as HTMLDivElement;
const tableEl = rowsEl.querySelector('table') as HTMLTableElement;
const tbody = byId<HTMLTableSectionElement>('tbody');
const colgroup = byId<HTMLTableColElement>('cols');
const head = byId<HTMLTableRowElement>('head');
const empty = byId<HTMLDivElement>('empty');
const q = byId<HTMLInputElement>('q');
const level = byId<HTMLSelectElement>('level');
const attr = byId<HTMLInputElement>('attr');
const count = byId<HTMLSpanElement>('count');
const range = byId<HTMLSelectElement>('range');
const density = byId<HTMLSelectElement>('density');
const retentionHint = byId<HTMLDivElement>('retentionHint');
const hintText = byId<HTMLSpanElement>('hintText');
const hintBtn = byId<HTMLButtonElement>('hintBtn');
const pauseBtn = byId<HTMLButtonElement>('pause');
const roBadge = byId<HTMLSpanElement>('roBadge');
const exportBtn = byId<HTMLButtonElement>('exportBtn');
const exportBackdrop = byId<HTMLDivElement>('exportBackdrop');
const exportDialog = byId<HTMLDivElement>('exportDialog');
const exDataGroup = byId<HTMLFieldSetElement>('exDataGroup');
const exDataNote = byId<HTMLParagraphElement>('exDataNote');
const exCountGroup = byId<HTMLFieldSetElement>('exCountGroup');
const exCount = byId<HTMLInputElement>('exCount');
const exScopeSelected = byId<HTMLInputElement>('exScopeSelected');
const exSummary = byId<HTMLParagraphElement>('exSummary');
const exCancel = byId<HTMLButtonElement>('exCancel');
const exGo = byId<HTMLButtonElement>('exGo');
const columnsBtn = byId<HTMLButtonElement>('columnsBtn');
const columnsPanel = byId<HTMLDivElement>('columnsPanel');
const colSearch = byId<HTMLInputElement>('colSearch');
const colReset = byId<HTMLButtonElement>('colReset');
const colList = byId<HTMLDivElement>('colList');

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function persist(): void {
  vscode.setState(state);
}

function visibleColumns(): LogColumnState[] {
  return state.columns.filter((c) => c.visible);
}

// --- Search index --------------------------------------------------------------------
// Filtering runs on every keystroke, so each record's haystack is built once.

const searchIndex = new Map<number, LogHaystack>();

// Attribute keys seen so far, capped so a high-cardinality producer cannot flood the picker.
const attrKeys = new Set<string>();

function searchRow(l: WireLog): LogHaystack {
  let row = searchIndex.get(l.seq);
  if (!row) {
    row = logHaystack(l);
    searchIndex.set(l.seq, row);
  }
  return row;
}

// --- Header --------------------------------------------------------------------------

function buildHead(): void {
  const cols = visibleColumns();
  colgroup.innerHTML = cols.map((c) => `<col data-col="${esc(c.id)}" />`).join('');
  head.innerHTML = cols
    .map((c) => {
      if (c.id === 'select') {
        return '<th data-col="select" class="selcol"><input type="checkbox" id="selAll" aria-label="Select all filtered rows" /></th>';
      }
      const def = columnDef(c.id);
      const sortable = isSortable(c.id);
      const active = state.sort.col === c.id;
      const ind = active ? `<span class="sort-ind">${state.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
      const aria = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return (
        `<th data-col="${esc(c.id)}"${sortable ? ' class="sortable" aria-sort="' + aria + '"' : ''}>` +
        `${esc(def.label)}${ind}<span class="col-resizer" data-col="${esc(c.id)}" title="Drag to resize, double-click to fit"></span></th>`
      );
    })
    .join('');
  layoutColumns();
}

// Widths are authoritative in state; the last column absorbs any leftover viewport width so
// the table never leaves a ragged gap, and the table overflows (scrolls) when it is too wide.
function layoutColumns(): void {
  const cols = visibleColumns();
  if (!cols.length) return;
  const sum = cols.reduce((n, c) => n + c.width, 0);
  const avail = rowsEl.clientWidth;
  const slack = Math.max(0, avail - sum);
  const els = colgroup.querySelectorAll<HTMLElement>('col');
  cols.forEach((c, i) => {
    const el = els[i];
    if (el) el.style.width = `${c.width + (i === cols.length - 1 ? slack : 0)}px`;
  });
  tableEl.style.width = `${Math.max(sum, avail)}px`;
}

// --- Rows ----------------------------------------------------------------------------

function cellHtml(l: WireLog, id: LogColumnId): string {
  if (id === 'select') {
    const on = selection.has(l.seq) ? ' checked' : '';
    return `<td class="selcol"><input type="checkbox" data-sel="${l.seq}" aria-label="Select row"${on} /></td>`;
  }
  const text = esc(cellText(l, id));
  if (parseAttrColumn(id) !== undefined) return `<td class="attrs"><div class="clamp">${text}</div></td>`;
  switch (id) {
    case 'time':
    case 'observedTime':
      return `<td class="time muted">${text}</td>`;
    case 'level':
      return `<td class="sev ${severityClass(l.severityNumber)}">${text}</td>`;
    case 'message':
      return (
        `<td class="msg"><div class="clamp">${text}` +
        `${l.codeLocation ? ' <span class="muted">[code]</span>' : ''}</div></td>`
      );
    case 'attributes':
      return `<td class="attrs"><div class="clamp">${text}</div></td>`;
    default:
      return `<td class="plain">${text}</td>`;
  }
}

// --- Virtualization ------------------------------------------------------------------
// Rows are windowed with spacer <tr>s so the table keeps its fixed layout and sticky head.
// Clamped density modes have a uniform height; `raw` wraps, so heights are measured on
// render and cached by seq.

const heightBySeq = new Map<number, number>();

function isFixedHeight(): boolean {
  return state.density !== 'raw';
}

function rowHeight(l: WireLog): number {
  if (isFixedHeight()) return estimate;
  return heightBySeq.get(l.seq) ?? estimate;
}

function rebuildOffsets(): void {
  const n = filtered.length;
  offsets = new Array(n + 1);
  indexBySeq = new Map();
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    indexBySeq.set(filtered[i].seq, i);
    offsets[i + 1] = offsets[i] + rowHeight(filtered[i]);
  }
}

// Largest i such that offsets[i] <= y.
function indexAt(y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface Anchor {
  seq: number;
  delta: number;
}

function captureAnchor(): Anchor | null {
  if (rowsEl.scrollTop <= 0 || !filtered.length) return null;
  const i = Math.min(indexAt(rowsEl.scrollTop), filtered.length - 1);
  return { seq: filtered[i].seq, delta: rowsEl.scrollTop - offsets[i] };
}

function restoreAnchor(a: Anchor | null): void {
  if (!a) return;
  const i = indexBySeq.get(a.seq);
  if (i === undefined) return;
  rowsEl.scrollTop = offsets[i] + a.delta;
}

function spacer(height: number, span: number): string {
  return height > 0
    ? `<tr class="spacer" aria-hidden="true"><td colspan="${span}" style="height:${height}px"></td></tr>`
    : '';
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paint(): void {
  const cols = visibleColumns();
  const span = Math.max(1, cols.length);
  const total = offsets[filtered.length];
  const viewH = rowsEl.clientHeight || 400;
  const top = rowsEl.scrollTop;

  const start = Math.max(0, indexAt(top) - OVERSCAN);
  const end = Math.min(filtered.length, indexAt(top + viewH) + 1 + OVERSCAN);
  winStart = start;
  winEnd = end;

  const html: string[] = [spacer(offsets[start], span)];
  for (let i = start; i < end; i++) {
    const l = filtered[i];
    const cls =
      'selectable' +
      (selection.has(l.seq) ? ' selected' : '') +
      (l.seq === focusedSeq ? ' focused' : '');
    html.push(`<tr class="${cls}" data-seq="${l.seq}">`);
    for (const c of cols) html.push(cellHtml(l, c.id));
    html.push('</tr>');
  }
  html.push(spacer(total - offsets[end], span));
  tbody.innerHTML = sanitizeHtml(html.join(''));

  measureRendered(start, end);
}

// Corrects the offset table from what actually rendered, keeping the viewport anchored.
function measureRendered(start: number, end: number): void {
  if (start >= end) return;
  const trs = tbody.querySelectorAll<HTMLTableRowElement>('tr[data-seq]');
  if (!trs.length) return;

  // Clamped densities give every row the same height, so one sample is enough.
  if (isFixedHeight()) {
    const h = trs[0].offsetHeight;
    if (h > 0 && Math.abs(h - estimate) > 0.5) {
      estimate = h;
      rebuildOffsets();
      updateSpacers(start, end);
    }
    return;
  }

  let changed = false;
  let sum = 0;
  let measured = 0;
  for (let k = 0; k < trs.length; k++) {
    const l = filtered[start + k];
    if (!l) break;
    const h = trs[k].offsetHeight;
    if (h <= 0) continue;
    sum += h;
    measured++;
    if (Math.abs((heightBySeq.get(l.seq) ?? estimate) - h) > 0.5) {
      heightBySeq.set(l.seq, h);
      changed = true;
    }
  }
  if (!changed) return;
  if (measured) estimate = Math.round(sum / measured);

  const topBefore = offsets[start];
  rebuildOffsets();
  updateSpacers(start, end);
  const shift = offsets[start] - topBefore;
  if (shift !== 0 && rowsEl.scrollTop > 0) rowsEl.scrollTop += shift;
}

function updateSpacers(start: number, end: number): void {
  const spacers = tbody.querySelectorAll<HTMLTableCellElement>('tr.spacer > td');
  if (spacers.length !== 2) return;
  spacers[0].style.height = `${Math.max(0, offsets[start])}px`;
  spacers[1].style.height = `${Math.max(0, offsets[filtered.length] - offsets[end])}px`;
}

// --- View pipeline --------------------------------------------------------------------

function apply(preserveScroll = true): void {
  const anchor = preserveScroll ? captureAnchor() : null;

  const newest = newestTime(logs);
  const f = {
    query: state.query,
    level: state.level,
    attrFilter: state.attrFilter,
    range: state.range,
  };
  filtered = sortLogs(filterLogs(logs, f, searchRow, newest), state.sort);

  rebuildOffsets();
  restoreAnchor(anchor);
  paint();

  refreshSelectionUi();
  empty.style.display = logs.length ? 'none' : 'block';
  updateRetentionHint();
}

function updateRetentionHint(): void {
  const short = needsMoreRetention(logs, state.range, evicted);
  retentionHint.hidden = !short;
  if (!short) return;
  const oldest = new Date(oldestTime(logs)).toLocaleTimeString();
  hintText.textContent =
    `${LOG_RANGE_LABEL[state.range]} was requested, but retention only holds ` +
    `${logs.length} logs (back to ${oldest}).`;
}

let scrollScheduled = false;
rowsEl.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const top = rowsEl.scrollTop;
    const viewH = rowsEl.clientHeight || 400;
    // Repaint only once the viewport approaches the edge of the rendered window.
    if (indexAt(top) < winStart + 2 || indexAt(top + viewH) > winEnd - 2) paint();
  });
});

// --- Column resizing -----------------------------------------------------------------

interface Drag {
  el: HTMLElement;
  id: LogColumnId;
  startX: number;
  startW: number;
  min: number;
}
let drag: Drag | null = null;

function onMove(e: MouseEvent): void {
  if (!drag) return;
  const w = Math.max(drag.min, drag.startW + (e.clientX - drag.startX));
  drag.el.style.width = `${w}px`;
  e.preventDefault();
}

function onUp(): void {
  if (!drag) return;
  const width = parseInt(drag.el.style.width, 10);
  if (width) state.columns = setColumnWidth(state.columns, drag.id, width);
  drag = null;
  document.body.classList.remove('col-resizing');
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  persist();
  columnsChanged();
}

// Re-measure from scratch: width changes alter text wrapping, so raw-density heights are stale.
function columnsChanged(rebuildHeader = false): void {
  if (rebuildHeader) buildHead();
  else layoutColumns();
  heightBySeq.clear();
  apply();
}

// Widest rendered content in a column, measured by forcing nowrap for one layout pass.
function autoFit(id: LogColumnId): void {
  const cols = visibleColumns();
  const idx = cols.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const cells: HTMLElement[] = [];
  const th = head.children[idx] as HTMLElement | undefined;
  if (th) cells.push(th);
  for (const tr of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-seq]')) {
    const td = tr.children[idx] as HTMLElement | undefined;
    if (td) cells.push(td);
  }
  if (!cells.length) return;

  for (const c of cells) c.classList.add('measuring');
  let widest = 0;
  for (const c of cells) widest = Math.max(widest, c.scrollWidth);
  for (const c of cells) c.classList.remove('measuring');

  state.columns = setColumnWidth(state.columns, id, Math.min(800, widest + 2));
  persist();
  columnsChanged();
}

head.addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('col-resizer')) return;
  const id = target.dataset.col as LogColumnId | undefined;
  if (id) autoFit(id);
  e.preventDefault();
  e.stopPropagation();
});

head.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('col-resizer')) return;
  const id = target.dataset.col as LogColumnId | undefined;
  if (!id) return;
  const el = colgroup.querySelector<HTMLElement>(`col[data-col="${CSS.escape(id)}"]`);
  if (!el) return;
  drag = {
    el,
    id,
    startX: e.clientX,
    startW: el.getBoundingClientRect().width,
    min: columnDef(id).minWidth,
  };
  document.body.classList.add('col-resizing');
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  e.preventDefault();
  e.stopPropagation();
});

head.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('col-resizer')) return;
  const id = target.closest('th')?.dataset.col as LogColumnId | undefined;
  if (!id || !isSortable(id)) return;
  state.sort = nextSortDir(state.sort, id);
  persist();
  buildHead();
  rowsEl.scrollTop = 0;
  apply(false);
});

// --- Columns popover ------------------------------------------------------------------
// Two regions: "Shown" lists visible columns in table order and is the drag-to-reorder
// surface; the grouped sections below are the searchable on/off catalogue.

function columnState(id: LogColumnId): LogColumnState | undefined {
  return state.columns.find((c) => c.id === id);
}

function setColumnVisible(id: LogColumnId, visible: boolean): void {
  state.columns = setColumnVisibility(state.columns, id, visible);
  persist();
  columnsChanged(true);
  renderColumnList();
}

function reorderColumn(dragId: LogColumnId, targetId: LogColumnId, after: boolean): void {
  state.columns = moveColumn(state.columns, dragId, targetId, after);
  persist();
  columnsChanged(true);
  renderColumnList();
}

function groupedCatalogue(): Map<LogColumnGroup, LogColumnId[]> {
  const out = new Map<LogColumnGroup, LogColumnId[]>();
  for (const g of GROUP_ORDER) out.set(g, []);
  for (const def of LOG_COLUMNS) {
    if (def.id === 'select') continue;
    out.get(def.group)?.push(def.id);
  }
  const attrs = out.get('attributes') as LogColumnId[];
  // Persisted attribute columns stay listed even if no retained record carries the key.
  const keys = new Set<string>(attrKeys);
  for (const c of state.columns) {
    const k = parseAttrColumn(c.id);
    if (k) keys.add(k);
  }
  for (const k of [...keys].sort()) attrs.push(attrColumnId(k));
  return out;
}

function renderColumnList(): void {
  const term = colSearch.value.trim().toLowerCase();
  const html: string[] = [];

  const shown = visibleColumns();
  html.push('<div class="col-group">Shown — drag to reorder</div>');
  if (!shown.length) html.push('<div class="col-note">No columns selected.</div>');
  for (const c of shown) {
    html.push(
      `<div class="col-item shown-item" draggable="true" data-col="${esc(c.id)}">` +
        `<span class="drag-handle" aria-hidden="true">⠿</span>` +
        `<label><span>${esc(columnDef(c.id).label)}</span></label>` +
        `<button class="hide-btn" data-hide="${esc(c.id)}" title="Hide column" aria-label="Hide ${esc(columnDef(c.id).label)}">✕</button>` +
        `</div>`
    );
  }

  for (const [group, ids] of groupedCatalogue()) {
    const matching = ids.filter((id) => !term || columnDef(id).label.toLowerCase().includes(term));
    if (!matching.length) continue;
    html.push(`<div class="col-group">${esc(GROUP_LABEL[group])}</div>`);
    for (const id of matching) {
      const on = columnState(id)?.visible === true;
      html.push(
        `<div class="col-item"><label>` +
          `<input type="checkbox" data-toggle="${esc(id)}"${on ? ' checked' : ''} />` +
          `<span>${esc(columnDef(id).label)}</span></label></div>`
      );
    }
    if (group === 'attributes' && attrKeys.size >= ATTR_KEY_LIMIT) {
      html.push(`<div class="col-note">Showing the first ${ATTR_KEY_LIMIT} attribute keys.</div>`);
    }
  }

  colList.innerHTML = html.join('');
}

function openColumns(): void {
  const r = columnsBtn.getBoundingClientRect();
  columnsPanel.hidden = false;
  columnsPanel.style.top = `${r.bottom + 4}px`;
  columnsPanel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 372))}px`;
  columnsBtn.setAttribute('aria-expanded', 'true');
  renderColumnList();
  colSearch.focus();
}

function closeColumns(): void {
  columnsPanel.hidden = true;
  columnsBtn.setAttribute('aria-expanded', 'false');
}

columnsBtn.addEventListener('click', () => {
  if (columnsPanel.hidden) openColumns();
  else closeColumns();
});

colSearch.addEventListener('input', renderColumnList);

colReset.addEventListener('click', () => {
  state.columns = defaultColumnState();
  persist();
  columnsChanged(true);
  renderColumnList();
});

colList.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.toggle as LogColumnId | undefined;
  if (id) setColumnVisible(id, input.checked);
});

colList.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).dataset.hide as LogColumnId | undefined;
  if (id) setColumnVisible(id, false);
});

let dragColId: LogColumnId | null = null;

colList.addEventListener('dragstart', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item) return;
  dragColId = item.dataset.col as LogColumnId;
  item.classList.add('dragging');
  e.dataTransfer?.setData('text/plain', dragColId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
});

// offsetY is relative to whichever child was hit, so the midpoint comes off the item's rect.
function isAfterMidpoint(item: HTMLElement, clientY: number): boolean {
  const rect = item.getBoundingClientRect();
  return clientY > rect.top + rect.height / 2;
}

colList.addEventListener('dragover', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item || !dragColId) return;
  e.preventDefault();
  for (const el of colList.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
  item.classList.add(isAfterMidpoint(item, e.clientY) ? 'drop-after' : 'drop-before');
});

colList.addEventListener('drop', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item || !dragColId) return;
  e.preventDefault();
  reorderColumn(dragColId, item.dataset.col as LogColumnId, isAfterMidpoint(item, e.clientY));
  dragColId = null;
});

colList.addEventListener('dragend', () => {
  dragColId = null;
  for (const el of colList.querySelectorAll('.dragging, .drop-before, .drop-after')) {
    el.classList.remove('dragging', 'drop-before', 'drop-after');
  }
});

document.addEventListener('mousedown', (e) => {
  if (columnsPanel.hidden) return;
  const t = e.target as Node;
  if (!columnsPanel.contains(t) && !columnsBtn.contains(t)) closeColumns();
});

document.addEventListener('keydown', (e) => {
  if (columnsPanel.hidden) return;
  if (e.key === 'Escape') {
    closeColumns();
    columnsBtn.focus();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = columnsPanel.querySelectorAll<HTMLElement>(
    'input, button, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
});

// --- Row interaction (delegated) ------------------------------------------------------

// --- Selection ------------------------------------------------------------------------

function selectRange(fromSeq: number, toSeq: number): void {
  const range = rangeSelection(filtered, fromSeq, toSeq);
  if (!range.length) return;
  selection.clear();
  for (const seq of range) selection.add(seq);
}

function selectAllFiltered(): void {
  selection.clear();
  for (const l of filtered) selection.add(l.seq);
}

// Updates classes and checkboxes in place; repainting on click would destroy the <tr>
// between the two clicks of a double-click and suppress the dblclick event.
function refreshSelectionUi(): void {
  for (const tr of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-seq]')) {
    const seq = Number(tr.dataset.seq);
    tr.classList.toggle('selected', selection.has(seq));
    tr.classList.toggle('focused', seq === focusedSeq);
    const cb = tr.querySelector<HTMLInputElement>('input[data-sel]');
    if (cb) cb.checked = selection.has(seq);
  }
  const selAll = document.getElementById('selAll') as HTMLInputElement | null;
  if (selAll) {
    let n = 0;
    for (const l of filtered) if (selection.has(l.seq)) n++;
    selAll.checked = n > 0 && n === filtered.length;
    selAll.indeterminate = n > 0 && n < filtered.length;
  }
  updateCount();
}

function updateCount(): void {
  const base =
    filtered.length === logs.length
      ? `${logs.length} logs`
      : `${filtered.length} of ${logs.length} logs`;
  count.textContent = selection.size ? `${base} · ${selection.size} selected` : base;
}

head.addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.id !== 'selAll') return;
  if (target.checked) selectAllFiltered();
  else selection.clear();
  refreshSelectionUi();
});

tbody.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const raw = target.closest('tr')?.dataset.seq;
  if (!raw) return;
  const seq = Number(raw);

  if (target.matches('input[data-sel]')) {
    if (selection.has(seq)) selection.delete(seq);
    else selection.add(seq);
  } else if (e.shiftKey && anchorSeq >= 0) {
    selectRange(anchorSeq, seq);
  } else if (e.ctrlKey || e.metaKey) {
    if (selection.has(seq)) selection.delete(seq);
    else selection.add(seq);
    anchorSeq = seq;
  } else {
    selection.clear();
    selection.add(seq);
    anchorSeq = seq;
  }
  focusedSeq = seq;
  refreshSelectionUi();
});

tbody.addEventListener('dblclick', (e) => {
  const raw = (e.target as HTMLElement).closest('tr')?.dataset.seq;
  if (!raw) return;
  focusedSeq = Number(raw);
  vscode.postMessage({ type: 'openInEditor', seq: focusedSeq });
});

document.addEventListener('keydown', (e) => {
  if (!columnsPanel.hidden) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    selectAllFiltered();
    refreshSelectionUi();
    e.preventDefault();
  } else if (e.key === 'Escape' && selection.size) {
    selection.clear();
    refreshSelectionUi();
  }
});

// --- Toolbar --------------------------------------------------------------------------

level.innerHTML = LEVEL_OPTIONS.map(
  (o) => `<option value="${o.value}">${esc(o.label)}</option>`
).join('');

range.innerHTML = LOG_RANGE_OPTIONS.map(
  (r) => `<option value="${esc(r)}">${esc(LOG_RANGE_LABEL[r])}</option>`
).join('');

density.innerHTML = DENSITY_OPTIONS.map(
  (d) => `<option value="${esc(d)}">${esc(DENSITY_LABEL[d])}</option>`
).join('');

q.value = state.query;
attr.value = state.attrFilter;
level.value = String(state.level);
range.value = state.range;
density.value = state.density;

range.addEventListener('change', () => {
  if (!isLogRangeKind(range.value)) return;
  state.range = range.value as LogRangeKind;
  persist();
  rowsEl.scrollTop = 0;
  apply(false);
});

density.addEventListener('change', () => {
  if (!isLogDensity(density.value)) return;
  state.density = density.value as LogDensity;
  persist();
  applyDensity();
  // Row heights change wholesale, so every cached measurement is stale.
  heightBySeq.clear();
  estimate = DEFAULT_ROW_HEIGHT;
  apply();
});

hintBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openSetting', key: 'otel.retention.maxLogsPerInstance' });
});

q.addEventListener('input', () => {
  state.query = q.value;
  persist();
  apply(false);
});
level.addEventListener('change', () => {
  state.level = parseInt(level.value, 10) || 0;
  persist();
  apply(false);
});
attr.addEventListener('input', () => {
  state.attrFilter = attr.value;
  persist();
  apply(false);
});

byId<HTMLButtonElement>('nav').addEventListener('click', () => {
  if (focusedSeq >= 0) vscode.postMessage({ type: 'navigate', seq: focusedSeq });
});
byId<HTMLButtonElement>('open').addEventListener('click', () => {
  if (focusedSeq >= 0) vscode.postMessage({ type: 'openInEditor', seq: focusedSeq });
});

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.setAttribute('aria-pressed', String(paused));
  if (!paused) flushPending();
  updatePauseLabel();
});

function updatePauseLabel(): void {
  if (!paused) {
    pauseBtn.textContent = 'Pause';
    return;
  }
  pauseBtn.textContent = pending.length ? `Resume (${pending.length} new)` : 'Resume';
}

function flushPending(): void {
  if (pending.length) {
    for (const r of pending) {
      if (bySeq.has(r.seq)) continue;
      bySeq.set(r.seq, r);
      logs.push(r);
      collectAttrKeys(attrKeys, r);
    }
    pending = [];
  }
  if (pendingOldestSeq >= 0) {
    evictBefore(pendingOldestSeq);
    pendingOldestSeq = -1;
  }
  pruneSelection();
  apply();
}

// --- Export modal ---------------------------------------------------------------------

function radioValue(name: string): string {
  const el = exportDialog.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return el?.value ?? '';
}

// Records the chosen options would export, newest-first before the count is applied.
function exportScopeRows(): WireLog[] {
  switch (radioValue('exScope')) {
    case 'all':
      return logs.slice();
    case 'selected':
      return filtered.filter((l) => selection.has(l.seq));
    default:
      return filtered.slice();
  }
}

function exportCount(): number {
  const n = parseInt(exCount.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function syncExportDialog(): void {
  const format = radioValue('exFormat');
  const scope = radioValue('exScope');

  // OTLP/JSON has a fixed schema, so a column subset cannot apply to it.
  const otlp = format === 'otlp';
  exDataGroup.setAttribute('aria-disabled', String(otlp));
  exDataNote.hidden = !otlp;

  // Truncating an explicit selection would be surprising.
  const selected = scope === 'selected';
  exCountGroup.setAttribute('aria-disabled', String(selected));

  exScopeSelected.disabled = selection.size === 0;
  if (exScopeSelected.disabled && selected) {
    exportDialog.querySelector<HTMLInputElement>('input[name="exScope"][value="filtered"]')?.click();
    return;
  }

  const rows = exportScopeRows();
  const n = exportCount();
  const total = selected || n === 0 ? rows.length : Math.min(n, rows.length);
  exSummary.textContent = total
    ? `Exports ${total} log${total === 1 ? '' : 's'}.`
    : 'Nothing matches the selected scope.';
  exGo.disabled = total === 0;
}

function openExport(): void {
  exportBackdrop.hidden = false;
  syncExportDialog();
  exGo.focus();
}

function closeExport(): void {
  exportBackdrop.hidden = true;
  exportBtn.focus();
}

exportBtn.addEventListener('click', openExport);
exCancel.addEventListener('click', closeExport);
exportDialog.addEventListener('change', syncExportDialog);
exCount.addEventListener('input', syncExportDialog);

exportBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === exportBackdrop) closeExport();
});

exGo.addEventListener('click', () => {
  const scope = radioValue('exScope') as 'filtered' | 'all' | 'selected';
  const rows = exportScopeRows();
  const n = scope === 'selected' ? 0 : exportCount();
  vscode.postMessage({
    type: 'export',
    format: radioValue('exFormat'),
    data: radioValue('exFormat') === 'otlp' ? 'all' : radioValue('exData'),
    scope,
    count: n,
    columns: visibleColumns().map((c) => c.id),
    seqs: rows.map((l) => l.seq),
  });
  closeExport();
});

document.addEventListener('keydown', (e) => {
  if (exportBackdrop.hidden) return;
  if (e.key === 'Escape') {
    closeExport();
    e.stopPropagation();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = [...exportDialog.querySelectorAll<HTMLElement>('input, button')].filter(
    (el) => !(el as HTMLInputElement).disabled
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
});

// --- Host messages --------------------------------------------------------------------

function lastSeq(): number {
  return logs.length ? logs[logs.length - 1].seq : 0;
}

function evictBefore(oldestSeq: number): void {
  if (!logs.length || logs[0].seq >= oldestSeq) return;
  let drop = 0;
  while (drop < logs.length && logs[drop].seq < oldestSeq) drop++;
  for (let i = 0; i < drop; i++) {
    const seq = logs[i].seq;
    bySeq.delete(seq);
    searchIndex.delete(seq);
    heightBySeq.delete(seq);
    selection.delete(seq);
  }
  logs = logs.slice(drop);
}

function resetAll(): void {
  logs = [];
  bySeq.clear();
  searchIndex.clear();
  heightBySeq.clear();
  selection.clear();
  focusedSeq = -1;
  anchorSeq = -1;
  evicted = false;
  pending = [];
  pendingOldestSeq = -1;
}

function pruneSelection(): void {
  prune(selection, bySeq);
  if (focusedSeq >= 0 && !bySeq.has(focusedSeq)) focusedSeq = -1;
  if (anchorSeq >= 0 && !bySeq.has(anchorSeq)) anchorSeq = -1;
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as {
    type?: string;
    records?: WireLog[];
    oldestSeq?: number;
    readOnly?: boolean;
    source?: string;
  };
  if (m?.type === 'mode') {
    // Imported instances never stream, so pausing is meaningless.
    pauseBtn.hidden = m.readOnly === true;
    roBadge.hidden = m.readOnly !== true;
    if (m.readOnly) roBadge.textContent = m.source ? `Imported · ${m.source}` : 'Imported';
    return;
  }
  if (m?.type === 'promptExport') {
    openExport();
    return;
  }
  if (m?.type === 'reset') {
    resetAll();
    updatePauseLabel();
    apply(false);
    return;
  }
  if (m?.type !== 'append' || !Array.isArray(m.records)) return;

  if (typeof m.oldestSeq === 'number' && m.oldestSeq > 1) evicted = true;

  // Paused freezes the view entirely, so records and the eviction watermark both queue up.
  if (paused) {
    for (const r of m.records) pending.push(r);
    if (pending.length > PENDING_LIMIT) pending = pending.slice(pending.length - PENDING_LIMIT);
    if (typeof m.oldestSeq === 'number') pendingOldestSeq = m.oldestSeq;
    updatePauseLabel();
    return;
  }

  for (const r of m.records) {
    if (bySeq.has(r.seq)) continue;
    bySeq.set(r.seq, r);
    logs.push(r);
    collectAttrKeys(attrKeys, r);
  }
  if (typeof m.oldestSeq === 'number') evictBefore(m.oldestSeq);
  pruneSelection();
  apply();
  if (!columnsPanel.hidden) renderColumnList();
});

function applyDensity(): void {
  const clamp = DENSITY_LINE_CLAMP[state.density];
  document.body.dataset.density = state.density;
  document.body.style.setProperty('--log-line-clamp', clamp ? String(clamp) : 'none');
}

let lastWidth = 0;
new ResizeObserver(() => {
  const w = rowsEl.clientWidth;
  if (w === lastWidth) return;
  lastWidth = w;
  columnsChanged();
}).observe(rowsEl);

applyDensity();
buildHead();
apply(false);
vscode.postMessage({ type: 'ready', lastSeq: lastSeq() });
