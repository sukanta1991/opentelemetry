import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { StoredLogRecord } from '../store/model';
import { openCodeLocation } from './codeNav';
import {
  ExportData,
  ExportFormat,
  defaultExportFileName,
  pickNewest,
  serializeExport,
} from './logExport';
import { serializeLog } from './logSerialize';
import { isLogColumnId } from './webview/logColumns';
import { WireLog } from './webview/logView';
import { COLUMN_TABLE_CSS, getNonce, getUri, htmlShell } from './webviewUtil';

// Settings the webview may ask the host to reveal; never pass through an arbitrary key.
const OPENABLE_SETTINGS = new Set(['otel.retention.maxLogsPerInstance']);

interface ExportRequest {
  format?: unknown;
  data?: unknown;
  scope?: unknown;
  count?: unknown;
  columns?: unknown[];
  seqs?: number[];
}

function isExportFormat(v: unknown): v is ExportFormat {
  return v === 'otlp' || v === 'json' || v === 'csv';
}

export interface LogsCorrelation {
  traceId: string;
  spanId?: string;
  focusSeq?: number;
}

export interface LogsShowOptions {
  correlate?: LogsCorrelation;
}

export class LogsPanel {
  private static panels = new Map<string, LogsPanel>();

  private disposables: vscode.Disposable[] = [];
  // Cursor into the instance's log sequence; only records past it are posted.
  private lastPostedSeq = 0;
  private lastOldestSeq = -1;
  private ready = false;
  private pendingPrompt = false;
  private pendingCorrelate: LogsCorrelation | undefined;

  static show(controller: OtelController, instanceId: string, opts: LogsShowOptions = {}): void {
    let target = LogsPanel.panels.get(instanceId);
    if (target) {
      target.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const inst = controller.store.getInstance(instanceId);
      const title = inst ? `Logs: ${inst.serviceName}` : 'Logs';
      const panel = vscode.window.createWebviewPanel('otel.logs', title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
      });
      target = new LogsPanel(panel, controller, instanceId);
      LogsPanel.panels.set(instanceId, target);
    }
    if (opts.correlate) target.correlate(opts.correlate);
  }

  // Opens the panel (creating it if needed) and asks it to show the export options modal.
  static exportFrom(controller: OtelController, instanceId: string): void {
    LogsPanel.show(controller, instanceId);
    LogsPanel.panels.get(instanceId)?.promptExport();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly instanceId: string
  ) {
    const scriptUri = getUri(
      this.panel.webview,
      controller.extensionUri,
      'dist',
      'webview',
      'logsTable.js'
    );
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, '', STYLE, [scriptUri]);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.disposables.push(this.controller.store.onDidChange(() => this.postData()));
    this.postData();
  }

  private postData(): void {
    const store = this.controller.store;
    const inst = store.getInstance(this.instanceId);
    if (!inst) {
      if (this.lastPostedSeq !== 0 || this.lastOldestSeq !== -1) this.reset();
      return;
    }
    // A removed-and-recreated instance restarts its seq counter, so the cursor is stale.
    if (inst.nextLogSeq - 1 < this.lastPostedSeq) this.reset();

    const delta = store.getLogsSince(this.instanceId, this.lastPostedSeq);
    if (!delta.records.length && delta.oldestSeq === this.lastOldestSeq) return;

    const records: WireLog[] = delta.records.slice();
    if (records.length) this.lastPostedSeq = records[records.length - 1].seq;
    this.lastOldestSeq = delta.oldestSeq;
    void this.panel.webview.postMessage({
      type: 'append',
      records,
      oldestSeq: delta.oldestSeq,
      total: delta.total,
    });
  }

  private reset(): void {
    this.lastPostedSeq = 0;
    this.lastOldestSeq = -1;
    void this.panel.webview.postMessage({ type: 'reset' });
  }

  private async onMessage(m: unknown): Promise<void> {
    const msg = m as { type?: string; seq?: number; lastSeq?: number; key?: string; scope?: string };
    if (msg?.type === 'navigate' && typeof msg.seq === 'number') {
      await this.navigateToCode(msg.seq);
    } else if (msg?.type === 'viewTrace' && Number.isInteger(msg.seq)) {
      await this.viewTrace(msg.seq as number, msg.scope === 'span');
    } else if (msg?.type === 'openInEditor' && typeof msg.seq === 'number') {
      await this.openInEditor(msg.seq);
    } else if (msg?.type === 'openSetting' && OPENABLE_SETTINGS.has(msg.key as string)) {
      await vscode.commands.executeCommand('workbench.action.openSettings', msg.key);
    } else if (msg?.type === 'export') {
      await this.exportLogs(m as ExportRequest);
    } else if (msg?.type === 'ready') {
      this.ready = true;
      this.lastPostedSeq = typeof msg.lastSeq === 'number' && msg.lastSeq > 0 ? msg.lastSeq : 0;
      this.lastOldestSeq = -1;
      const inst = this.controller.store.getInstance(this.instanceId);
      void this.panel.webview.postMessage({
        type: 'mode',
        readOnly: inst?.kind === 'imported',
        source: inst?.source,
      });
      this.postData();
      if (this.pendingPrompt) {
        this.pendingPrompt = false;
        void this.panel.webview.postMessage({ type: 'promptExport' });
      }
      if (this.pendingCorrelate) {
        const c = this.pendingCorrelate;
        this.pendingCorrelate = undefined;
        this.postCorrelate(c);
      }
    }
  }

  private correlate(c: LogsCorrelation): void {
    if (this.ready) this.postCorrelate(c);
    else this.pendingCorrelate = c;
  }

  private postCorrelate(c: LogsCorrelation): void {
    void this.panel.webview.postMessage({
      type: 'correlate',
      traceId: c.traceId,
      spanId: c.spanId,
      focusSeq: c.focusSeq,
    });
  }

  // Ids come from the stored record, never from the webview message.
  private async viewTrace(seq: number, withSpan: boolean): Promise<void> {
    const log = this.controller.store.findLog(this.instanceId, seq);
    if (!log?.traceId) {
      vscode.window.showInformationMessage('This log has no trace context.');
      return;
    }
    await vscode.commands.executeCommand('otel._revealTrace', {
      traceId: log.traceId,
      spanId: withSpan ? log.spanId : undefined,
      preferInstanceId: this.instanceId,
    });
  }

  private async navigateToCode(seq: number): Promise<void> {
    await openCodeLocation(this.controller.store.findLog(this.instanceId, seq)?.codeLocation);
  }

  private async openInEditor(seq: number): Promise<void> {
    const log = this.controller.store.findLog(this.instanceId, seq);
    if (!log) return;
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(serializeLog(log), null, 2),
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  // Opens the in-panel export options modal, deferring until the webview is ready.
  promptExport(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
    if (this.ready) void this.panel.webview.postMessage({ type: 'promptExport' });
    else this.pendingPrompt = true;
  }

  private async exportLogs(req: ExportRequest): Promise<void> {
    const inst = this.controller.store.getInstance(this.instanceId);
    if (!inst) return;

    const format = isExportFormat(req.format) ? req.format : 'json';
    const mode: ExportData = req.data === 'all' ? 'all' : 'grid';
    const columns = (req.columns ?? []).filter(isLogColumnId);

    // The webview already resolved scope and ordering; the host only maps ids back to records.
    const seqs = Array.isArray(req.seqs) ? req.seqs : [];
    const records: StoredLogRecord[] = [];
    for (const seq of seqs) {
      const log = this.controller.store.findLog(this.instanceId, seq);
      if (log) records.push(log);
    }
    const selected = pickNewest(records, typeof req.count === 'number' ? req.count : 0);
    if (!selected.length) {
      vscode.window.showInformationMessage('No logs matched the export scope.');
      return;
    }

    const fileName = defaultExportFileName(inst.serviceName, format);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export Logs',
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : vscode.Uri.file(fileName),
    });
    if (!uri) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting logs…' },
      async () => {
        const text = serializeExport(
          format,
          selected,
          {
            serviceName: inst.serviceName,
            serviceInstanceId: inst.serviceInstanceId,
            resourceAttrs: inst.resourceAttrs,
          },
          mode,
          columns
        );
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
      }
    );
    vscode.window.showInformationMessage(
      `Exported ${selected.length} log${selected.length === 1 ? '' : 's'}.`
    );
  }

  private dispose(): void {
    LogsPanel.panels.delete(this.instanceId);
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const STYLE = `${COLUMN_TABLE_CSS}
  .rows { overflow: auto; }
  td.msg { word-break: break-word; overflow-wrap: anywhere; }
  td.attrs { color: var(--vscode-descriptionForeground); font-size: 0.9em; word-break: break-word; overflow-wrap: anywhere; }
  td.time, td.sev, td.plain { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Long-text cells wrap inside an inner box so the clamp never changes td display. */
  .clamp { line-height: 1.35; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  body:not([data-density="raw"]) .clamp {
    display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
    -webkit-line-clamp: var(--log-line-clamp);
    /* Fixed height keeps every row identical, which lets the virtualizer skip measuring. */
    height: calc(var(--log-line-clamp) * 1.35em);
  }
  body[data-density="condensed"] th, body[data-density="condensed"] td { padding: 1px 8px; }
  .sev { font-weight: 600; }
  .sev-error, .sev-fatal { color: var(--vscode-errorForeground); }
  .sev-warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .count { margin-left: auto; }

  .hint {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; font-size: 0.9em;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  }
  .hint[hidden] { display: none; }
  .hint button { flex: 0 0 auto; }

  th.selcol, td.selcol { text-align: center; padding-left: 4px; padding-right: 4px; }
  th.selcol input, td.selcol input { margin: 0; vertical-align: middle; }
  tr.focused td:first-child { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
  button[aria-pressed="true"] {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .backdrop {
    position: fixed; inset: 0; z-index: 30;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45);
  }
  .backdrop[hidden] { display: none; }
  .modal {
    width: 380px; max-width: 92vw; max-height: 86vh; overflow: auto; padding: 14px 16px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 5px; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
  }
  .modal-title { margin: 0 0 10px; font-size: 1.05em; font-weight: 600; }
  .modal-group { border: none; margin: 0 0 10px; padding: 0; }
  .modal-group legend {
    padding: 0; margin-bottom: 4px; font-size: 0.82em; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
  }
  .modal-group label { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
  .modal-group label.inline { gap: 8px; }
  .modal-group[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
  .modal-note { margin: 4px 0 0; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .modal-note[hidden] { display: none; }
  .modal-summary {
    margin: 12px 0; padding: 6px 8px; border-radius: 3px; font-size: 0.9em;
    background: var(--vscode-textBlockQuote-background, var(--vscode-editor-background));
  }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }

  .ro-badge {
    padding: 1px 6px; border-radius: 3px; font-size: 0.85em;
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
  }
  .ro-badge[hidden] { display: none; }

  .chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 1px 2px 1px 8px;
    border-radius: 10px; font-size: 0.9em;
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
  }
  .chip[hidden] { display: none; }
  .chip .muted { color: inherit; opacity: 0.75; }
  .chip-clear {
    background: none; border: none; color: inherit; padding: 0 6px;
    border-radius: 8px; cursor: pointer; line-height: 1.2;
  }
  .chip-clear:hover { background: rgba(128,128,128,0.3); }
  .chip-clear:focus-visible { outline: 1px solid var(--vscode-focusBorder); }

  .link {
    display: block; max-width: 100%; padding: 0; border: none; background: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left;
    font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer;
  }
  .link:hover { background: none; color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`;

const BODY = `
<div class="toolbar">
  <input id="q" type="text" placeholder="Filter text..." style="min-width:180px" />
  <select id="level" aria-label="Minimum severity"></select>
  <input id="attr" type="text" placeholder="attr=value" style="min-width:140px" />
  <span class="range-picker" title="Time window, measured back from the newest log received">
    <svg class="range-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5A5.5 5.5 0 1 1 8 13.5 5.5 5.5 0 0 1 8 2.5zM7.25 4v4.31l3 1.73.75-1.3-2.25-1.3V4h-1.5z"/></svg>
    <select id="range" aria-label="Time range"></select>
  </span>
  <select id="density" aria-label="Row height"></select>
  <span id="corrChip" class="chip" role="status" hidden>
    <span id="corrLabel"></span>
    <span class="muted">· time range ignored</span>
    <button id="corrClear" class="chip-clear" aria-label="Clear trace filter" title="Clear trace filter (Esc)">×</button>
  </span>
  <button id="pause" class="secondary" aria-pressed="false" title="Freeze the view; logs keep arriving in the background">Pause</button>
  <button id="columnsBtn" class="secondary" aria-haspopup="true" aria-expanded="false">Columns</button>
  <button id="exportBtn" class="secondary">Export…</button>
  <span id="roBadge" class="ro-badge" hidden></span>
  <button id="nav" class="secondary">Navigate To Code</button>
  <button id="viewTrace" class="secondary" title="Open the focused log's trace waterfall" disabled>View Trace</button>
  <button id="open" class="secondary">Open In Editor</button>
  <span id="count" class="count muted"></span>
</div>
<div id="retentionHint" class="hint" hidden>
  <span id="hintText"></span>
  <button id="hintBtn" class="secondary">Increase retention…</button>
</div>
<div class="rows"><table>
<colgroup id="cols"></colgroup>
<thead><tr id="head"></tr></thead>
<tbody id="tbody"></tbody></table>
<div id="empty" class="empty">Waiting for logs…</div>
</div>
<div id="columnsPanel" class="popover" role="dialog" aria-label="Choose columns" hidden>
  <div class="popover-head">
    <input id="colSearch" type="text" placeholder="Search columns…" aria-label="Search columns" />
    <button id="colReset" class="secondary" title="Restore default columns, order and widths">Reset</button>
  </div>
  <div id="colList"></div>
</div>
<div id="exportBackdrop" class="backdrop" hidden>
  <div id="exportDialog" class="modal" role="dialog" aria-modal="true" aria-label="Export logs">
    <h2 class="modal-title">Export logs</h2>

    <fieldset class="modal-group">
      <legend>Format</legend>
      <label><input type="radio" name="exFormat" value="json" checked /> <span>Plain JSON</span></label>
      <label><input type="radio" name="exFormat" value="otlp" /> <span>OTLP/JSON</span></label>
      <label><input type="radio" name="exFormat" value="csv" /> <span>CSV</span></label>
    </fieldset>

    <fieldset class="modal-group" id="exDataGroup">
      <legend>Data</legend>
      <label><input type="radio" name="exData" value="grid" checked /> <span>Grid columns</span></label>
      <label><input type="radio" name="exData" value="all" /> <span>All attributes</span></label>
      <p class="modal-note" id="exDataNote" hidden>OTLP/JSON always exports full fidelity.</p>
    </fieldset>

    <fieldset class="modal-group">
      <legend>Scope</legend>
      <label><input type="radio" name="exScope" value="filtered" checked /> <span>Filtered rows</span></label>
      <label><input type="radio" name="exScope" value="all" /> <span>All retained logs</span></label>
      <label><input type="radio" name="exScope" value="selected" id="exScopeSelected" /> <span>Selected rows</span></label>
    </fieldset>

    <fieldset class="modal-group" id="exCountGroup">
      <legend>Log count</legend>
      <label class="inline">
        <input id="exCount" type="number" min="0" step="1" value="100" style="width:90px" />
        <span class="muted">newest; blank or 0 exports all</span>
      </label>
    </fieldset>

    <p class="modal-summary" id="exSummary"></p>
    <div class="modal-actions">
      <button id="exCancel" class="secondary">Cancel</button>
      <button id="exGo">Export</button>
    </div>
  </div>
</div>
`;
