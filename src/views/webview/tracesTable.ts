// Traces panel webview app: virtualized trace list with filters, column picker and the span
// waterfall. Every value that reaches the DOM goes through esc() or textContent.

import { attrColumnId, parseAttrColumn } from './columnState';
import {
  ROOT_ATTR_KEY_LIMIT,
  TRACE_COLUMNS,
  TRACE_GROUP_LABEL,
  TraceColumnGroup,
  TraceColumnId,
  traceColumnDef,
} from './traceColumns';
import {
  KIND_OPTIONS,
  STATUS_OPTIONS,
  TraceColumnState,
  TraceQueryInput,
  TraceRow,
  defaultTraceColumns,
  loadTracesPanelState,
  moveTraceColumn,
  nextSortDir,
  setTraceColumnVisibility,
  setTraceColumnWidth,
  sortTraces,
  traceCellText,
  visibleAttrKeys,
} from './traceView';
import { TIME_RANGE_LABEL, TIME_RANGE_OPTIONS, isTimeRangeKind } from './timeRange';
import { WaterfallMessage, createWaterfallView } from './waterfallView';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const state = loadTracesPanelState(vscode.getState());

const OVERSCAN = 8;
const DEBOUNCE_MS = 200;
let rowH = 24;

let traces: TraceRow[] = [];
let view: TraceRow[] = [];
let total = 0;
let gone = false;
let services: string[] = [];
let attrKeys: string[] = [];
let selected = '';
let winStart = 0;
let winEnd = 0;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const rowsEl = byId<HTMLDivElement>('rows');
const tableEl = byId<HTMLTableElement>('table');
const colgroup = byId<HTMLTableColElement>('cols');
const head = byId<HTMLTableRowElement>('head');
const tbody = byId<HTMLTableSectionElement>('tbody');
const empty = byId<HTMLDivElement>('empty');
const count = byId<HTMLSpanElement>('count');
const qErrors = byId<HTMLDivElement>('qErrors');
const serviceSel = byId<HTMLSelectElement>('service');
const nameInput = byId<HTMLInputElement>('name');
const statusSel = byId<HTMLSelectElement>('status');
const kindSel = byId<HTMLSelectElement>('kind');
const attrInput = byId<HTMLInputElement>('attr');
const minInput = byId<HTMLInputElement>('minMs');
const maxInput = byId<HTMLInputElement>('maxMs');
const traceIdInput = byId<HTMLInputElement>('traceIdQ');
const rangeSel = byId<HTMLSelectElement>('range');
const queryInput = byId<HTMLInputElement>('query');
const columnsBtn = byId<HTMLButtonElement>('columnsBtn');
const columnsPanel = byId<HTMLDivElement>('columnsPanel');
const colSearch = byId<HTMLInputElement>('colSearch');
const colReset = byId<HTMLButtonElement>('colReset');
const colList = byId<HTMLDivElement>('colList');

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function persist(): void {
  vscode.setState(state);
}

function visibleColumns(): TraceColumnState[] {
  return state.columns.filter((c) => c.visible);
}

function logsColumnVisible(): boolean {
  return state.columns.some((c) => c.id === 'logs' && c.visible);
}

// --- Host communication ----------------------------------------------------------------

function queryMessage(type: 'ready' | 'query'): unknown {
  return { type, input: state.input, attrKeys: visibleAttrKeys(state.columns), logs: logsColumnVisible() };
}

function sendQuery(): void {
  persist();
  vscode.postMessage(queryMessage('query'));
}

// --- Toolbar ----------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = { '': 'Any status', error: 'Error', ok: 'OK', unset: 'Unset' };

function options(values: readonly string[], label: (v: string) => string): string {
  return values.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
}

statusSel.innerHTML = options(STATUS_OPTIONS, (v) => STATUS_LABEL[v]);
kindSel.innerHTML = options(KIND_OPTIONS, (v) => (v ? v[0].toUpperCase() + v.slice(1) : 'Any kind'));
rangeSel.innerHTML = options(TIME_RANGE_OPTIONS, (v) =>
  v === 'all' ? 'All traces' : TIME_RANGE_LABEL[v as keyof typeof TIME_RANGE_LABEL]
);

function renderServiceOptions(): void {
  const list = [...services];
  if (state.input.service && !list.includes(state.input.service)) list.unshift(state.input.service);
  serviceSel.innerHTML = options(['', ...list], (v) => v || 'All services');
  serviceSel.value = state.input.service;
}

function numberOrNull(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

nameInput.value = state.input.name;
statusSel.value = state.input.status;
kindSel.value = state.input.kind;
attrInput.value = state.input.attr;
minInput.value = state.input.minMs === null ? '' : String(state.input.minMs);
maxInput.value = state.input.maxMs === null ? '' : String(state.input.maxMs);
traceIdInput.value = state.input.traceId;
rangeSel.value = state.input.range;
queryInput.value = state.input.query;
renderServiceOptions();

let debounce: ReturnType<typeof setTimeout> | undefined;
function onText(update: (input: TraceQueryInput) => void): () => void {
  return () => {
    update(state.input);
    clearTimeout(debounce);
    debounce = setTimeout(sendQuery, DEBOUNCE_MS);
  };
}

nameInput.addEventListener('input', onText((i) => (i.name = nameInput.value)));
attrInput.addEventListener('input', onText((i) => (i.attr = attrInput.value)));
traceIdInput.addEventListener('input', onText((i) => (i.traceId = traceIdInput.value)));
queryInput.addEventListener('input', onText((i) => (i.query = queryInput.value)));
minInput.addEventListener('input', onText((i) => (i.minMs = numberOrNull(minInput.value))));
maxInput.addEventListener('input', onText((i) => (i.maxMs = numberOrNull(maxInput.value))));

serviceSel.addEventListener('change', () => {
  state.input.service = serviceSel.value;
  sendQuery();
});
statusSel.addEventListener('change', () => {
  state.input.status = statusSel.value as TraceQueryInput['status'];
  sendQuery();
});
kindSel.addEventListener('change', () => {
  state.input.kind = kindSel.value as TraceQueryInput['kind'];
  sendQuery();
});
rangeSel.addEventListener('change', () => {
  if (!isTimeRangeKind(rangeSel.value)) return;
  state.input.range = rangeSel.value;
  sendQuery();
});

function renderErrors(errors: { token: string; message: string }[]): void {
  qErrors.hidden = !errors.length;
  qErrors.textContent = errors.length
    ? `Ignored: ${errors.map((e) => `${e.token} (${e.message})`).join('; ')}`
    : '';
  queryInput.setAttribute('aria-invalid', String(errors.length > 0));
}

// --- Header ------------------------------------------------------------------------------

function buildHead(): void {
  const cols = visibleColumns();
  colgroup.innerHTML = cols.map((c) => `<col data-col="${esc(c.id)}" />`).join('');
  head.innerHTML = cols
    .map((c) => {
      const def = traceColumnDef(c.id);
      const active = state.sort.col === c.id;
      const ind = active ? `<span class="sort-ind">${state.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
      const aria = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return (
        `<th data-col="${esc(c.id)}" class="sortable${def.numeric ? ' num' : ''}" aria-sort="${aria}" role="columnheader">` +
        `${esc(def.label)}${ind}<span class="col-resizer" data-col="${esc(c.id)}" title="Drag to resize, double-click to fit"></span></th>`
      );
    })
    .join('');
  layoutColumns();
}

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

// --- Rows --------------------------------------------------------------------------------

function cellHtml(r: TraceRow, id: TraceColumnId): string {
  const text = esc(traceCellText(r, id));
  switch (id) {
    case 'status':
      return r.errorCount
        ? `<td class="status err" title="${r.errorCount} error span(s)"><span aria-hidden="true">●</span> ${text}</td>`
        : '<td class="status"></td>';
    case 'root':
      return (
        `<td class="plain" title="${text}"><span class="svc-badge">${esc(r.rootService)}</span>${text}</td>`
      );
    case 'traceId':
      return `<td class="plain mono muted" title="${text}">${text}</td>`;
    default:
      return `<td class="plain${traceColumnDef(id).numeric ? ' num' : ''}" title="${text}">${text}</td>`;
  }
}

function spacer(height: number, span: number): string {
  return height > 0
    ? `<tr class="spacer" aria-hidden="true"><td colspan="${span}" style="height:${height}px"></td></tr>`
    : '';
}

function paint(): void {
  const cols = visibleColumns();
  const span = Math.max(1, cols.length);
  const top = rowsEl.scrollTop;
  const viewH = rowsEl.clientHeight || 400;
  const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
  const end = Math.min(view.length, Math.ceil((top + viewH) / rowH) + OVERSCAN);
  winStart = start;
  winEnd = end;

  const html: string[] = [spacer(start * rowH, span)];
  for (let i = start; i < end; i++) {
    const r = view[i];
    const sel = r.traceId === selected;
    html.push(
      `<tr class="selectable${sel ? ' selected' : ''}" data-id="${esc(r.traceId)}" ` +
        `aria-rowindex="${i + 2}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">`
    );
    for (const c of cols) html.push(cellHtml(r, c.id));
    html.push('</tr>');
  }
  html.push(spacer((view.length - end) * rowH, span));
  // Safe as markup: every interpolated value is a number or passed through esc().
  tbody.innerHTML = html.join('');
  tableEl.setAttribute('aria-rowcount', String(view.length + 1));

  const first = tbody.querySelector<HTMLTableRowElement>('tr[data-id]');
  const h = first?.offsetHeight ?? 0;
  if (h > 0 && Math.abs(h - rowH) > 0.5) {
    rowH = h;
    paint();
  }
}

function apply(): void {
  view = sortTraces(traces.slice(), state.sort);
  paint();
  count.textContent = view.length === total ? `${total} traces` : `${view.length} of ${total} traces`;
  empty.style.display = view.length ? 'none' : 'block';
  empty.textContent = gone
    ? 'This instance is no longer available.'
    : total
      ? 'No traces match the current filters.'
      : 'Waiting for traces…';
}

let scrollScheduled = false;
rowsEl.addEventListener('scroll', () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const first = Math.floor(rowsEl.scrollTop / rowH);
    const last = Math.ceil((rowsEl.scrollTop + rowsEl.clientHeight) / rowH);
    if (first < winStart + 2 || last > winEnd - 2) paint();
  });
});

function ensureVisible(index: number): void {
  const headH = head.offsetHeight;
  const top = index * rowH;
  if (top < rowsEl.scrollTop) rowsEl.scrollTop = top;
  else if (top + rowH + headH > rowsEl.scrollTop + rowsEl.clientHeight) {
    rowsEl.scrollTop = top + rowH + headH - rowsEl.clientHeight;
  }
  paint();
}

function selectTrace(traceId: string, examine: boolean, focus = false): void {
  selected = traceId;
  const i = view.findIndex((r) => r.traceId === traceId);
  if (i >= 0) ensureVisible(i);
  else paint();
  if (focus) tbody.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(traceId)}"]`)?.focus();
  if (examine) {
    waterfall.resetHistory();
    vscode.postMessage({ type: 'examine', traceId });
  }
}

tbody.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')?.dataset.id;
  if (id) selectTrace(id, true);
});

tbody.addEventListener('keydown', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')?.dataset.id;
  if (!id) return;
  const i = view.findIndex((r) => r.traceId === id);
  const page = Math.max(1, Math.floor(rowsEl.clientHeight / rowH) - 1);
  const target: Record<string, number> = {
    ArrowDown: i + 1,
    ArrowUp: i - 1,
    PageDown: i + page,
    PageUp: i - page,
    Home: 0,
    End: view.length - 1,
  };
  if (e.key === 'Enter' || e.key === ' ') {
    vscode.postMessage({ type: 'examine', traceId: id });
  } else if (e.key in target) {
    const next = view[Math.max(0, Math.min(view.length - 1, target[e.key]))];
    if (next) selectTrace(next.traceId, true, true);
  } else {
    return;
  }
  e.preventDefault();
});

// --- Column resizing & sorting -------------------------------------------------------------

interface Drag {
  el: HTMLElement;
  id: TraceColumnId;
  startX: number;
  startW: number;
  min: number;
}
let drag: Drag | null = null;

function onMove(e: MouseEvent): void {
  if (!drag) return;
  drag.el.style.width = `${Math.max(drag.min, drag.startW + (e.clientX - drag.startX))}px`;
  e.preventDefault();
}

function onUp(): void {
  if (!drag) return;
  const width = parseInt(drag.el.style.width, 10);
  if (width) state.columns = setTraceColumnWidth(state.columns, drag.id, width);
  drag = null;
  document.body.classList.remove('col-resizing');
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  persist();
  layoutColumns();
}

function autoFit(id: TraceColumnId): void {
  const idx = visibleColumns().findIndex((c) => c.id === id);
  if (idx < 0) return;
  const cells: HTMLElement[] = [];
  const th = head.children[idx] as HTMLElement | undefined;
  if (th) cells.push(th);
  for (const tr of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
    const td = tr.children[idx] as HTMLElement | undefined;
    if (td) cells.push(td);
  }
  for (const c of cells) c.classList.add('measuring');
  let widest = 0;
  for (const c of cells) widest = Math.max(widest, c.scrollWidth);
  for (const c of cells) c.classList.remove('measuring');
  state.columns = setTraceColumnWidth(state.columns, id, Math.min(800, widest + 2));
  persist();
  layoutColumns();
}

head.addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('col-resizer')) return;
  const id = target.dataset.col as TraceColumnId | undefined;
  if (id) autoFit(id);
  e.preventDefault();
  e.stopPropagation();
});

head.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('col-resizer')) return;
  const id = target.dataset.col as TraceColumnId | undefined;
  const el = id ? colgroup.querySelector<HTMLElement>(`col[data-col="${CSS.escape(id)}"]`) : null;
  if (!id || !el) return;
  drag = { el, id, startX: e.clientX, startW: el.getBoundingClientRect().width, min: traceColumnDef(id).minWidth };
  document.body.classList.add('col-resizing');
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  e.preventDefault();
  e.stopPropagation();
});

head.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('col-resizer')) return;
  const id = target.closest('th')?.dataset.col as TraceColumnId | undefined;
  if (!id) return;
  state.sort = nextSortDir(state.sort, id);
  persist();
  buildHead();
  rowsEl.scrollTop = 0;
  apply();
});

// --- Columns popover ------------------------------------------------------------------------

// Attribute and log columns need data the host only sends on request.
function columnsChanged(needsData: boolean): void {
  persist();
  buildHead();
  apply();
  renderColumnList();
  if (needsData) sendQuery();
}

function needsData(id: TraceColumnId): boolean {
  return id === 'logs' || parseAttrColumn(id) !== undefined;
}

function setColumnVisible(id: TraceColumnId, visible: boolean): void {
  state.columns = setTraceColumnVisibility(state.columns, id, visible);
  columnsChanged(needsData(id));
}

function groupedCatalogue(): Map<TraceColumnGroup, TraceColumnId[]> {
  const out = new Map<TraceColumnGroup, TraceColumnId[]>([
    ['core', TRACE_COLUMNS.map((c) => c.id)],
    ['attributes', []],
  ]);
  const keys = new Set<string>(attrKeys);
  for (const c of state.columns) {
    const k = parseAttrColumn(c.id);
    if (k) keys.add(k);
  }
  const attrs = out.get('attributes') as TraceColumnId[];
  for (const k of [...keys].sort()) attrs.push(attrColumnId(k));
  return out;
}

function renderColumnList(): void {
  if (columnsPanel.hidden) return;
  const term = colSearch.value.trim().toLowerCase();
  const html: string[] = ['<div class="col-group">Shown — drag to reorder</div>'];
  const shown = visibleColumns();
  if (!shown.length) html.push('<div class="col-note">No columns selected.</div>');
  for (const c of shown) {
    const label = esc(traceColumnDef(c.id).label);
    html.push(
      `<div class="col-item shown-item" draggable="true" data-col="${esc(c.id)}">` +
        `<span class="drag-handle" aria-hidden="true">⠿</span><label><span>${label}</span></label>` +
        `<button class="hide-btn" data-hide="${esc(c.id)}" title="Hide column" aria-label="Hide ${label}">✕</button></div>`
    );
  }
  for (const [group, ids] of groupedCatalogue()) {
    const matching = ids.filter((id) => !term || traceColumnDef(id).label.toLowerCase().includes(term));
    if (!matching.length) {
      if (group === 'attributes' && !term) {
        html.push(`<div class="col-group">${esc(TRACE_GROUP_LABEL[group])}</div>`);
        html.push('<div class="col-note">No root span attributes yet.</div>');
      }
      continue;
    }
    html.push(`<div class="col-group">${esc(TRACE_GROUP_LABEL[group])}</div>`);
    for (const id of matching) {
      const on = state.columns.find((c) => c.id === id)?.visible === true;
      html.push(
        `<div class="col-item"><label><input type="checkbox" data-toggle="${esc(id)}"${on ? ' checked' : ''} />` +
          `<span>${esc(traceColumnDef(id).label)}</span></label></div>`
      );
    }
    if (group === 'attributes' && attrKeys.length >= ROOT_ATTR_KEY_LIMIT) {
      html.push(`<div class="col-note">Showing the first ${ROOT_ATTR_KEY_LIMIT} attribute keys.</div>`);
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

columnsBtn.addEventListener('click', () => (columnsPanel.hidden ? openColumns() : closeColumns()));
colSearch.addEventListener('input', renderColumnList);
colReset.addEventListener('click', () => {
  state.columns = defaultTraceColumns();
  columnsChanged(true);
});
colList.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.toggle as TraceColumnId | undefined;
  if (id) setColumnVisible(id, input.checked);
});
colList.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).dataset.hide as TraceColumnId | undefined;
  if (id) setColumnVisible(id, false);
});

let dragColId: TraceColumnId | null = null;

function isAfterMidpoint(item: HTMLElement, clientY: number): boolean {
  const rect = item.getBoundingClientRect();
  return clientY > rect.top + rect.height / 2;
}

colList.addEventListener('dragstart', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item) return;
  dragColId = item.dataset.col as TraceColumnId;
  item.classList.add('dragging');
  e.dataTransfer?.setData('text/plain', dragColId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
});
colList.addEventListener('dragover', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item || !dragColId) return;
  e.preventDefault();
  for (const el of colList.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  item.classList.add(isAfterMidpoint(item, e.clientY) ? 'drop-after' : 'drop-before');
});
colList.addEventListener('drop', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.shown-item');
  if (!item || !dragColId) return;
  e.preventDefault();
  state.columns = moveTraceColumn(state.columns, dragColId, item.dataset.col as TraceColumnId, isAfterMidpoint(item, e.clientY));
  dragColId = null;
  columnsChanged(false);
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
  const focusable = columnsPanel.querySelectorAll<HTMLElement>('input, button');
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

// --- Waterfall ------------------------------------------------------------------------------

const waterfall = createWaterfallView({
  post: (msg) => vscode.postMessage(msg),
  showLogs: () => state.showLogs,
  setShowLogs: (v) => {
    state.showLogs = v;
    persist();
  },
});

// --- Host messages --------------------------------------------------------------------------

interface ListMessage {
  type: 'list';
  traces: TraceRow[];
  total?: number;
  services?: string[];
  attrKeys?: string[];
  errors?: { token: string; message: string }[];
  gone?: boolean;
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ListMessage | WaterfallMessage;
  if (m?.type === 'list' && Array.isArray(m.traces)) {
    traces = m.traces;
    total = m.total ?? m.traces.length;
    gone = m.gone === true;
    const nextServices = m.services ?? [];
    if (nextServices.join('\u0000') !== services.join('\u0000')) {
      services = nextServices;
      renderServiceOptions();
    }
    attrKeys = m.attrKeys ?? [];
    renderErrors(m.errors ?? []);
    apply();
    renderColumnList();
  } else if (m?.type === 'waterfall') {
    if (m.focusSpanId !== undefined || m.traceId !== selected) selectTrace(m.traceId, false);
    waterfall.render(m);
  }
});

let lastWidth = 0;
new ResizeObserver(() => {
  const w = rowsEl.clientWidth;
  if (w === lastWidth) return;
  lastWidth = w;
  layoutColumns();
  paint();
}).observe(rowsEl);

buildHead();
apply();
vscode.postMessage(queryMessage('ready'));
