import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Application, Instance } from '../store/store';
import { diffDescriptions, instanceDescription, instanceLabel, treeShape } from './instancesTreeModel';

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

type Node = AppNode | InstanceNode | ImportedRootNode;

export class InstancesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | Node[] | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // Reused across refreshes: targeted refresh only works for elements VS Code already holds.
  private readonly appNodes = new Map<string, AppNode>();
  private readonly instanceNodes = new Map<string, InstanceNode>();
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
      const imported = this.controller.store.getImportedInstances();
      const item = new vscode.TreeItem('Imported', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.contextValue = 'otelImportedRoot';
      item.id = 'otel.importedRoot';
      item.description = `${imported.length} file${imported.length === 1 ? '' : 's'}`;
      item.tooltip = 'Logs loaded from a file. Read-only and not affected by Clear.';
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
      const item = new vscode.TreeItem(inst.serviceName, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('file-symlink-file');
      item.contextValue = 'otelImportedInstance';
      item.id = inst.id;
      item.description = instanceDescription(inst);
      item.tooltip = new vscode.MarkdownString(
        `**${inst.serviceName}** (imported)\n\n` +
          `- Source: \`${inst.source ?? 'n/a'}\`\n` +
          `- Logs: ${inst.logCount}\n\n` +
          'Read-only. Not affected by Clear Collected Data.'
      );
      item.command = { command: 'otel.openLogs', title: 'Open Logs', arguments: [node] };
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
      if (this.controller.store.getImportedInstances().length) nodes.push(this.importedRoot);
      return nodes;
    }
    if (node.kind === 'imported') {
      return this.controller.store.getImportedInstances().map((i) => this.nodeFor(i));
    }
    if (node.kind === 'app') {
      return node.app.instances.map((i) => this.nodeFor(i));
    }
    return [];
  }
}
