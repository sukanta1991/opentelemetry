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

type Node = AppNode | InstanceNode;

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
      return this.controller.store.getApplications().map((a) => new AppNode(a));
    }
    if (node.kind === 'app') {
      return node.app.instances.map((i) => new InstanceNode(i));
    }
    return [];
  }
}
