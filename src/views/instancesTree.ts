import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { Application, Instance } from '../store/store';

export class AppNode {
  readonly kind = 'app';
  constructor(public readonly app: Application) {}
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
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: OtelController) {
    controller.store.onDidChange(() => this.emitter.fire());
    controller.onDidChangeState(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'imported') {
      const imported = this.controller.store.getImportedInstances();
      const item = new vscode.TreeItem('Imported', vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.contextValue = 'otelImportedRoot';
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
      item.description = `${inst.source ?? 'file'} · ${inst.logCount} logs`;
      item.tooltip = new vscode.MarkdownString(
        `**${inst.serviceName}** (imported)\n\n` +
          `- Source: \`${inst.source ?? 'n/a'}\`\n` +
          `- Logs: ${inst.logCount}\n\n` +
          'Read-only. Not affected by Clear Collected Data.'
      );
      item.command = { command: 'otel.openLogs', title: 'Open Logs', arguments: [node] };
      return item;
    }
    const label = inst.serviceInstanceId ?? inst.id.split('::')[1] ?? inst.id;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('vm');
    item.contextValue = 'otelInstance';
    item.id = inst.id;
    item.description = `${inst.logCount} logs · ${inst.traces.size} traces · ${inst.metrics.size} metrics`;
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
      const nodes: Node[] = this.controller.store.getApplications().map((a) => new AppNode(a));
      if (this.controller.store.getImportedInstances().length) nodes.push(new ImportedRootNode());
      return nodes;
    }
    if (node.kind === 'imported') {
      return this.controller.store.getImportedInstances().map((i) => new InstanceNode(i));
    }
    if (node.kind === 'app') {
      return node.app.instances.map((i) => new InstanceNode(i));
    }
    return [];
  }
}
