import * as path from 'path';
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { StoredLogRecord } from '../store/model';
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
import { getNonce, getUri, htmlShell } from './webviewUtil';

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

export class LogsPanel {
  private static panels = new Map<string, LogsPanel>();

  private disposables: vscode.Disposable[] = [];
  // Cursor into the instance's log sequence; only records past it are posted.
  private lastPostedSeq = 0;
  private lastOldestSeq = -1;
  private ready = false;
  private pendingPrompt = false;

  static show(controller: OtelController, instanceId: string): void {
    const existing = LogsPanel.panels.get(instanceId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }    const inst = controller.store.getInstance(instanceId);
    const title = inst ? `Logs: ${inst.serviceName}` : 'Logs';
    const panel = vscode.window.createWebviewPanel('otel.logs', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
    });
    LogsPanel.panels.set(instanceId, new LogsPanel(panel, controller, instanceId));
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
    const msg = m as { type?: string; seq?: number; lastSeq?: number; key?: string };
    if (msg?.type === 'navigate' && typeof msg.seq === 'number') {
      await this.navigateToCode(msg.seq);
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
    }
  }

  private async navigateToCode(seq: number): Promise<void> {
    const log = this.controller.store.findLog(this.instanceId, seq);
    const loc = log?.codeLocation;
    if (!loc) {
      vscode.window.showInformationMessage(
        'No code location on this log (requires code.filepath / code.lineno attributes).'
      );
      return;
    }
    const uri = await resolveWorkspaceFile(loc.filepath);
    if (!uri) {
      vscode.window.showWarningMessage(`Could not locate file: ${loc.filepath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = Math.max(0, (loc.line ?? 1) - 1);
    const pos = new vscode.Position(line, Math.max(0, (loc.column ?? 1) - 1));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
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

async function resolveWorkspaceFile(filepath: string): Promise<vscode.Uri | undefined> {
  if (path.isAbsolute(filepath)) {
    const uri = vscode.Uri.file(filepath);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      /* fall through to workspace search */
    }
  }
  const base = path.basename(filepath);
  const matches = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 5);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const rel = filepath.replace(/\\/g, '/');
    return matches.find((u) => u.path.endsWith(rel)) ?? matches[0];
  }
  return undefined;
}

const STYLE = `
  .rows { overflow: auto; }
  table { table-layout: fixed; }
  th.sortable { cursor: pointer; }
  th .sort-ind { margin-left: 4px; opacity: 0.8; }
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
  .col-resizer {
    position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
    cursor: col-resize; user-select: none; z-index: 3; touch-action: none;
  }
  .col-resizer::after {
    content: ''; position: absolute; top: 20%; right: 3px; width: 1px; height: 60%;
    background: var(--vscode-panel-border);
  }
  th:hover .col-resizer::after { background: var(--vscode-focusBorder); }
  body.col-resizing { cursor: col-resize; user-select: none; }
  tr.spacer td { padding: 0; border: 0; }
  th.measuring, td.measuring { white-space: nowrap !important; }

  .popover {
    position: fixed; z-index: 20; min-width: 280px; max-width: 360px;
    max-height: 70vh; overflow: auto; padding: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .popover[hidden] { display: none; }
  .popover-head { display: flex; gap: 6px; margin-bottom: 6px; }
  .popover-head input { flex: 1 1 auto; min-width: 0; }
  .col-group {
    margin: 10px 0 2px; font-size: 0.82em; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
  }
  .col-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 4px; border-radius: 3px;
  }
  .col-item:hover { background: var(--vscode-list-hoverBackground); }
  .col-item label {
    display: flex; align-items: center; gap: 6px;
    flex: 1 1 auto; min-width: 0; cursor: pointer;
  }
  .col-item label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shown-item { cursor: grab; }
  .shown-item.dragging { opacity: 0.4; }
  .shown-item.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .shown-item.drop-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .drag-handle { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
  .hide-btn {
    flex: 0 0 auto; background: none; border: none; padding: 0 4px;
    color: var(--vscode-descriptionForeground); cursor: pointer;
  }
  .hide-btn:hover { background: none; color: var(--vscode-foreground); }
  .col-note { padding: 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }

  .range-picker {
    display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 3px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  }
  .range-picker:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .range-picker .range-icon { flex: 0 0 auto; opacity: 0.8; }
  .range-picker select { border: none; background: transparent; color: inherit; font-size: 0.9em; padding: 2px 0; }
  .range-picker select:focus { outline: none; }

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
  <button id="pause" class="secondary" aria-pressed="false" title="Freeze the view; logs keep arriving in the background">Pause</button>
  <button id="columnsBtn" class="secondary" aria-haspopup="true" aria-expanded="false">Columns</button>
  <button id="exportBtn" class="secondary">Export…</button>
  <span id="roBadge" class="ro-badge" hidden></span>
  <button id="nav" class="secondary">Navigate To Code</button>
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
