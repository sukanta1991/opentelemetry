// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Application, ImportedSessionView, Instance } from '../store/store';
import { diffDescriptions, instanceDescription, instanceLabel, serviceDescription, treeShape } from './instancesTreeModel';

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

type Node = AppNode | InstanceNode | ImportedRootNode | ImportedSessionNode | ImportedServiceNode;

export class InstancesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | Node[] | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Reused across refreshes: targeted refresh only works for elements VS Code already holds.
  private readonly appNodes = new Map<string, AppNode>();
  private readonly instanceNodes = new Map<string, InstanceNode>();
  private readonly sessionNodes = new Map<string, ImportedSessionNode>();
  private readonly serviceNodes = new Map<string, ImportedServiceNode>();
  private readonly importedRoot = new ImportedRootNode();

  private lastShape = '';
  private lastDescriptions = new Map<string, string>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private pendingFull = false;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly controller: OtelController) {
    this.disposables.push(
      controller.store.onDidChange(() => this.scheduleRefresh(false)),
      controller.onDidChangeState(() => this.scheduleRefresh(true))
    );
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

    if (this.pendingFull || shape !== this.lastShape) {
      this.lastShape = shape;
      this.pendingFull = false;
      const ids = new Set(all.map((i) => i.id));
      for (const id of this.instanceNodes.keys()) if (!ids.has(id)) this.instanceNodes.delete(id);
      const names = new Set(apps.map((a) => a.name));
      for (const name of this.appNodes.keys()) if (!names.has(name)) this.appNodes.delete(name);
      const realms = new Set(imported.map((i) => i.realm));
      for (const id of this.sessionNodes.keys()) if (!realms.has(id)) this.sessionNodes.delete(id);
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
    if (!node) {
      node = new InstanceNode(inst);
      this.instanceNodes.set(inst.id, node);
    }
    return node;
  }

  getTreeItem(node: Node): vscode.TreeItem {
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
      return item;
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
      return item;
    }
    const inst = node.instance;
    if (inst.kind === 'imported') {
      const grouped = this.sessionNodes.has(inst.realm);
      const item = new vscode.TreeItem(
        grouped ? instanceLabel(inst) : inst.serviceName,
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon(grouped ? 'vm' : 'file-symlink-file');
      item.contextValue = 'otelImportedInstance';
      item.id = inst.id;
      item.description = instanceDescription(inst, !grouped);
      item.tooltip = new vscode.MarkdownString(
        `**${inst.serviceName}** (imported)\n\n` +
          `- Source: \`${inst.source ?? 'n/a'}\`\n` +
          `- Logs: ${inst.logCount}\n- Spans: ${inst.spanCount}\n- Traces: ${inst.traces.size}\n- Metrics: ${inst.metrics.size}\n\n` +
          'Read-only. Not affected by Clear Collected Data.'
      );
      const open = inst.logCount || (!inst.traces.size && !inst.metrics.size)
        ? { command: 'otel.openLogs', title: 'Open Logs' }
        : inst.traces.size
          ? { command: 'otel.openTraces', title: 'Open Traces' }
          : { command: 'otel.openMetrics', title: 'Open Metrics' };
      item.command = { ...open, arguments: [node] };
      return item;
    }
    const item = new vscode.TreeItem(instanceLabel(inst), vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('vm');
    item.contextValue = 'otelInstance';
    item.id = inst.id;
    item.description = instanceDescription(inst);
    item.tooltip = new vscode.MarkdownString(
      `**${inst.serviceName}**\n\n` +
        `- Instance: \`${inst.id}\`\n` +
        `- Peer: \`${inst.peer ?? 'n/a'}\`\n` +
        `- Logs: ${inst.logCount}\n- Spans: ${inst.spanCount}\n- Traces: ${inst.traces.size}\n- Metrics: ${inst.metrics.size}`
    );
    item.command = {
      command: 'otel.openLogs',
      title: 'Open Logs',
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const nodes: Node[] = this.controller.store.getApplications().map((a) => {
        let appNode = this.appNodes.get(a.name);
        if (appNode) appNode.app = a;
        else this.appNodes.set(a.name, (appNode = new AppNode(a)));
        return appNode;
      });
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
      return [...byService].map(([name, instances]) => {
        const key = `${sessionId}\u0000${name}`;
        let serviceNode = this.serviceNodes.get(key);
        if (serviceNode) serviceNode.instances = instances;
        else this.serviceNodes.set(key, (serviceNode = new ImportedServiceNode(sessionId, name, instances)));
        return serviceNode;
      });
    }
    if (node.kind === 'importedService') {
      return node.instances.map((i) => this.nodeFor(i));
    }
    if (node.kind === 'app') {
      return node.app.instances.map((i) => this.nodeFor(i));
    }
    return [];
  }
}
