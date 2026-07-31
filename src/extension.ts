import * as vscode from 'vscode';
import { OtelController } from './controller';
import { OtelDebugConfigProvider } from './integration/debugConfigProvider';
import { SNIPPETS } from './integration/snippets';
import { readSettings } from './settings';
import { InstanceNode, InstancesTreeProvider } from './views/instancesTree';
import { LogsPanel } from './views/logsPanel';
import { MetricsPanel } from './views/metricsPanel';
import { ServiceMapPanel } from './views/serviceMapPanel';
import { TracesPanel } from './views/tracesPanel';

let controller: OtelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new OtelController(context.extensionPath);
  context.subscriptions.push({ dispose: () => controller.dispose() });

  const tree = new InstancesTreeProvider(controller);
  context.subscriptions.push(
    vscode.window.createTreeView('otel.instances', { treeDataProvider: tree })
  );

  const resolveInstanceId = async (arg: unknown): Promise<string | undefined> => {
    if (arg instanceof InstanceNode) return arg.instance.id;
    if (arg && typeof arg === 'object' && 'instance' in (arg as any)) {
      return (arg as any).instance.id;
    }
    const instances = controller.store.getAllInstances();
    if (instances.length === 0) {
      vscode.window.showInformationMessage('OpenTelemetry: no instances yet.');
      return undefined;
    }
    if (instances.length === 1) return instances[0].id;
    const pick = await vscode.window.showQuickPick(
      instances.map((i) => ({
        label: i.serviceName,
        description: i.serviceInstanceId ?? i.id,
        id: i.id,
      })),
      { placeHolder: 'Select an instance' }
    );
    return pick?.id;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('otel.start', () => controller.start()),
    vscode.commands.registerCommand('otel.stop', () => controller.stop()),
    vscode.commands.registerCommand('otel.restart', () => controller.restart()),
    vscode.commands.registerCommand('otel.clear', () => controller.clear()),
    vscode.commands.registerCommand('otel.copyEndpoint', () => copyEndpoint()),
    vscode.commands.registerCommand('otel.copyEnvVar', () => copyEnvVar()),
    vscode.commands.registerCommand('otel.openTerminalWithEnv', () => openTerminalWithEnv()),
    vscode.commands.registerCommand('otel.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:local.opentelemetry'
      )
    ),
    vscode.commands.registerCommand('otel.openServiceMap', () => ServiceMapPanel.show(controller)),
    vscode.commands.registerCommand('otel.showSnippets', () => showSnippets()),
    vscode.commands.registerCommand('otel.openLogs', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) LogsPanel.show(controller, id);
    }),
    vscode.commands.registerCommand('otel.openTraces', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) TracesPanel.show(controller, id);
    }),
    vscode.commands.registerCommand('otel.openMetrics', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) MetricsPanel.show(controller, id);
    }),
    vscode.commands.registerCommand('otel.removeInstance', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) controller.store.removeInstance(id);
    })
  );

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('*', new OtelDebugConfigProvider(controller))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('otel.retention')) controller.reloadRetention();
    })
  );

  if (readSettings().launchOnStartup) {
    await controller.start();
  }
}

function requireRunning(): boolean {
  if (!controller.isRunning()) {
    vscode.window.showWarningMessage('OpenTelemetry: receiver is not running. Start it first.');
    return false;
  }
  return true;
}

async function copyEndpoint(): Promise<void> {
  if (!requireRunning()) return;
  const ep = controller.getEndpoints()!;
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'gRPC endpoint', description: ep.grpcEndpoint, value: ep.grpcEndpoint },
      { label: 'HTTP endpoint', description: ep.httpEndpoint, value: ep.httpEndpoint },
    ],
    { placeHolder: 'Copy which endpoint?' }
  );
  if (pick) {
    await vscode.env.clipboard.writeText(pick.value);
    vscode.window.showInformationMessage(`Copied: ${pick.value}`);
  }
}

async function copyEnvVar(): Promise<void> {
  if (!requireRunning()) return;
  const ep = controller.getEndpoints()!;
  const text = `OTEL_EXPORTER_OTLP_ENDPOINT=${ep.grpcEndpoint}`;
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(`Copied: ${text}`);
}

function openTerminalWithEnv(): void {
  if (!requireRunning()) return;
  const ep = controller.getEndpoints()!;
  const terminal = vscode.window.createTerminal({
    name: 'OTel-enabled',
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: ep.grpcEndpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    },
  });
  terminal.show();
}

async function showSnippets(): Promise<void> {
  const ep = controller.getEndpoints()?.grpcEndpoint ?? 'http://127.0.0.1:4317';
  const pick = await vscode.window.showQuickPick(
    SNIPPETS.map((s) => ({ label: s.title, snippet: s })),
    { placeHolder: 'Instrumentation snippet for…' }
  );
  if (!pick) return;
  const doc = await vscode.workspace.openTextDocument({
    content: pick.snippet.code(ep),
    language: pick.snippet.language === 'Python' ? 'python' : 'plaintext',
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

export function deactivate(): void {
  controller?.dispose();
}
