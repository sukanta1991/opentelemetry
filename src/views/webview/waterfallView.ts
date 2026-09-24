// Waterfall + span details for the traces webview. Every value that reaches the DOM goes
// through esc(); ids posted back to the host are re-validated there.

import type { AttrEntry, WaterfallPayload, WaterfallRow, WfLog } from '../waterfall';
import { LogMarker, bucketLogMarkers, severityBucket } from './waterfallMarkers';

export interface WaterfallMessage extends Partial<WaterfallPayload> {
  type: 'waterfall';
  traceId: string;
  focusSpanId?: string;
  refresh?: boolean;
  gone?: boolean;
}

export interface WaterfallHost {
  post(msg: unknown): void;
  showLogs(): boolean;
  setShowLogs(v: boolean): void;
}

const ROW_H = 22;
const VIRTUALIZE_AT = 300;
const OVERSCAN = 10;

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function fmtOffset(ms: number): string {
  return `${ms >= 0 ? '+' : ''}${ms.toFixed(2)}ms`;
}

function sevLabel(l: { severityText: string; severityNumber: number }): string {
  return l.severityText || severityBucket(l.severityNumber).toUpperCase();
}

export function createWaterfallView(host: WaterfallHost): {
  render(m: WaterfallMessage): void;
  resetHistory(): void;
} {
  const wf = byId<HTMLDivElement>('wf');
  const title = byId<HTMLDivElement>('wfTitle');
  const note = byId<HTMLDivElement>('wfNote');
  const traceLogsEl = byId<HTMLDivElement>('wfTraceLogs');
  const detail = byId<HTMLElement>('spanDetail');
  const backBtn = byId<HTMLButtonElement>('wfBack');
  const viewLogsBtn = byId<HTMLButtonElement>('wfViewLogs');
  const copyBtn = byId<HTMLButtonElement>('wfCopy');
  const showLogsBox = byId<HTMLInputElement>('wfShowLogs');

  let traceId = '';
  let rows: WaterfallRow[] = [];
  let totalMs = 0;
  let logsBySpan: Record<string, WfLog[]> = {};
  let traceLogs: WfLog[] = [];
  let resources: WaterfallPayload['resources'] = {};
  let markers: LogMarker[][] = [];
  let truncated = false;
  let selectedSpan = '';
  let detailMode: 'span' | 'trace' | '' = '';
  const history: string[] = [];

  showLogsBox.checked = host.showLogs();

  // --- Rows -------------------------------------------------------------------------------

  function computeMarkers(): void {
    markers = rows.map((r) => {
      const logs = logsBySpan[r.spanId];
      return logs && host.showLogs() ? bucketLogMarkers(logs, r.offsetMs, r.durationMs, totalMs) : [];
    });
  }

  function markerHtml(m: LogMarker, rowIdx: number, k: number): string {
    const sev = severityBucket(m.maxSeverity);
    const label = `${m.count} log${m.count === 1 ? '' : 's'}, highest ${sev}${m.clamped ? ', outside span time' : ''}`;
    return (
      `<button type="button" class="log-marker sev-${sev}${m.clamped ? ' clamped' : ''}" data-row="${rowIdx}" data-m="${k}" ` +
      `style="left:${m.pct}%" aria-label="${esc(label)}" title="${esc(label)}">${m.count > 1 ? m.count : ''}</button>`
    );
  }

  function rowHtml(r: WaterfallRow, i: number): string {
    const scale = totalMs > 0 ? 100 / totalMs : 0;
    const left = r.offsetMs * scale;
    const width = Math.max(0.5, r.durationMs * scale);
    const marks = (markers[i] ?? []).map((m, k) => markerHtml(m, i, k)).join('');
    const sel = r.spanId === selectedSpan;
    return (
      `<div class="bar-row${sel ? ' selected' : ''}" data-idx="${i}" tabindex="0" role="treeitem" ` +
      `aria-level="${r.depth + 1}" aria-selected="${sel}">` +
      `<div class="bar-label" style="padding-left:${Math.min(r.depth, 40) * 14}px" title="${esc(r.name)}">` +
      `<span class="svc-badge">${esc(r.service)}</span>${esc(r.name)}<span class="kind">${esc(r.kind)}</span>` +
      (r.hasError ? '<span class="err" aria-label="error"> ●</span>' : '') +
      '</div>' +
      `<div class="bar-track"><div class="bar${r.hasError ? ' error' : ''}" style="left:${left}%;width:${width}%"></div>${marks}</div>` +
      `<div class="bar-dur">${r.durationMs.toFixed(2)}ms</div></div>`
    );
  }

  function virtualized(): boolean {
    return rows.length > VIRTUALIZE_AT;
  }

  function paintRows(): void {
    if (!virtualized()) {
      wf.innerHTML = rows.map(rowHtml).join('');
      return;
    }
    const top = wf.scrollTop;
    const viewH = wf.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
    const html = [`<div style="height:${start * ROW_H}px" aria-hidden="true"></div>`];
    for (let i = start; i < end; i++) html.push(rowHtml(rows[i], i));
    html.push(`<div style="height:${(rows.length - end) * ROW_H}px" aria-hidden="true"></div>`);
    wf.innerHTML = html.join('');
  }

  let scrollScheduled = false;
  wf.addEventListener('scroll', () => {
    if (!virtualized() || scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      paintRows();
    });
  });

  function rowEl(idx: number): HTMLElement | null {
    return wf.querySelector<HTMLElement>(`.bar-row[data-idx="${idx}"]`);
  }

  function scrollToRow(idx: number): void {
    if (virtualized()) {
      wf.scrollTop = Math.max(0, idx * ROW_H - wf.clientHeight / 2);
      paintRows();
    }
    const el = rowEl(idx);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.focus({ preventScroll: true });
    }
  }

  function renderTraceLogsStrip(): void {
    if (!traceLogs.length || !host.showLogs()) {
      traceLogsEl.hidden = true;
      traceLogsEl.innerHTML = '';
      return;
    }
    const marks = bucketLogMarkers(traceLogs, 0, totalMs, totalMs);
    traceLogsEl.hidden = false;
    traceLogsEl.innerHTML =
      `<div class="bar-label"><button type="button" class="link" data-action="traceLogs">Trace-level logs (${traceLogs.length})</button></div>` +
      `<div class="bar-track">${marks.map((m, k) => markerHtml(m, -1, k)).join('')}</div><div class="bar-dur"></div>`;
  }

  // --- Details ----------------------------------------------------------------------------

  function kvTable(entries: AttrEntry[]): string {
    return (
      '<table class="kv">' +
      entries
        .map((a) => {
          const pre = a.structured || a.key === 'exception.stacktrace';
          return (
            `<tr><td class="k">${esc(a.key)}</td><td>` +
            (pre ? `<pre class="val">${esc(a.value)}</pre>` : `<div class="val">${esc(a.value)}</div>`) +
            '</td></tr>'
          );
        })
        .join('') +
      '</table>'
    );
  }

  function metaRow(k: string, html: string): string {
    return `<tr><td class="k">${esc(k)}</td><td>${html}</td></tr>`;
  }

  function logsHtml(logs: WfLog[], baseOffset: number): string {
    if (!logs.length) return '<div class="muted">No correlated logs</div>';
    return logs
      .map((l) => {
        const sev = severityBucket(l.severityNumber);
        const skew = l.skew ? `<span class="skew" title="Log time is outside the span">${l.skew} span</span>` : '';
        return (
          `<div class="sd-log" data-seq="${l.seq}">` +
          `<span class="sev sev-${sev}">${esc(sevLabel(l))}</span> ` +
          `<span class="muted">${esc(fmtOffset(l.offsetMs - baseOffset))}</span> ${skew}` +
          `<button type="button" class="link sd-open" data-action="openLog" data-seq="${l.seq}" data-inst="${esc(l.instanceId)}">Open in Logs</button>` +
          `<div class="sd-msg">${esc(l.message)}</div></div>`
        );
      })
      .join('');
  }

  function renderSpanDetail(r: WaterfallRow, keepScroll = false): void {
    const scroll = detail.scrollTop;
    detailMode = 'span';
    let status = `${r.hasError ? '<span aria-hidden="true">● </span>' : ''}${esc(r.status)}` +
      (r.statusMessage ? ` — ${esc(r.statusMessage)}` : '');
    if (r.hasError) status = `<span class="err">${status}</span>`;
    let meta =
      metaRow('Status', status) +
      metaRow('Duration', esc(`${r.durationMs.toFixed(2)}ms`)) +
      metaRow('Start', esc(fmtOffset(r.offsetMs))) +
      metaRow('Span ID', `<code>${esc(r.spanId)}</code>`);
    if (r.parentSpanId) meta += metaRow('Parent ID', `<code>${esc(r.parentSpanId)}</code>`);
    if (r.scope) meta += metaRow('Scope', esc(r.scope));
    if (r.orphan) {
      meta += metaRow('Note', '<span class="muted">Parent span is not in collected data (or forms a cycle); shown as a root.</span>');
    }

    const logs = logsBySpan[r.spanId] ?? [];
    const code = r.code ? `${r.code.filepath}${r.code.line ? `:${r.code.line}` : ''}` : '';
    const actions =
      '<div class="sd-actions">' +
      `<button type="button" class="secondary" data-action="viewLogs"${logs.length || truncated ? '' : ' disabled'}>View logs</button>` +
      (r.code
        ? `<button type="button" class="secondary" data-action="navigate" title="${esc(code)}">Navigate To Code</button>`
        : '') +
      '<button type="button" class="secondary" data-action="copySpan">Copy span ID</button></div>';

    let html =
      `<div class="sd-head"><div class="sd-title"><span class="svc-badge">${esc(r.service)}</span><strong>${esc(r.name)}</strong>` +
      `<span class="kind">${esc(r.kind)}</span></div>` +
      '<button type="button" class="secondary" data-action="close" title="Close" aria-label="Close span details">×</button></div>' +
      actions +
      `<table class="kv">${meta}</table>` +
      `<h4>Attributes (${r.attrs.length})</h4>` +
      (r.attrs.length ? kvTable(r.attrs) : '<div class="muted">No attributes</div>') +
      `<h4>Events (${r.events.length})</h4>`;
    if (!r.events.length) html += '<div class="muted">No events</div>';
    for (const ev of r.events) {
      html +=
        `<div class="sd-event"><div><strong>${esc(ev.name)}</strong> <span class="muted">${esc(fmtOffset(ev.offsetMs))}</span></div>` +
        (ev.attrs.length ? kvTable(ev.attrs) : '') +
        '</div>';
    }
    html += `<h4>Links (${r.links.length})</h4>`;
    if (!r.links.length) html += '<div class="muted">No links</div>';
    for (const l of r.links) {
      const target = l.available
        ? `<button type="button" class="link" data-action="revealLink" data-trace="${esc(l.traceId)}" data-span="${esc(l.spanId)}">` +
          `Trace ${esc(l.traceId.slice(0, 8))}… · span ${esc(l.spanId.slice(0, 8))}</button>`
        : `<code>${esc(l.traceId)}</code> <span class="muted">(not collected)</span>`;
      html +=
        `<div class="sd-event"><div>${target}</div>` +
        (l.traceState ? `<div class="muted">tracestate: ${esc(l.traceState)}</div>` : '') +
        (l.attrs.length ? kvTable(l.attrs) : '') +
        '</div>';
    }
    html += `<h4 id="sdLogs">Logs (${logs.length})</h4>` + logsHtml(logs, r.offsetMs);
    const res = resources[r.instanceId];
    if (res) {
      html +=
        `<details class="sd-resource"><summary>Resource · ${esc(res.serviceName)} (${res.attrs.length})</summary>` +
        (res.attrs.length ? kvTable(res.attrs) : '<div class="muted">No resource attributes</div>') +
        '</details>';
    }
    detail.innerHTML = html;
    detail.hidden = false;
    detail.scrollTop = keepScroll ? scroll : 0;
  }

  function renderTraceLogsDetail(highlight?: number[]): void {
    detailMode = 'trace';
    selectedSpan = '';
    paintRows();
    detail.innerHTML =
      '<div class="sd-head"><div class="sd-title"><strong>Trace-level logs</strong>' +
      '<div class="muted">Logs with this trace ID but no span in the waterfall</div></div>' +
      '<button type="button" class="secondary" data-action="close" title="Close" aria-label="Close details">×</button></div>' +
      `<h4 id="sdLogs">Logs (${traceLogs.length})</h4>` +
      logsHtml(traceLogs, 0);
    detail.hidden = false;
    detail.scrollTop = 0;
    if (highlight) highlightLogs(highlight);
  }

  function highlightLogs(seqs: number[]): void {
    const set = new Set(seqs);
    let first: HTMLElement | null = null;
    for (const el of detail.querySelectorAll<HTMLElement>('.sd-log')) {
      const on = set.has(Number(el.dataset.seq));
      el.classList.toggle('hl', on);
      if (on && !first) first = el;
    }
    (first ?? byId('sdLogs'))?.scrollIntoView({ block: 'nearest' });
  }

  function hideDetail(): void {
    const idx = rows.findIndex((r) => r.spanId === selectedSpan);
    selectedSpan = '';
    detailMode = '';
    detail.hidden = true;
    detail.innerHTML = '';
    paintRows();
    if (idx >= 0) rowEl(idx)?.focus();
  }

  function selectSpan(idx: number): void {
    const r = rows[idx];
    if (!r) return;
    selectedSpan = r.spanId;
    for (const el of wf.querySelectorAll<HTMLElement>('.bar-row')) {
      const on = el.dataset.idx === String(idx);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
    }
    renderSpanDetail(r);
  }

  // --- Events -------------------------------------------------------------------------------

  wf.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const marker = target.closest<HTMLElement>('.log-marker');
    const row = target.closest<HTMLElement>('.bar-row');
    if (!row) return;
    const idx = Number(row.dataset.idx);
    selectSpan(idx);
    if (marker) highlightLogs(markers[idx]?.[Number(marker.dataset.m)]?.seqs ?? []);
  });

  wf.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.bar-row');
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('.log-marker')) {
      selectSpan(idx);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = Math.max(0, Math.min(rows.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      scrollToRow(next);
    } else {
      return;
    }
    e.preventDefault();
  });

  traceLogsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const marker = target.closest<HTMLElement>('.log-marker');
    if (marker) {
      const marks = bucketLogMarkers(traceLogs, 0, totalMs, totalMs);
      renderTraceLogsDetail(marks[Number(marker.dataset.m)]?.seqs);
    } else if (target.closest('[data-action="traceLogs"]')) {
      renderTraceLogsDetail();
    }
  });

  detail.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const row = rows.find((r) => r.spanId === selectedSpan);
    switch (btn.dataset.action) {
      case 'close':
        hideDetail();
        break;
      case 'viewLogs':
        if (row) host.post({ type: 'viewLogs', traceId, spanId: row.spanId });
        break;
      case 'navigate':
        if (row) host.post({ type: 'navigateSpan', spanId: row.spanId });
        break;
      case 'copySpan':
        if (row) host.post({ type: 'copy', text: row.spanId });
        break;
      case 'openLog':
        host.post({ type: 'openLog', seq: Number(btn.dataset.seq), instanceId: btn.dataset.inst });
        break;
      case 'revealLink':
        history.push(traceId);
        host.post({ type: 'revealLink', traceId: btn.dataset.trace, spanId: btn.dataset.span });
        break;
    }
  });

  detail.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    hideDetail();
  });

  backBtn.addEventListener('click', () => {
    const prev = history.pop();
    if (prev) host.post({ type: 'examine', traceId: prev });
    backBtn.hidden = !history.length;
  });
  viewLogsBtn.addEventListener('click', () => {
    if (traceId) host.post({ type: 'viewLogs', traceId });
  });
  copyBtn.addEventListener('click', () => {
    if (traceId) host.post({ type: 'copy', text: traceId });
  });
  showLogsBox.addEventListener('change', () => {
    host.setShowLogs(showLogsBox.checked);
    computeMarkers();
    paintRows();
    renderTraceLogsStrip();
  });

  // --- Render ---------------------------------------------------------------------------

  function render(m: WaterfallMessage): void {
    backBtn.hidden = !history.length;
    if (m.gone) {
      traceId = m.traceId;
      rows = [];
      logsBySpan = {};
      traceLogs = [];
      markers = [];
      title.textContent = `Trace ${m.traceId}`;
      note.hidden = false;
      note.textContent = 'Trace no longer in collected data (evicted or cleared).';
      viewLogsBtn.disabled = copyBtn.disabled = false;
      wf.innerHTML = '';
      renderTraceLogsStrip();
      detail.hidden = true;
      return;
    }
    const sameTrace = m.traceId === traceId;
    const scroll = wf.scrollTop;
    if (!sameTrace) {
      selectedSpan = '';
      detailMode = '';
    }
    if (m.focusSpanId) selectedSpan = m.focusSpanId;
    traceId = m.traceId;
    rows = m.rows ?? [];
    totalMs = m.totalMs ?? 0;
    logsBySpan = m.logsBySpan ?? {};
    traceLogs = m.traceLogs ?? [];
    resources = m.resources ?? {};
    truncated = m.truncated === true;

    const logCount = traceLogs.length + Object.values(logsBySpan).reduce((n, l) => n + l.length, 0);
    title.textContent = `Trace ${traceId}  ·  ${rows.length} spans  ·  ${totalMs.toFixed(2)}ms  ·  ${logCount} logs`;
    viewLogsBtn.disabled = copyBtn.disabled = false;
    note.hidden = !m.truncated;
    note.textContent = m.truncated ? 'Showing the newest correlated logs only; open Logs to see all of them.' : '';

    computeMarkers();
    if (!sameTrace) wf.scrollTop = 0;
    paintRows();
    if (sameTrace) wf.scrollTop = scroll;
    renderTraceLogsStrip();

    const idx = rows.findIndex((r) => r.spanId === selectedSpan);
    if (idx >= 0) {
      renderSpanDetail(rows[idx], sameTrace && !m.focusSpanId);
      if (m.focusSpanId) scrollToRow(idx);
    } else if (detailMode === 'trace' && sameTrace) {
      renderTraceLogsDetail();
    } else {
      selectedSpan = '';
      detail.hidden = true;
      detail.innerHTML = '';
    }
  }

  return {
    render,
    resetHistory: () => {
      history.length = 0;
      backBtn.hidden = true;
    },
  };
}
