// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Application, ImportedSessionView, Instance, LIVE_REALM } from '../store/store';
import { cardinalityUri } from './cardinalityDecorations';
import { CardinalityEvaluator, instanceKey, serviceKey, tooltipMarkdown } from './cardinalityEvaluator';
import { diffDescriptions, instanceDescription, instanceLabel, serviceDescription, Signal, signalRows, treeShape } from './instancesTreeModel';
import { PanelScope } from './webview/cardinalityView';

// Full refreshes clear VS Code's handle map, so under load they must be rare.
const TREE_REFRESH_MS = 1000;

export class AppNode {
  readonly kind = 'app';
  constructor(public app: Application) {}
}

export class InstanceNode {
  readonly kind = 'instance';
  constructor(public readonly instance: Instance) {}
}

// Groups file-imported instances so they are never confused with live services.
export class ImportedRootNode {
  readonly kind = 'imported';
}

// A loaded file holding several instances; single-instance files show the instance directly.
export class ImportedSessionNode {
  readonly kind = 'session';
  constructor(public view: ImportedSessionView) {}
}

// One service.name inside a loaded file, mirroring AppNode for live data.
export class ImportedServiceNode {
  readonly kind = 'importedService';
  constructor(
    public readonly sessionId: string,
    public readonly name: string,
    public instances: Instance[]
  ) {}
}

// Traces, Logs or Metrics under an instance.
export class SignalNode {
  readonly kind = 'signal';
  constructor(
    public readonly instance: Instance,
    public readonly signal: Signal
  ) {}
}

// Opens the service map for the live data or for one loaded file.
export class ServiceMapNode {
  readonly kind = 'serviceMap';
  constructor(public readonly realm: string) {}
}

type Node = AppNode | InstanceNode | ImportedRootNode | ImportedSessionNode | ImportedServiceNode | SignalNode | ServiceMapNode;

/** The cardinality panel scope for a tree node, or undefined for nodes without one. */
export function cardinalityScopeOf(node: unknown): PanelScope | undefined {
  if (node instanceof AppNode) return { realm: LIVE_REALM, service: node.app.name };
  if (node instanceof InstanceNode) return { realm: node.instance.realm, service: node.instance.serviceName, instanceId: node.instance.id };
  if (node instanceof ImportedServiceNode) return { realm: node.sessionId, service: node.name };
  if (node instanceof ImportedSessionNode) return { realm: node.view.session.id };
  return undefined;
}

export class InstancesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | Node[] | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Reused across refreshes: targeted refresh only works for elements VS Code already holds.
  private readonly appNodes = new Map<string, AppNode>();
  private readonly instanceNodes = new Map<string, InstanceNode>();
  private readonly sessionNodes = new Map<string, ImportedSessionNode>();
  private readonly serviceNodes = new Map<string, ImportedServiceNode>();
  private readonly signalNodes = new Map<string, SignalNode>();
  private readonly sessionMapNodes = new Map<string, ServiceMapNode>();
  private readonly liveMapNode = new ServiceMapNode(LIVE_REALM);
  private readonly importedRoot = new ImportedRootNode();

  private lastShape = '';
  private lastDescriptions = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private pendingFull = false;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    private readonly controller: OtelController,
    private readonly cardinality?: CardinalityEvaluator
  ) {
    this.disposables.push(
      controller.store.onDidChange(() => this.scheduleRefresh(false)),
      controller.onDidChangeState(() => this.scheduleRefresh(true))
    );
    if (cardinality) this.disposables.push(cardinality.onDidChange((_, changed) => this.refreshKeys(changed)));
  }

  // Tooltips list findings, so items whose findings changed are fetched again.
  private refreshKeys(changed: string[]): void {
    const keys = new Set(changed);
    const nodes: Node[] = [];
    for (const [name, n] of this.appNodes) if (keys.has(serviceKey(LIVE_REALM, name))) nodes.push(n);
    for (const n of this.serviceNodes.values()) if (keys.has(serviceKey(n.sessionId, n.name))) nodes.push(n);
    for (const [id, n] of this.instanceNodes) if (keys.has(instanceKey(id))) nodes.push(n);
    if (nodes.length) this.emitter.fire(nodes);
  }

  // Lets the decoration provider badge the item and appends its findings to the tooltip.
  private withCardinality(item: vscode.TreeItem, key: string): vscode.TreeItem {
    if (!this.cardinality) return item;
    item.resourceUri = cardinalityUri(key);
    const node = this.cardinality.current.nodes.get(key);
    if (!node) return item;
    const section = tooltipMarkdown(node);
    const prev = item.tooltip;
    const base = prev instanceof vscode.MarkdownString ? prev.value : (prev ?? '');
    item.tooltip = new vscode.MarkdownString(base ? `${base}\n\n${section}` : section);
    return item;
  }

  refresh(): void {
    this.pendingFull = true;
    this.flush();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }

  private scheduleRefresh(full: boolean): void {
    this.pendingFull ||= full;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => this.flush(), TREE_REFRESH_MS);
  }

  private flush(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;

    const store = this.controller.store;
    const apps = store.getApplications();
    const imported = store.getImportedInstances();
    const all = [...apps.flatMap((a) => a.instances), ...imported];
    const shape = treeShape(apps, imported);
    const replaced = all.some((i) => {
      const cached = this.instanceNodes.get(i.id);
      return cached !== undefined && cached.instance !== i;
    });

    if (this.pendingFull || shape !== this.lastShape || replaced) {
      this.lastShape = shape;
      this.pendingFull = false;
      const current = new Map(all.map((i) => [i.id, i]));
      for (const [id, n] of this.instanceNodes) if (current.get(id) !== n.instance) this.instanceNodes.delete(id);
      for (const [key, n] of this.signalNodes) if (current.get(n.instance.id) !== n.instance) this.signalNodes.delete(key);
      const names = new Set(apps.map((a) => a.name));
      for (const name of this.appNodes.keys()) if (!names.has(name)) this.appNodes.delete(name);
      const realms = new Set(imported.map((i) => i.realm));
      for (const id of this.sessionNodes.keys()) if (!realms.has(id)) this.sessionNodes.delete(id);
      for (const id of this.sessionMapNodes.keys()) if (!realms.has(id)) this.sessionMapNodes.delete(id);
      for (const [key, n] of this.serviceNodes) if (!realms.has(n.sessionId)) this.serviceNodes.delete(key);
      this.lastDescriptions = diffDescriptions(new Map(), all).next;
      this.emitter.fire();
      return;
    }

    const { changed, next } = diffDescriptions(this.lastDescriptions, all);
    this.lastDescriptions = next;
    const nodes: InstanceNode[] = [];
    for (const id of changed) {
      const node = this.instanceNodes.get(id);
      if (node) nodes.push(node);
    }
    if (nodes.length) this.emitter.fire(nodes);
  }

  private nodeFor(inst: Instance): InstanceNode {
    let node = this.instanceNodes.get(inst.id);
    // A removed instance can come back under the same id before the next refresh.
    if (node?.instance !== inst) {
      node = new InstanceNode(inst);
      this.instanceNodes.set(inst.id, node);
    }
    return node;
  }

  private signalNodesFor(inst: Instance): SignalNode[] {
    return signalRows(inst).map(({ signal }) => {
      const key = `${inst.id}::signal::${signal}`;
      let node = this.signalNodes.get(key);
      if (node?.instance !== inst) this.signalNodes.set(key, (node = new SignalNode(inst, signal)));
      return node;
    });
  }

  private sessionMapNode(realm: string): ServiceMapNode {
    let node = this.sessionMapNodes.get(realm);
    if (!node) this.sessionMapNodes.set(realm, (node = new ServiceMapNode(realm)));
    return node;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'signal') {
      const row = signalRows(node.instance).find((r) => r.signal === node.signal)!;
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
      item.id = `${node.instance.id}::signal::${row.signal}`;
      item.iconPath = row.count
        ? new vscode.ThemeIcon(row.icon)
        : new vscode.ThemeIcon(row.icon, new vscode.ThemeColor('disabledForeground'));
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.contextValue = 'otelSignal';
      item.command = { command: row.command, title: row.label, arguments: [this.nodeFor(node.instance)] };
      return item;
    }
    if (node.kind === 'serviceMap') {
      const live = node.realm === LIVE_REALM;
      let services = 0;
      if (live) services = this.controller.store.getApplications().length;
      else {
        const view = this.controller.store.getImportedSessions().find((v) => v.session.id === node.realm);
        services = new Set(view?.instances.map((i) => i.serviceName)).size;
      }
      const item = new vscode.TreeItem('Service Map', vscode.TreeItemCollapsibleState.None);
      item.id = `serviceMap::${node.realm}`;
      item.iconPath = new vscode.ThemeIcon('type-hierarchy');
      item.description = `${services} service${services === 1 ? '' : 's'}`;
      item.tooltip = live
        ? 'How your services call each other, with call counts, latency and errors on every connection.'
        : 'How the services in this file call each other.';
      item.contextValue = 'otelServiceMap';
      item.command = { command: 'otel.openServiceMap', title: 'Open Service Map', arguments: [node] };
      return item;
    }
    if (node.kind === 'imported') {
      const files = this.controller.store.getImportedSessions().length;
      const item = new vscode.TreeItem('Imported', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.contextValue = 'otelImportedRoot';
      item.id = 'otel.importedRoot';
      item.description = `${files} file${files === 1 ? '' : 's'}`;
      item.tooltip = 'Data loaded from files. Read-only and not affected by Clear.';
      return item;
    }
    if (node.kind === 'session') {
      const { session, instances } = node.view;
      const services = new Set(instances.map((i) => i.serviceName)).size;
      const item = new vscode.TreeItem(session.source, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('file-symlink-file');
      item.contextValue = 'otelImportedSession';
      item.id = `session::${session.id}`;
      item.description =
        `${services} service${services === 1 ? '' : 's'} · ` +
        `${instances.length} instance${instances.length === 1 ? '' : 's'}`;
      item.tooltip = new vscode.MarkdownString(
        `**${session.source}** (loaded ${new Date(session.loadedAt).toLocaleString()})\n\n` +
          'Read-only. Not affected by Clear Collected Data.'
      );
      return item;
    }
    if (node.kind === 'importedService') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('server-environment');
      item.contextValue = 'otelImportedService';
      item.id = `session::${node.sessionId}::service::${node.name}`;
      item.description = serviceDescription(node.instances);
      return this.withCardinality(item, serviceKey(node.sessionId, node.name));
    }
    if (node.kind === 'app') {
      const item = new vscode.TreeItem(
        node.app.name,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon('server-environment');
      item.contextValue = 'otelApplication';
      item.id = `app::${node.app.name}`;
      item.description = `${node.app.instances.length} instance${
        node.app.instances.length === 1 ? '' : 's'
      }`;
      return this.withCardinality(item, serviceKey(LIVE_REALM, node.app.name));
    }
    const inst = node.instance;
    if (inst.kind === 'imported') {
      const grouped = this.sessionNodes.has(inst.realm);
      const item = new vscode.TreeItem(grouped ? instanceLabel(inst) : inst.serviceName, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(grouped ? 'vm' : 'file-symlink-file');
      item.contextValue = 'otelImportedInstance';
      item.id = `instance::${inst.id}`;
      item.description = instanceDescription(inst, !grouped);
      item.tooltip = new vscode.MarkdownString(
        `**${inst.serviceName}** (imported)\n\n` +
          `- Source: \`${inst.source ?? 'n/a'}\`\n` +
          `- Logs: ${inst.logCount}\n- Spans: ${inst.spanCount}\n- Traces: ${inst.traces.size}\n- Metrics: ${inst.metrics.size}\n\n` +
          'Read-only. Not affected by Clear Collected Data.'
      );
      return this.withCardinality(item, instanceKey(inst.id));
    }
    const item = new vscode.TreeItem(instanceLabel(inst), vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('vm');
    item.contextValue = 'otelInstance';
    item.id = `instance::${inst.id}`;
    item.description = instanceDescription(inst);
    item.tooltip = new vscode.MarkdownString(
      `**${inst.serviceName}**\n\n` +
        `- Instance: \`${inst.id}\`\n` +
        `- Peer: \`${inst.peer ?? 'n/a'}\`\n` +
        `- Logs: ${inst.logCount}\n- Spans: ${inst.spanCount}\n- Traces: ${inst.traces.size}\n- Metrics: ${inst.metrics.size}`
    );
    return this.withCardinality(item, instanceKey(inst.id));
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const apps: Node[] = this.controller.store.getApplications().map((a) => {
        let appNode = this.appNodes.get(a.name);
        if (appNode) appNode.app = a;
        else this.appNodes.set(a.name, (appNode = new AppNode(a)));
        return appNode;
      });
      const nodes: Node[] = apps.length ? [this.liveMapNode, ...apps] : [];
      if (this.controller.store.getImportedSessions().length) nodes.push(this.importedRoot);
      return nodes;
    }
    if (node.kind === 'imported') {
      return this.controller.store.getImportedSessions().map((view) => {
        if (view.instances.length === 1) {
          this.sessionNodes.delete(view.session.id);
          return this.nodeFor(view.instances[0]);
        }
        let sessionNode = this.sessionNodes.get(view.session.id);
        if (sessionNode) sessionNode.view = view;
        else this.sessionNodes.set(view.session.id, (sessionNode = new ImportedSessionNode(view)));
        return sessionNode;
      });
    }
    if (node.kind === 'session') {
      const byService = new Map<string, Instance[]>();
      for (const inst of node.view.instances) {
        const list = byService.get(inst.serviceName);
        if (list) list.push(inst);
        else byService.set(inst.serviceName, [inst]);
      }
      const sessionId = node.view.session.id;
      const services: Node[] = [...byService].map(([name, instances]) => {
        const key = `${sessionId}\u0000${name}`;
        let serviceNode = this.serviceNodes.get(key);
        if (serviceNode) serviceNode.instances = instances;
        else this.serviceNodes.set(key, (serviceNode = new ImportedServiceNode(sessionId, name, instances)));
        return serviceNode;
      });
      return services.length > 1 ? [this.sessionMapNode(sessionId), ...services] : services;
    }
    if (node.kind === 'importedService') {
      return node.instances.map((i) => this.nodeFor(i));
    }
    if (node.kind === 'app') {
      return node.app.instances.map((i) => this.nodeFor(i));
    }
    if (node.kind === 'instance') {
      return this.signalNodesFor(node.instance);
    }
    return [];
  }
}
