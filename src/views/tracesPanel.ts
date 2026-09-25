import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { KeyValueMap } from '../store/model';
import { TaggedSpan, TracePart } from '../store/store';
import { openCodeLocation } from './codeNav';
import { isEmptyQuery, matchesTrace, parseTraceQuery } from './traceQuery';
import { TraceSummary, TraceSummaryCache, collectRootAttrKeys, rootAttrValue, traceSignature } from './traceSummary';
import { MAX_WATERFALL_LOGS, buildWaterfallPayload } from './waterfallPayload';
import { windowBounds } from './webview/timeRange';
import {
  TraceQueryInput,
  TraceRow,
  defaultQueryInput,
  sanitizeAttrKeys,
  sanitizeQueryInput,
} from './webview/traceView';
import { COLUMN_TABLE_CSS, RANGE_ICON_SVG, getNonce, getUri, htmlShell } from './webviewUtil';

export interface TraceFocus {
  traceId: string;
  spanId?: string;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const LIST_THROTTLE_MS = 500;

// What the open waterfall shows; webview requests are only honoured against this.
interface CurrentTrace {
  traceId: string;
  spans: Map<string, TaggedSpan>;
  links: Set<string>;
  sig: string;
}

function* taggedSpans(parts: readonly TracePart[]): Iterable<TaggedSpan> {
  for (const p of parts) {
    for (const span of p.trace.spans.values()) {
      yield { span, serviceName: p.serviceName, instanceId: p.instanceId };
    }
  }
}

export class TracesPanel {
  private static panels = new Map<string, TracesPanel>();
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingFocus: TraceFocus | undefined;
  private input: TraceQueryInput = defaultQueryInput();
  private attrKeys: string[] = [];
  private withLogs = false;
  private readonly cache = new TraceSummaryCache();
  private lastPost = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private current: CurrentTrace | undefined;

  static show(controller: OtelController, instanceId: string, focus?: TraceFocus): void {
    let target = TracesPanel.panels.get(instanceId);
    if (target) {
      target.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const inst = controller.store.getInstance(instanceId);
      const panel = vscode.window.createWebviewPanel(
        'otel.traces',
        inst ? `Traces: ${inst.serviceName}` : 'Traces',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
        }
      );
      target = new TracesPanel(panel, controller, instanceId);
      TracesPanel.panels.set(instanceId, target);
    }
    if (focus) target.focus(focus);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    const scriptUri = getUri(panel.webview, controller.extensionUri, 'dist', 'webview', 'tracesTable.js');
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, '', STYLE, [scriptUri]);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && this.dirty) this.scheduleList();
      },
      null,
      this.disposables
    );
    this.disposables.push(this.controller.store.onDidChange(() => this.scheduleList()));
  }

  // Hidden panels only mark themselves dirty; visible ones post at most every 500 ms.
  private scheduleList(): void {
    if (!this.ready) return;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastPost + LIST_THROTTLE_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postList();
      this.refreshWaterfall();
    }, wait);
  }

  private postList(): void {
    this.dirty = false;
    this.lastPost = Date.now();
    const store = this.controller.store;
    const inst = store.getInstance(this.instanceId);
    if (!inst) {
      void this.panel.webview.postMessage({ type: 'list', traces: [], total: 0, gone: true });
      return;
    }

    const { query, errors } = parseTraceQuery(this.input);
    const filtering = !isEmptyQuery(query);
    const entries: { summary: TraceSummary; parts: TracePart[] }[] = [];
    const services = new Set<string>();
    let newest = 0;
    for (const traceId of inst.traces.keys()) {
      const parts = store.getTraceParts(traceId);
      const summary = this.cache.get(traceId, parts);
      entries.push({ summary, parts });
      for (const s of summary.row.services) services.add(s);
      newest = Math.max(newest, summary.row.startMs);
    }
    this.cache.prune(new Set(inst.traces.keys()));

    const [from] = windowBounds(newest, this.input.range);
    const logCounts = this.withLogs ? store.countLogsByTrace() : undefined;
    const traces: TraceRow[] = [];
    for (const { summary, parts } of entries) {
      const row = summary.row;
      if (row.startMs < from) continue;
      if (filtering && !matchesTrace(taggedSpans(parts), row, query)) continue;
      const out: TraceRow = { ...row };
      if (logCounts) out.logCount = logCounts.get(row.traceId) ?? 0;
      if (this.attrKeys.length) {
        const attrs: Record<string, string> = {};
        for (const k of this.attrKeys) {
          const v = rootAttrValue(summary.root, k);
          if (v !== undefined) attrs[k] = v;
        }
        out.rootAttrs = attrs;
      }
      traces.push(out);
    }

    void this.panel.webview.postMessage({
      type: 'list',
      traces,
      total: inst.traces.size,
      services: [...services].sort(),
      attrKeys: collectRootAttrKeys(entries.map((e) => e.summary)),
      errors,
    });
  }

  private applyQuery(m: { input?: unknown; attrKeys?: unknown; logs?: unknown }): void {
    this.input = sanitizeQueryInput(m.input);
    this.attrKeys = sanitizeAttrKeys(m.attrKeys);
    this.withLogs = m.logs === true;
  }

  private onMessage(m: unknown): void {
    const msg = m as Record<string, unknown> | undefined;
    switch (msg?.type) {
      case 'examine':
        if (typeof msg.traceId === 'string' && TRACE_ID.test(msg.traceId)) this.postWaterfall(msg.traceId);
        break;
      case 'query':
        this.applyQuery(msg);
        clearTimeout(this.timer);
        this.timer = undefined;
        this.postList();
        break;
      case 'ready':
        this.applyQuery(msg);
        this.ready = true;
        this.postList();
        if (this.pendingFocus) {
          const f = this.pendingFocus;
          this.pendingFocus = undefined;
          this.postWaterfall(f.traceId, f.spanId);
        }
        break;
      case 'viewLogs':
        void this.viewLogs(msg.traceId, msg.spanId);
        break;
      case 'openLog':
        void this.openLog(msg.seq, msg.instanceId);
        break;
      case 'navigateSpan': {
        const span = typeof msg.spanId === 'string' ? this.current?.spans.get(msg.spanId) : undefined;
        if (span) void openCodeLocation(span.span.codeLocation);
        break;
      }
      case 'revealLink':
        this.revealLink(msg.traceId, msg.spanId);
        break;
      case 'copy':
        if (typeof msg.text === 'string' && (TRACE_ID.test(msg.text) || SPAN_ID.test(msg.text))) {
          void vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`Copied ${msg.text}`, 2000);
        }
        break;
    }
  }

  private async viewLogs(traceId: unknown, spanId: unknown): Promise<void> {
    const cur = this.current;
    if (!cur || traceId !== cur.traceId) return;
    let instanceId: string | undefined;
    if (spanId !== undefined) {
      const span = typeof spanId === 'string' ? cur.spans.get(spanId) : undefined;
      if (!span) return;
      // Prefer the span's own instance when it actually holds logs for the span.
      const counts = this.controller.store.countLogsByInstance(cur.traceId, span.span.spanId);
      if (counts.has(span.instanceId)) instanceId = span.instanceId;
    }
    await vscode.commands.executeCommand('otel._revealLogs', { traceId: cur.traceId, spanId, instanceId });
  }

  private async openLog(seq: unknown, instanceId: unknown): Promise<void> {
    if (!Number.isInteger(seq) || typeof instanceId !== 'string' || !this.current) return;
    const log = this.controller.store.findLog(instanceId, seq as number);
    if (!log || log.traceId !== this.current.traceId) return;
    await vscode.commands.executeCommand('otel._revealLogs', {
      traceId: log.traceId,
      spanId: log.spanId,
      instanceId,
      focusSeq: log.seq,
    });
  }

  private revealLink(traceId: unknown, spanId: unknown): void {
    if (typeof traceId !== 'string' || typeof spanId !== 'string') return;
    if (!this.current?.links.has(`${traceId}/${spanId}`)) return;
    if (!this.controller.store.findTraceInstances(traceId).length) {
      vscode.window.showInformationMessage('The linked trace is not in collected data.');
      return;
    }
    this.postWaterfall(traceId, spanId);
  }

  private focus(f: TraceFocus): void {
    if (this.ready) this.postWaterfall(f.traceId, f.spanId);
    else this.pendingFocus = f;
  }

  private waterfallSignature(traceId: string): string {
    let logs = 0;
    for (const n of this.controller.store.countLogsByInstance(traceId).values()) logs += n;
    return `${traceSignature(this.controller.store.getTraceParts(traceId))}#${logs}`;
  }

  private refreshWaterfall(): void {
    const cur = this.current;
    if (cur && this.waterfallSignature(cur.traceId) !== cur.sig) this.postWaterfall(cur.traceId, undefined, true);
  }

  private postWaterfall(traceId: string, focusSpanId?: string, refresh = false): void {
    const store = this.controller.store;
    const tagged = store.getSpansForTrace(traceId);
    const sig = this.waterfallSignature(traceId);
    if (!tagged.length) {
      this.current = { traceId, spans: new Map(), links: new Set(), sig };
      void this.panel.webview.postMessage({ type: 'waterfall', traceId, gone: true });
      return;
    }
    const logs = store.getLogsForTrace(traceId, { limit: MAX_WATERFALL_LOGS });
    const resources = new Map<string, { serviceName: string; attrs: KeyValueMap }>();
    const spans = new Map<string, TaggedSpan>();
    const links = new Set<string>();
    for (const t of tagged) {
      spans.set(t.span.spanId, t);
      for (const l of t.span.links) links.add(`${l.traceId}/${l.spanId}`);
      if (resources.has(t.instanceId)) continue;
      const inst = store.getInstance(t.instanceId);
      if (inst) resources.set(t.instanceId, { serviceName: inst.serviceName, attrs: inst.resourceAttrs });
    }
    const payload = buildWaterfallPayload(traceId, tagged, logs.items, resources, {
      truncated: logs.truncated,
      linkAvailable: (id) => store.findTraceInstances(id).length > 0,
    });
    this.current = { traceId, spans, links, sig };
    void this.panel.webview.postMessage({ type: 'waterfall', ...payload, focusSpanId, refresh });
  }

  private dispose(): void {
    clearTimeout(this.timer);
    TracesPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const QUERY_HELP =
  'All terms must match. Span terms must hold on the same span: service=, name: (contains), name=, ' +
  'status=error|ok|unset, kind=server|client|…, key=value (contains), key!=value, key>n, key<n, ' +
  'has:key or dotted.key (present), -key (absent). Trace terms: dur>200ms, dur<1s, trace:abc. ' +
  'Other words match a span name or the trace ID; quote phrases with spaces.';

const STYLE = `${COLUMN_TABLE_CSS}
  .query-bar { padding-top: 0; border-bottom: none; }
  .query-bar input { flex: 1 1 auto; font-family: var(--vscode-editor-font-family, monospace); }
  .query-bar input[aria-invalid="true"] { border-color: var(--vscode-inputValidation-warningBorder, #cca700); }
  .q-errors {
    flex: 0 0 auto; padding: 4px 8px; font-size: 0.9em;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  }
  .q-errors[hidden] { display: none; }
  .toolbar { border-bottom: none; }
  .toolbar + .q-errors, .query-bar { border-bottom: 1px solid var(--vscode-panel-border); }
  .count { margin-left: auto; }
  .split { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .list { flex: 1 1 45%; min-height: 120px; overflow: auto; border-bottom: 2px solid var(--vscode-panel-border); }
  td.plain, td.status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  td.num, th.num { text-align: right; }
  td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  tr.selectable:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .wf-split { flex: 1 1 55%; min-height: 0; display: flex; }
  .wf { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; padding: 8px 8px 0; }
  .wf-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .wf-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-toggle { display: inline-flex; align-items: center; gap: 4px; }
  .wf-note { font-size: 0.9em; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  .wf-note[hidden], .trace-logs[hidden] { display: none; }
  .wf-rows { flex: 1 1 auto; min-height: 0; overflow: auto; padding-bottom: 8px; }
  .trace-logs { border-bottom: 1px dashed var(--vscode-panel-border); margin-bottom: 2px; }
  .log-marker {
    position: absolute; top: 1px; z-index: 1; transform: translateX(-50%);
    min-width: 10px; height: 12px; padding: 0 2px; border-radius: 6px;
    font-size: 9px; line-height: 12px; color: #fff; text-align: center; cursor: pointer;
    border: 1px solid var(--vscode-editor-background);
  }
  .log-marker:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .log-marker.clamped { border-style: dashed; }
  .log-marker.sev-error { background: var(--vscode-charts-red, #f14c4c); }
  .log-marker.sev-warn { background: var(--vscode-charts-yellow, #cca700); color: #000; }
  .log-marker.sev-info { background: var(--vscode-charts-green, #89d185); color: #000; }
  .log-marker.sev-debug { background: var(--vscode-charts-foreground, #888); }
  .sev { font-weight: 600; }
  .sev.sev-error { color: var(--vscode-errorForeground); }
  .sev.sev-warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .sd-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px; }
  .sd-log { padding: 3px 4px; border-radius: 3px; }
  .sd-log.hl { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33)); }
  .sd-msg { white-space: pre-wrap; word-break: break-word; }
  .sd-open { display: inline; margin-left: 6px; font-size: 0.9em; }
  .skew { font-size: 0.8em; padding: 0 4px; border-radius: 2px; border: 1px dashed var(--vscode-editorWarning-foreground, #cca700); }
  .sd-resource { margin-top: 12px; }
  .sd-resource summary { cursor: pointer; font-weight: 600; }
  .link {
    padding: 0; border: none; background: none; font: inherit; cursor: pointer;
    color: var(--vscode-textLink-foreground); text-align: left;
  }
  .link:hover { background: none; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .link:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .err { color: var(--vscode-errorForeground); }
  tr.selected .err { color: inherit; }
  .bar-row { display: flex; align-items: center; height: 22px; flex: 0 0 22px; font-size: 0.9em; cursor: pointer; }
  .bar-row:hover { background: var(--vscode-list-hoverBackground); }
  .bar-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .bar-row.selected .kind, .bar-row.selected .bar-dur { color: inherit; }
  .bar-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .bar-label { width: 40%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { position: relative; flex: 1; height: 14px; background: var(--vscode-editorWidget-background); border-radius: 2px; }
  .bar { position: absolute; height: 14px; background: var(--vscode-charts-blue, #3794ff); border-radius: 2px; min-width: 2px; }
  .bar.error { background: var(--vscode-charts-red, #f14c4c); }
  .bar-dur { width: 90px; text-align: right; padding-left: 8px; color: var(--vscode-descriptionForeground); }
  .svc-badge { font-size: 0.8em; padding: 0 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 4px; }
  .kind { color: var(--vscode-descriptionForeground); font-size: 0.8em; margin-left: 6px; }
  #spanDetail { flex: 0 0 40%; min-width: 260px; overflow: auto; padding: 8px; border-left: 1px solid var(--vscode-panel-border); }
  #spanDetail[hidden] { display: none; }
  .sd-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
  .sd-title { flex: 1; min-width: 0; word-break: break-word; }
  #spanDetail h4 { margin: 12px 0 4px; }
  .kv { table-layout: fixed; }
  .kv td { padding: 2px 6px; }
  .kv td.k { width: 35%; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .kv .val { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .sd-event { margin: 6px 0 10px; }
  @media (max-width: 700px) {
    .wf-split { flex-direction: column; }
    #spanDetail { flex: 0 0 auto; max-height: 50%; min-width: 0; border-left: none; border-top: 1px solid var(--vscode-panel-border); }
  }
`;

const BODY = `
<div class="toolbar">
  <select id="service" aria-label="Service"></select>
  <input id="name" type="text" placeholder="span name…" aria-label="Span name contains" style="width:140px" />
  <select id="status" aria-label="Span status"></select>
  <select id="kind" aria-label="Span kind"></select>
  <input id="attr" type="text" placeholder="attr key[=value]…" aria-label="Span attribute filter"
    title="key: attribute present · key=value: value contains text (case-insensitive) · several terms are AND'd on the same span"
    style="min-width:170px" />
  <input id="minMs" type="number" min="0" placeholder="min ms" aria-label="Minimum trace duration in ms" style="width:80px" />
  <input id="maxMs" type="number" min="0" placeholder="max ms" aria-label="Maximum trace duration in ms" style="width:80px" />
  <input id="traceIdQ" type="text" placeholder="trace id…" aria-label="Trace ID contains" style="width:120px" />
  <span class="range-picker" title="Time window, measured back from the newest trace received">
    ${RANGE_ICON_SVG}
    <select id="range" aria-label="Time range"></select>
  </span>
  <button id="columnsBtn" class="secondary" aria-haspopup="true" aria-expanded="false">Columns</button>
  <span id="count" class="count muted"></span>
</div>
<div class="toolbar query-bar">
  <input id="query" type="text" spellcheck="false" aria-label="Advanced trace query" aria-describedby="qErrors"
    placeholder='Query, e.g. service=checkout status=error dur>200ms http.status_code>=500 "GET /api"'
    title="${QUERY_HELP}" />
</div>
<div id="qErrors" class="q-errors" role="status" aria-live="polite" hidden></div>
<div class="split">
  <div id="rows" class="list rows">
    <table id="table" role="grid" aria-label="Traces">
      <colgroup id="cols"></colgroup>
      <thead><tr id="head" aria-rowindex="1"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div id="empty" class="empty">Waiting for traces…</div>
  </div>
  <div class="wf-split">
    <div id="wfMain" class="wf">
      <div class="wf-head">
        <button id="wfBack" class="secondary" title="Back to the previous trace" hidden>← Back</button>
        <div id="wfTitle" class="muted wf-title">Select a trace to view its spans.</div>
        <label class="wf-toggle"><input id="wfShowLogs" type="checkbox" /> Show logs</label>
        <button id="wfViewLogs" class="secondary" disabled>View logs for trace</button>
        <button id="wfCopy" class="secondary" disabled>Copy trace ID</button>
      </div>
      <div id="wfNote" class="wf-note" role="status" hidden></div>
      <div id="wfTraceLogs" class="bar-row trace-logs" hidden></div>
      <div id="wf" class="wf-rows" role="tree" aria-label="Spans"></div>
    </div>
    <aside id="spanDetail" aria-label="Span details" hidden></aside>
  </div>
</div>
<div id="columnsPanel" class="popover" role="dialog" aria-label="Choose columns" hidden>
  <div class="popover-head">
    <input id="colSearch" type="text" placeholder="Search columns…" aria-label="Search columns" />
    <button id="colReset" class="secondary" title="Restore default columns, order and widths">Reset</button>
  </div>
  <div id="colList"></div>
</div>
`;
