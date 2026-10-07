// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readServiceMapThresholds } from '../settings';
import { LIVE_REALM } from '../store/store';
import { openCodeLocation } from './codeNav';
import { LogsPanel } from './logsPanel';
import { MetricsPanel } from './metricsPanel';
import { revealTrace } from './navigation';
import { MapSelection, NodeDetails, ServiceMapModel, buildNodeDetails, buildServiceMap } from './serviceMapModel';
import { TracesPanel } from './tracesPanel';
import { HostMessage, OpenTarget, ViewMessage, parseMapMessage } from './webview/serviceMapView';
import { DEFAULT_TIME_RANGE, TimeRangeKind } from './webview/timeRange';
import {
  RANGE_ICON_SVG,
  RANGE_PICKER_CSS,
  getNonce,
  getUri,
  htmlShell,
  timeZoneAttr,
  watchTimeZone,
} from './webviewUtil';

const REFRESH_THROTTLE_MS = 500;

// One panel per realm: live data, or one loaded session file.
export class ServiceMapPanel {
  private static panels = new Map<string, ServiceMapPanel>();
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private range: TimeRangeKind = DEFAULT_TIME_RANGE;
  private selection: MapSelection | null = null;
  // Last posted state; webview actions are validated against it.
  private seq = 0;
  private model: ServiceMapModel | null = null;
  private details: NodeDetails | null = null;
  private lastSig = '';
  private lastPost = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  static show(controller: OtelController, realm = LIVE_REALM): void {
    const existing = ServiceMapPanel.panels.get(realm);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const source = realm === LIVE_REALM ? undefined : controller.store.getSession(realm)?.source;
    const panel = vscode.window.createWebviewPanel(
      'otel.serviceMap',
      source ? `Service Map: ${source}` : 'OpenTelemetry Service Map',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
      }
    );
    ServiceMapPanel.panels.set(realm, new ServiceMapPanel(panel, controller, realm));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly realm: string
  ) {
    const scriptUri = getUri(panel.webview, controller.extensionUri, 'dist', 'webview', 'serviceMap.js');
    this.panel.webview.html = htmlShell(this.panel.webview, getNonce(), BODY, '', STYLE, [scriptUri], timeZoneAttr());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && this.dirty) this.schedule();
      },
      null,
      this.disposables
    );
    this.disposables.push(
      watchTimeZone(this.panel.webview),
      this.controller.store.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('otel.serviceMap')) this.schedule(true);
      })
    );
  }

  private onMessage(m: unknown): void {
    const msg = parseMapMessage(m, {
      seq: this.seq,
      model: this.model,
      details: this.details,
      selection: this.selection,
    });
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.range = msg.range;
        this.selection = msg.selection;
        // A reloaded webview has no state; force the next update through.
        this.lastSig = '';
        return this.schedule(true);
      case 'setRange':
        this.range = msg.range;
        return this.schedule(true);
      case 'select':
        this.selection = msg.selection;
        return this.schedule(true);
      default:
        this.runAction(msg).catch((err) =>
          vscode.window.showErrorMessage(`Service map: ${err instanceof Error ? err.message : String(err)}`)
        );
    }
  }

  private async runAction(msg: ViewMessage): Promise<void> {
    const details = this.details;
    if (msg.type === 'open') {
      const sel = this.selection;
      const node = sel?.kind === 'node' ? this.model?.nodes.find((n) => n.id === sel.id) : undefined;
      if (node) await this.openForService(node.label, msg.target);
    } else if (msg.type === 'revealTrace' && details) {
      const ref = (msg.list === 'error' ? details.errorTraces : details.slowTraces)[msg.index];
      revealTrace(this.controller, { traceId: ref.traceId, spanId: ref.spanId, preferInstanceId: ref.instanceId });
    } else if (msg.type === 'openSource' && details) {
      await openCodeLocation(details.sources[msg.index].location);
    }
  }

  private async openForService(service: string, target: OpenTarget): Promise<void> {
    const instances = this.controller.store
      .getAllInstances()
      .filter((i) => i.realm === this.realm && i.serviceName === service)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    if (!instances.length) {
      vscode.window.showInformationMessage(`No instances of ${service} are in the collected data.`);
      return;
    }
    let id = instances[0].id;
    if (instances.length > 1) {
      const pick = await vscode.window.showQuickPick(
        instances.map((i) => ({
          label: i.serviceInstanceId ?? i.id,
          description: i.source,
          detail: `Last seen ${new Date(i.lastSeen).toLocaleTimeString()} · ${i.spanCount} spans · ${i.logCount} logs`,
          id: i.id,
        })),
        { title: `Open ${target} for ${service}`, placeHolder: 'Select an instance' }
      );
      if (!pick) return;
      id = pick.id;
    }
    if (target === 'traces') TracesPanel.show(this.controller, id);
    else if (target === 'logs') LogsPanel.show(this.controller, id);
    else MetricsPanel.show(this.controller, id);
  }

  // Hidden panels only mark themselves dirty; visible ones refresh at most every 500 ms.
  // User actions (immediate) skip the throttle so selection and range changes feel instant.
  private schedule(immediate = false): void {
    if (!this.ready) return;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    if (immediate) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.refresh();
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastPost + REFRESH_THROTTLE_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, wait);
  }

  private refresh(): void {
    this.dirty = false;
    this.lastPost = Date.now();
    let msg: HostMessage;
    let sig: string;
    if (this.realm !== LIVE_REALM && !this.controller.store.getSession(this.realm)) {
      this.model = null;
      this.details = null;
      this.selection = null;
      msg = { type: 'gone' };
      sig = 'gone';
    } else {
      try {
        const tagged = this.controller.store.getAllTaggedSpans(this.realm);
        const model = buildServiceMap(tagged, { range: this.range, thresholds: readServiceMapThresholds() });
        const details = (this.selection && buildNodeDetails(tagged, model, this.selection)) || null;
        if (!details) this.selection = null;
        sig = JSON.stringify([model, details]);
        this.model = model;
        this.details = details;
        msg = { type: 'update', seq: this.seq + 1, model, details };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        msg = { type: 'error', message };
        sig = `error:${message}`;
      }
    }
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (msg.type === 'update') this.seq = msg.seq;
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    ServiceMapPanel.panels.delete(this.realm);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const STYLE = `${RANGE_PICKER_CSS}
  #main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
  #wrap { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
  #svg { width: 100%; height: 100%; display: block; cursor: grab; user-select: none; }
  #svg.panning { cursor: grabbing; }
  .badge {
    padding: 1px 6px; border-radius: 8px; font-size: 0.85em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .legend { display: inline-flex; gap: 8px; margin-left: auto; font-size: 0.9em; }
  .health-ok { --h: var(--vscode-testing-iconPassed, #73c991); }
  .health-warn { --h: var(--vscode-editorWarning-foreground, #cca700); }
  .health-critical { --h: var(--vscode-errorForeground, #f14c4c); }
  .health-idle { --h: var(--vscode-disabledForeground, #8b8b8b); }
  .glyph { color: var(--h); fill: var(--h); }

  .node { cursor: pointer; outline: none; }
  .node .shape { --t: var(--vscode-editor-background); fill: var(--t); stroke: var(--h); stroke-width: 2; }
  .node.service .shape { --t: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .node.database .shape { --t: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 16%, var(--vscode-editor-background)); }
  .node.queue .shape { --t: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 16%, var(--vscode-editor-background)); }
  .node.external .shape { --t: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 16%, var(--vscode-editor-background)); }
  .node.health-idle .shape { stroke-dasharray: 4 3; }
  .node text { fill: var(--vscode-foreground); font-size: 12px; pointer-events: none; }
  .node .label { font-weight: 600; }
  .node .glyph { fill: var(--h); }
  .node .sub { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .node .spark { fill: none; stroke: var(--h); stroke-width: 1.2; opacity: 0.8; }
  .node.selected .shape { stroke-width: 3.5; }
  .node:focus-visible .shape { stroke: var(--vscode-focusBorder); stroke-width: 3; }
  .edge-group { cursor: pointer; outline: none; }
  .edge { fill: none; stroke: var(--h); opacity: 0.85; }
  .edge-group.health-ok .edge, .edge-group.health-idle .edge { stroke: var(--vscode-descriptionForeground); }
  .edge-group.selected .edge { opacity: 1; stroke-dasharray: 6 3; }
  .edge-group:focus-visible .edge { stroke: var(--vscode-focusBorder); }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 12; }
  .edge-label {
    fill: var(--vscode-descriptionForeground); font-size: 10px; pointer-events: none;
    paint-order: stroke; stroke: var(--vscode-editor-background); stroke-width: 3px;
  }
  #svg.zoomed-out .edge-label, #svg.zoomed-out .node .sub { display: none; }
  .arrow { fill: var(--h); }
  .arrow.health-ok, .arrow.health-idle { fill: var(--vscode-descriptionForeground); }

  #note {
    position: absolute; top: 8px; left: 50%; transform: translateX(-50%); max-width: 90%;
    padding: 4px 10px; border-radius: 3px; font-size: 0.9em;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
  }
  #note.error, #empty.error { color: var(--vscode-errorForeground); }
  #empty { position: absolute; inset: 0; }

  #details {
    flex: 0 0 340px; overflow: auto; padding: 8px 12px;
    border-left: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  #details header { display: flex; align-items: center; gap: 6px; }
  #details h2 { flex: 1 1 auto; margin: 0; font-size: 1.1em; overflow-wrap: anywhere; }
  #details h3 {
    margin: 14px 0 4px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  #details .stats { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 8px 0; }
  #details dt { color: var(--vscode-descriptionForeground); }
  #details dd { margin: 0; font-variant-numeric: tabular-nums; }
  #details .actions { display: flex; gap: 6px; margin: 8px 0; }
  #details .list { list-style: none; margin: 0; padding: 0; }
  #details .list li { padding: 2px 0; overflow-wrap: anywhere; }
  #details .list .glyph { margin-right: 4px; }
  #details td.op { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #details td.num { text-align: right; }
  button.link {
    background: none; border: none; padding: 0; text-align: left; cursor: pointer;
    color: var(--vscode-textLink-foreground);
  }
  button.link:hover { background: none; text-decoration: underline; }
  button.close { background: none; color: var(--vscode-foreground); font-size: 1.2em; padding: 0 4px; }
  button.close:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;

const BODY = `
<div class="toolbar">
  <strong>Service Map</strong>
  <span class="range-picker" title="Time window, measured back from the newest span received">
    ${RANGE_ICON_SVG}<select id="range" aria-label="Time window"></select>
  </span>
  <button id="fit" class="secondary" title="Fit the whole map in view">Fit</button>
  <button id="relayout" class="secondary" title="Recompute the layout">Re-layout</button>
  <span id="asOf" class="muted"></span>
  <span id="partial" class="badge" hidden>partial window</span>
  <span id="hiddenNodes" class="badge" hidden></span>
  <span class="legend" aria-label="Legend">
    <span class="health-ok"><span class="glyph">●</span> Healthy</span>
    <span class="health-warn"><span class="glyph">▲</span> Warning</span>
    <span class="health-critical"><span class="glyph">✖</span> Critical</span>
    <span class="health-idle"><span class="glyph">○</span> Idle</span>
  </span>
</div>
<div id="main">
  <div id="wrap">
    <svg id="svg" role="group" aria-label="Service dependency map. Tab to a service or call, Enter to show details, Escape to close."><g id="viewport"></g></svg>
    <div id="note" hidden></div>
    <div id="empty" class="empty" hidden></div>
  </div>
  <aside id="details" hidden aria-label="Selection details"></aside>
</div>
`;
