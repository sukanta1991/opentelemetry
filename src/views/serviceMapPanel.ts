// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readBaselineSettings, readServiceMapThresholds } from '../settings';
import { BaselineStatusState } from '../status';
import { LIVE_REALM, TaggedSpan } from '../store/store';
import { BaselineDeps, captureBaseline, showBaselineMenu } from './baselineActions';
import { ComparisonResult } from './baselineCompare';
import { BaselineInfo, ColorMode, baselineInfo, buildComparedMap, buildSnapshotMap, compareDetails, snapshotDetails } from './baselineMap';
import { BaselineRegistry, StoredBaseline } from './baselineRegistry';
import { openCodeLocation } from './codeNav';
import { LogsPanel } from './logsPanel';
import { MetricsPanel } from './metricsPanel';
import { revealTrace } from './navigation';
import { MapSelection, NodeDetails, ServiceMapModel, buildNodeDetails, buildServiceMap } from './serviceMapModel';
import { TracesPanel } from './tracesPanel';
import { HostMessage, OpenTarget, ViewMessage, bucketEndMs, parseMapMessage } from './webview/serviceMapView';
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

export interface BaselineServices {
  registry: BaselineRegistry;
  status(state: BaselineStatusState | undefined): void;
}

// A realm (live data or one loaded session file), or two baselines compared read-only.
type MapSource = { kind: 'realm'; realm: string } | { kind: 'compare'; a: string; b: string };

export class ServiceMapPanel {
  private static panels = new Map<string, ServiceMapPanel>();
  private static baselines: BaselineServices | undefined;
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
  // Baseline mode is the default while a baseline is active; a newly activated baseline turns it back on.
  private colorMode: ColorMode = 'baseline';
  private activeId: string | undefined;
  private baseline: StoredBaseline | undefined;
  private against: StoredBaseline | undefined;
  private loadToken = 0;
  // Model and comparison are reused until data, range, baseline or settings change (selection alone does not).
  private dataVersion = 0;
  private cacheKey = '';
  private comparison: ComparisonResult | null = null;

  // Called once at activation; panels then follow the registry's active baseline.
  static useBaselines(services: BaselineServices): vscode.Disposable {
    ServiceMapPanel.baselines = services;
    const sub = services.registry.onDidChange(() => {
      for (const p of ServiceMapPanel.panels.values()) p.onBaselinesChanged();
    });
    return {
      dispose: () => {
        sub.dispose();
        if (ServiceMapPanel.baselines === services) ServiceMapPanel.baselines = undefined;
      },
    };
  }

  static show(controller: OtelController, realm = LIVE_REALM): void {
    const source = realm === LIVE_REALM ? undefined : controller.store.getSession(realm)?.source;
    ServiceMapPanel.open(controller, { kind: 'realm', realm }, source ? `Service Map: ${source}` : 'OpenTelemetry Service Map');
  }

  static showComparison(controller: OtelController, a: string, b: string): void {
    const reg = ServiceMapPanel.baselines?.registry;
    const name = (id: string) => reg?.get(id)?.name ?? 'baseline';
    ServiceMapPanel.open(controller, { kind: 'compare', a, b }, `Baselines: ${name(a)} → ${name(b)}`);
  }

  private static open(controller: OtelController, source: MapSource, title: string): void {
    const key = ServiceMapPanel.keyOf(source);
    const existing = ServiceMapPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel('otel.serviceMap', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
    });
    ServiceMapPanel.panels.set(key, new ServiceMapPanel(panel, controller, source));
  }

  private static keyOf(s: MapSource): string {
    return s.kind === 'realm' ? s.realm : `compare:${s.a}:${s.b}`;
  }

  private get realm(): string {
    return this.source.kind === 'realm' ? this.source.realm : LIVE_REALM;
  }

  private get readOnly(): boolean {
    return this.source.kind === 'compare';
  }

  private get deps(): BaselineDeps | undefined {
    const registry = ServiceMapPanel.baselines?.registry;
    if (!registry) return undefined;
    return { controller: this.controller, registry, openComparison: (a, b) => ServiceMapPanel.showComparison(this.controller, a, b) };
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly source: MapSource
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
      this.controller.store.onDidChange(() => {
        this.dataVersion++;
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('otel.serviceMap')) this.schedule(true);
      })
    );
    this.activeId = ServiceMapPanel.baselines?.registry.activeId;
    void this.loadBaselines();
  }

  private onBaselinesChanged(): void {
    const id = ServiceMapPanel.baselines?.registry.activeId;
    if (id !== this.activeId) {
      this.activeId = id;
      if (id) this.colorMode = 'baseline';
    }
    void this.loadBaselines();
  }

  // Bodies load asynchronously; a newer call wins over one still in flight.
  private async loadBaselines(): Promise<void> {
    const registry = ServiceMapPanel.baselines?.registry;
    const token = ++this.loadToken;
    const [a, b] = this.source.kind === 'compare' ? [this.source.a, this.source.b] : [this.activeId, undefined];
    const baseline = a && registry ? await registry.load(a) : undefined;
    const against = b && registry ? await registry.load(b) : undefined;
    if (token !== this.loadToken) return;
    if (a && !baseline && registry?.get(a)?.unavailable) {
      vscode.window.showWarningMessage(`Baseline “${registry.get(a)!.name}” could not be read. Delete it or capture a new one.`);
    }
    this.baseline = baseline;
    this.against = against;
    this.schedule(true);
  }

  private onMessage(m: unknown): void {
    const msg = parseMapMessage(m, {
      seq: this.seq,
      model: this.model,
      details: this.details,
      selection: this.selection,
      readOnly: this.readOnly,
    });
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.range = msg.range;
        this.selection = msg.selection;
        if (msg.colorMode) this.colorMode = msg.colorMode;
        // A reloaded webview has no state; force the next update through.
        this.lastSig = '';
        return this.schedule(true);
      case 'setRange':
        this.range = msg.range;
        return this.schedule(true);
      case 'select':
        this.selection = msg.selection;
        return this.schedule(true);
      case 'setColorMode':
        this.colorMode = msg.colorMode;
        return this.schedule(true);
      default:
        this.runAction(msg).catch((err) =>
          vscode.window.showErrorMessage(`Service map: ${err instanceof Error ? err.message : String(err)}`)
        );
    }
  }

  private async runAction(msg: ViewMessage): Promise<void> {
    const details = this.details;
    const deps = this.deps;
    if (msg.type === 'open') {
      const sel = this.selection;
      const node = sel?.kind === 'node' ? this.model?.nodes.find((n) => n.id === sel.id) : undefined;
      if (node) await this.openForService(node.label, msg.target);
    } else if (msg.type === 'revealTrace' && details) {
      if (msg.list === 'baseline') {
        revealTrace(this.controller, { traceId: details.baselineTraces![msg.index] });
        return;
      }
      const ref = (msg.list === 'error' ? details.errorTraces : details.slowTraces)[msg.index];
      revealTrace(this.controller, { traceId: ref.traceId, spanId: ref.spanId, preferInstanceId: ref.instanceId });
    } else if (msg.type === 'openSource' && details) {
      await openCodeLocation(details.sources[msg.index].location);
    } else if (msg.type === 'baselineMenu' && deps) {
      await showBaselineMenu(deps, {
        realm: this.realm,
        model: this.model,
        readOnly: this.readOnly,
        compare: this.source.kind === 'compare' ? { a: this.source.a, b: this.source.b } : undefined,
      });
    } else if (msg.type === 'captureAtBucket' && deps && this.model) {
      await captureBaseline(deps, this.realm, 'time', { toMs: bucketEndMs(this.model, msg.index) });
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
    const gone =
      this.source.kind === 'compare'
        ? !this.baseline || !this.against
        : this.realm !== LIVE_REALM && !this.controller.store.getSession(this.realm);
    if (gone) {
      this.model = null;
      this.details = null;
      this.selection = null;
      msg = { type: 'gone' };
      sig = 'gone';
    } else {
      try {
        const { model, details, baseline } = this.build();
        if (!details) this.selection = null;
        const colorMode = this.baseline ? this.colorMode : 'absolute';
        sig = JSON.stringify([model, details, colorMode, baseline, !!this.baseline]);
        this.model = model;
        this.details = details;
        msg = {
          type: 'update',
          seq: this.seq + 1,
          model,
          details,
          colorMode,
          baseline,
          hasBaseline: !!this.baseline,
          readOnly: this.readOnly,
        };
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

  private build(): { model: ServiceMapModel; details: NodeDetails | null; baseline: BaselineInfo | null } {
    const thresholds = readServiceMapThresholds();
    const store = this.controller.store;
    const hasTrace = (traceId: string) => store.findTraceInstances(traceId).length > 0;
    const label = (b: StoredBaseline) => ServiceMapPanel.baselines?.registry.get(b.meta.id) ?? b.meta;
    if (this.source.kind === 'compare') {
      const [a, b] = [this.baseline!, this.against!];
      const { model, comparison } = buildSnapshotMap(a.snapshot, b.snapshot, readBaselineSettings(), { thresholds });
      const details = (this.selection && comparison && snapshotDetails(model, comparison, this.selection, hasTrace)) || null;
      return { model, details, baseline: baselineInfo(label(a), a.snapshot, comparison, { against: label(b).name }) };
    }

    const base = this.colorMode === 'baseline' ? this.baseline : undefined;
    const settings = base ? readBaselineSettings() : null;
    const key = JSON.stringify([this.dataVersion, this.range, base?.meta.id ?? null, settings, thresholds]);
    let tagged: TaggedSpan[] | undefined;
    if (key !== this.cacheKey || !this.model) {
      tagged = store.getAllTaggedSpans(this.realm);
      if (base && settings) {
        const built = buildComparedMap(tagged, { range: this.range, thresholds }, base.snapshot, settings, this.realm);
        this.model = built.model;
        this.comparison = built.comparison;
      } else {
        this.model = buildServiceMap(tagged, { range: this.range, thresholds });
        this.comparison = null;
      }
      this.cacheKey = key;
    }
    const model = this.model;
    let details: NodeDetails | null = null;
    if (this.selection) {
      details = buildNodeDetails(tagged ?? store.getAllTaggedSpans(this.realm), model, this.selection) ?? null;
      if (details && this.comparison) details = compareDetails(details, this.comparison, hasTrace);
    }
    const info = base ? baselineInfo(label(base), base.snapshot, this.comparison, { cutoffMs: model.cutoffMs }) : null;
    if (this.realm === LIVE_REALM) this.reportStatus(info);
    return { model, details, baseline: info };
  }

  // The live map feeds the status bar; other maps never touch it.
  private reportStatus(info: BaselineInfo | null): void {
    const services = ServiceMapPanel.baselines;
    const active = services?.registry.activeId ? services.registry.get(services.registry.activeId) : undefined;
    if (!services) return;
    if (!active) return services.status(undefined);
    if (!info) return services.status({ name: active.name });
    const summary = info.summary ? { regressed: info.summary.regressed, improved: info.summary.improved } : undefined;
    services.status({ name: info.name, summary, waiting: info.waiting });
  }

  private dispose(): void {
    ServiceMapPanel.panels.delete(ServiceMapPanel.keyOf(this.source));
    if (this.source.kind === 'realm' && this.realm === LIVE_REALM) this.reportStatus(null);
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
  .verdict-regressed { --h: var(--vscode-errorForeground, #f14c4c); }
  .verdict-improved { --h: var(--vscode-charts-blue, #3794ff); }
  .verdict-new { --h: var(--vscode-charts-purple, #b180d7); }
  .verdict-unchanged, .verdict-none { --h: var(--vscode-descriptionForeground, #8b8b8b); }
  .verdict-removed, .verdict-insufficient, .verdict-untracked { --h: var(--vscode-disabledForeground, #8b8b8b); }
  .glyph { color: var(--h); fill: var(--h); }
  #rangePicker[hidden], .toolbar button[hidden] { display: none; }
  .badge.warn {
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
  }
  button.toggle[aria-pressed="true"] {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }

  .node { cursor: pointer; outline: none; }
  .node .shape { --t: var(--vscode-editor-background); fill: var(--t); stroke: var(--h); stroke-width: 2; }
  .node.service .shape { --t: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .node.database .shape { --t: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 16%, var(--vscode-editor-background)); }
  .node.queue .shape { --t: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 16%, var(--vscode-editor-background)); }
  .node.external .shape { --t: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 16%, var(--vscode-editor-background)); }
  .node.health-idle .shape { stroke-dasharray: 4 3; }
  .node.ghost .shape, .node.verdict-removed .shape { stroke-dasharray: 2 3; }
  .node.ghost { opacity: 0.75; }
  .node.verdict-regressed .shape, .node.verdict-improved .shape { stroke-width: 3; }
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
  .edge-group.ghost .edge, .edge-group.verdict-removed .edge { stroke-dasharray: 2 3; }
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
  #details td.glyph { width: 1.2em; }
  #details .activity { display: block; margin: 4px 0; }
  #details .activity .bar { fill: var(--vscode-charts-blue, #3794ff); opacity: 0.7; cursor: pointer; }
  #details .activity .bar:hover { opacity: 1; fill: var(--vscode-focusBorder, #007fd4); }
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
  <span id="rangePicker" class="range-picker" title="Time window, measured back from the newest span received">
    ${RANGE_ICON_SVG}<select id="range" aria-label="Time window"></select>
  </span>
  <button id="fit" class="secondary" title="Fit the whole map in view">Fit</button>
  <button id="relayout" class="secondary" title="Recompute the layout">Re-layout</button>
  <button id="mode" class="secondary toggle" aria-pressed="false" hidden title="Colour the map by change against the active baseline instead of by health">vs Baseline</button>
  <button id="baselineMenu" class="secondary" title="Capture, switch, save, compare, export or import baselines">Baseline…</button>
  <span id="asOf" class="muted"></span>
  <span id="baselineBadge" class="badge" hidden></span>
  <span id="coverage" class="badge warn" hidden></span>
  <span id="partial" class="badge" hidden>partial window</span>
  <span id="hiddenNodes" class="badge" hidden></span>
  <span id="legend" class="legend" aria-label="Legend"></span>
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
