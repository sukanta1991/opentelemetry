// SPDX-License-Identifier: Apache-2.0
// Cardinality and cost panel: one per window. Builds the model for the chosen scope, posts the active tab's
// rows, answers detail requests and keeps pricing overrides in workspace state.

import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readCardinalitySettings, readPricing } from '../settings';
import { byCodeUnit } from '../compare';
import { LIVE_REALM } from '../store/store';
import { BaselineRegistry, StoredBaseline } from './baselineRegistry';
import { captureCardinality } from './cardinalityBaseline';
import { PRICING_OVERRIDES_KEY, effectivePricing, estimateCost } from './cardinalityCost';
import { CardinalityModel, buildCardinalityModel, dailyUsage } from './cardinalityModel';
import { baselineView, detailTables, detailsOf, pricingView, summaryOf, tabData } from './cardinalityPayload';
import { CardinalitySettings } from './cardinalityRules';
import {
  BaselineView,
  DEFAULT_TAB,
  HostContext,
  HostMessage,
  PanelScope,
  ScopeOptions,
  Tab,
  ViewMessage,
  parseCardinalityMessage,
} from './webview/cardinalityView';
import { getNonce, getUri, htmlShell, timeZoneAttr, watchTimeZone } from './webviewUtil';

const REFRESH_THROTTLE_MS = 1000;
/** Services offered in the scope picker. */
const MAX_SCOPE_SERVICES = 1000;

export interface CardinalityPanelDeps {
  workspaceState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
  registry?: BaselineRegistry;
}

export class CardinalityPanel {
  private static current: CardinalityPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private tab: Tab = DEFAULT_TAB;
  private ctx: HostContext;
  // The model the last update was built from; detail requests index into it.
  private posted: CardinalityModel | undefined;
  private model: CardinalityModel | undefined;
  private cacheKey = '';
  private dataVersion = 0;
  private lastSig = '';
  private lastPost = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private baseline: { id: string; stored: StoredBaseline | undefined } | undefined;
  private loadToken = 0;

  static show(controller: OtelController, deps: CardinalityPanelDeps, scope?: PanelScope): void {
    const current = CardinalityPanel.current;
    if (current) {
      if (scope) current.setScope(scope);
      current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel('otel.cardinality', 'Telemetry Cardinality & Cost', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(controller.extensionUri, 'dist', 'webview')],
    });
    CardinalityPanel.current = new CardinalityPanel(panel, controller, deps, scope ?? { realm: LIVE_REALM });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: OtelController,
    private readonly deps: CardinalityPanelDeps,
    scope: PanelScope
  ) {
    this.ctx = { seq: 0, scope, options: { realms: [], services: [], instances: [] }, tables: {} };
    const scriptUri = getUri(panel.webview, controller.extensionUri, 'dist', 'webview', 'cardinality.js');
    panel.webview.html = htmlShell(panel.webview, getNonce(), BODY, '', STYLE, [scriptUri], timeZoneAttr());
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    panel.onDidChangeViewState(
      () => {
        if (panel.visible && this.dirty) this.schedule();
      },
      null,
      this.disposables
    );
    this.disposables.push(
      watchTimeZone(panel.webview),
      controller.store.onDidChange(() => {
        this.dataVersion++;
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('otel.cardinality') || e.affectsConfiguration('otel.cost')) this.schedule(true);
      })
    );
    if (deps.registry) this.disposables.push(deps.registry.onDidChange(() => void this.loadBaseline()));
    void this.loadBaseline();
  }

  private setScope(scope: PanelScope): void {
    this.ctx = { ...this.ctx, scope };
    this.schedule(true);
  }

  // Bodies load asynchronously; a newer call wins over one still in flight.
  private async loadBaseline(): Promise<void> {
    const registry = this.deps.registry;
    const id = registry?.activeId;
    const token = ++this.loadToken;
    if (!id || !registry) {
      this.baseline = undefined;
    } else if (this.baseline?.id !== id || !this.baseline.stored) {
      this.baseline = { id, stored: undefined };
      const stored = await registry.load(id);
      if (token !== this.loadToken) return;
      this.baseline = { id, stored };
    }
    this.schedule(true);
  }

  private onMessage(m: unknown): void {
    const msg = parseCardinalityMessage(m, this.ctx);
    if (!msg) return;
    this.handle(msg).catch((err) => vscode.window.showErrorMessage(`Cardinality: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async handle(msg: ViewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.tab = msg.tab;
        // A reloaded webview has no state; force the next update through.
        this.lastSig = '';
        return this.schedule(true);
      case 'setTab':
        this.tab = msg.tab;
        return this.schedule(true);
      case 'setScope':
        return this.setScope(msg.scope);
      case 'select': {
        const details = this.posted && detailsOf(this.posted, msg.table, msg.index);
        if (details) this.post({ type: 'details', seq: msg.seq, table: msg.table, index: msg.index, details });
        return;
      }
      case 'setPricing':
        await this.deps.workspaceState.update(PRICING_OVERRIDES_KEY, Object.keys(msg.overrides).length ? msg.overrides : undefined);
        return this.schedule(true);
      case 'resetPricing':
        await this.deps.workspaceState.update(PRICING_OVERRIDES_KEY, undefined);
        return this.schedule(true);
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', `otel.${msg.section}`);
        return;
    }
  }

  // Hidden panels only mark themselves dirty; visible ones refresh at most once a second.
  // User actions (immediate) skip the throttle.
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
    if (!this.controller.store.isCardinalityEnabled()) {
      this.model = undefined;
      this.posted = undefined;
      this.cacheKey = '';
      this.postIfChanged('disabled', { type: 'disabled' });
      return;
    }
    try {
      const { scope, options } = this.scopeAndOptions();
      const settings = readCardinalitySettings();
      const key = JSON.stringify([this.dataVersion, scope, settings]);
      if (key !== this.cacheKey || !this.model) {
        this.model = buildCardinalityModel(this.controller.store.getAllInstances(), scope, settings);
        this.cacheKey = key;
      }
      const model = this.model;
      const pricing = readPricing();
      const overrides = this.deps.workspaceState.get<unknown>(PRICING_OVERRIDES_KEY);
      const cost = estimateCost(dailyUsage(model), effectivePricing(pricing, overrides).pricing);
      const data = tabData(this.tab, model, {
        pricing: () => pricingView(model, pricing, overrides),
        baseline: () => this.baselineData(scope, settings),
      });
      const summary = summaryOf(model, cost);
      const sig = JSON.stringify([this.tab, scope, options, summary, data]);
      if (sig === this.lastSig) return;
      const seq = this.ctx.seq + 1;
      this.ctx = { seq, scope, options, tables: detailTables(data) };
      this.posted = model;
      this.lastSig = sig;
      this.post({ type: 'update', seq, tab: this.tab, scope, options, summary, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postIfChanged(`error:${message}`, { type: 'error', message });
    }
  }

  private postIfChanged(sig: string, msg: HostMessage): void {
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.post(msg);
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  // Drops scope parts that no longer exist (an unloaded session, a cleared service or instance).
  private scopeAndOptions(): { scope: PanelScope; options: ScopeOptions } {
    const store = this.controller.store;
    const wanted = this.ctx.scope;
    const realms = [
      { id: LIVE_REALM, label: 'Live' },
      ...store.getImportedSessions().map((s) => ({ id: s.session.id, label: s.session.source })),
    ];
    const scope: PanelScope = { realm: realms.some((r) => r.id === wanted.realm) ? wanted.realm : LIVE_REALM };
    const counted = store.getAllInstances().filter((i) => i.usage && i.realm === scope.realm);
    const services = [...new Set(counted.map((i) => i.serviceName))].sort(byCodeUnit).slice(0, MAX_SCOPE_SERVICES);
    if (scope.realm === wanted.realm && wanted.service !== undefined && services.includes(wanted.service)) scope.service = wanted.service;
    const instances = counted
      .filter((i) => scope.service !== undefined && i.serviceName === scope.service)
      .map((i) => ({ id: i.id, label: i.serviceInstanceId ?? i.id }))
      .sort((a, b) => byCodeUnit(a.label, b.label) || byCodeUnit(a.id, b.id));
    if (scope.service !== undefined && wanted.instanceId !== undefined && instances.some((i) => i.id === wanted.instanceId)) {
      scope.instanceId = wanted.instanceId;
    }
    return { scope, options: { realms, services, instances } };
  }

  private baselineData(scope: PanelScope, settings: CardinalitySettings): BaselineView {
    const registry = this.deps.registry;
    const id = registry?.activeId;
    if (!registry || !id) return { state: 'none' };
    const meta = registry.get(id);
    const name = meta?.name ?? 'baseline';
    if (meta?.unavailable) return { state: 'unreadable', name };
    if (this.baseline?.id !== id) return { state: 'loading', name };
    const stored = this.baseline.stored;
    if (!stored) return { state: 'unreadable', name };
    const summary = stored.snapshot.cardinality;
    if (!summary) return { state: 'noSummary', name };
    const current = captureCardinality(this.controller.store.getAllInstances(), scope);
    return baselineView({ name, createdMs: meta?.createdMs ?? stored.meta.createdMs, summary }, current, scope, settings);
  }

  private dispose(): void {
    if (CardinalityPanel.current === this) CardinalityPanel.current = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.loadToken++;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const STYLE = `
  .toolbar label { display: inline-flex; gap: 4px; align-items: center; }
  .muted { color: var(--vscode-descriptionForeground); }
  .badge {
    padding: 1px 6px; border-radius: 8px; font-size: 0.85em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .badge.warn {
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-foreground); border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
  }
  .tabs { flex: 0 0 auto; display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  button.tab {
    background: none; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent;
    padding: 6px 10px; border-radius: 0;
  }
  button.tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  button:focus-visible, tr.selectable:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #main { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
  #content { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 8px 12px 24px; }
  #content section { margin: 12px 0 20px; }
  #content h2 { font-size: 1.05em; margin: 0 0 6px; }
  #content h3 { font-size: 0.95em; margin: 10px 0 4px; }
  #content table { margin-top: 4px; }
  #content th { white-space: nowrap; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr.selectable:hover { background: var(--vscode-list-hoverBackground); }
  tr[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground); }
  td { overflow-wrap: anywhere; }
  .note { color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
  .empty-note { padding: 8px 10px; border: 1px dashed var(--vscode-panel-border); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin: 4px 0 8px; }
  .card {
    padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .card-label { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .card-value { font-size: 1.4em; font-weight: 600; font-variant-numeric: tabular-nums; margin: 2px 0; }
  .card-sub { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .spark { display: block; margin-top: 4px; }
  .spark path { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 1.5; }
  .sev-critical, .sev-critical .glyph { color: var(--vscode-errorForeground, #f14c4c); }
  .sev-warning, .sev-warning .glyph { color: var(--vscode-editorWarning-foreground, #cca700); }
  .sev-info, .sev-info .glyph { color: var(--vscode-charts-blue, #3794ff); }
  .verdict-new { color: var(--vscode-charts-purple, #b180d7); }
  .verdict-grown { color: var(--vscode-errorForeground, #f14c4c); }
  .verdict-resolved { color: var(--vscode-testing-iconPassed, #73c991); }
  code.pattern, pre.pattern, .samples code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; overflow-wrap: anywhere; white-space: pre-wrap; }
  pre.pattern { margin: 4px 0; padding: 6px; background: var(--vscode-textCodeBlock-background); }
  .samples { padding-left: 18px; }
  .summary span { margin-right: 10px; }
  form.pricing { display: grid; gap: 6px; max-width: 760px; }
  form.pricing .field { display: grid; grid-template-columns: 220px 160px 1fr; gap: 8px; align-items: center; }
  form.pricing .actions { display: flex; gap: 6px; margin-top: 6px; }
  form.pricing .error { color: var(--vscode-errorForeground); margin: 0; min-height: 1em; }
  #details {
    flex: 0 0 360px; overflow: auto; padding: 8px 12px;
    border-left: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  #details header { display: flex; align-items: center; gap: 6px; }
  #details h2 { flex: 1 1 auto; margin: 0; font-size: 1.1em; overflow-wrap: anywhere; }
  #details h3 {
    margin: 14px 0 4px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  #details .facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 8px 0; }
  #details dt { color: var(--vscode-descriptionForeground); }
  #details dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  #details ul { margin: 0; padding-left: 18px; }
  #details li { overflow-wrap: anywhere; }
  button.close { background: none; color: var(--vscode-foreground); font-size: 1.2em; padding: 0 4px; }
  button.close:hover { background: var(--vscode-toolbar-hoverBackground); }
  #banner { padding: 16px; }
  #banner.error { color: var(--vscode-errorForeground); }
  #banner button { margin-top: 8px; }
`;

const BODY = `
<div class="toolbar">
  <strong>Cardinality &amp; Cost</strong>
  <select id="realm" aria-label="Data source" title="Live data or a loaded session file"></select>
  <select id="service" aria-label="Service"></select>
  <select id="instance" aria-label="Instance"></select>
  <span id="asOf" class="muted"></span>
  <span id="truncated" class="badge warn" hidden title="Some limit was reached: tables show the largest rows, and attributes beyond the per-instance limit are counted but not listed.">truncated</span>
</div>
<div id="tabs" class="tabs" role="tablist" aria-label="Views"></div>
<div id="banner" hidden role="status"></div>
<div id="main">
  <div id="content" role="tabpanel" tabindex="-1"></div>
  <aside id="details" hidden aria-label="Row details"></aside>
</div>
`;
