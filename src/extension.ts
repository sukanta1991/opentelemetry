// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { registerOtelParticipant } from './ai/participant';
import { registerAiTools } from './ai/tools';
import { OtelController } from './controller';
import { OtelDebugConfigProvider } from './integration/debugConfigProvider';
import { SNIPPETS } from './integration/snippets';
import { readSettings } from './settings';
import { normalizeTraceId } from './store/ids';
import { LIVE_REALM } from './store/store';
import { openCodeLocation } from './views/codeNav';
import { ImportedSessionNode, InstanceNode, InstancesTreeProvider } from './views/instancesTree';
import { LogImportError, parseLogFile } from './views/logImport';
import { LogsPanel } from './views/logsPanel';
import { MetricsPanel } from './views/metricsPanel';
import { revealLogs, revealTrace } from './views/navigation';
import { parseSourceTarget, parseTraceIdInput, parseTraceTarget } from './views/navigationTargets';
import { ServiceMapPanel } from './views/serviceMapPanel';
import { SessionScope, buildSession, defaultSessionFileName } from './views/sessionExport';
import { parseSessionFile } from './views/sessionImport';
import { TracesPanel } from './views/tracesPanel';

let controller: OtelController;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new OtelController(context.extensionPath);
  context.subscriptions.push({ dispose: () => controller.dispose() });

  const tree = new InstancesTreeProvider(controller);
  context.subscriptions.push(
    tree,
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
        `@ext:${context.extension.id}`
      )
    ),
    vscode.commands.registerCommand('otel.openServiceMap', (arg: unknown) =>
      ServiceMapPanel.show(controller, arg instanceof ImportedSessionNode ? arg.view.session.id : LIVE_REALM)
    ),
    vscode.commands.registerCommand('otel.showSnippets', () => showSnippets()),
    vscode.commands.registerCommand('otel.openLogs', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) LogsPanel.show(controller, id);
    }),
    vscode.commands.registerCommand('otel.exportLogs', async (arg) => {
      const id = await resolveInstanceId(arg);
      if (id) LogsPanel.exportFrom(controller, id);
    }),
    vscode.commands.registerCommand('otel.importLogs', () => importLogs()),
    vscode.commands.registerCommand('otel.loadSession', () => loadSession()),
    vscode.commands.registerCommand('otel.saveSession', (arg: unknown) => {
      if (arg instanceof ImportedSessionNode) {
        const { id, source } = arg.view.session;
        return saveSession({ kind: 'session', sessionId: id }, source.replace(/\.[^.]*$/, ''));
      }
      return saveSession({ kind: 'all' }, 'otel-session');
    }),
    vscode.commands.registerCommand('otel.saveInstance', async (arg) => {
      const id = await resolveInstanceId(arg);
      const inst = id ? controller.store.getInstance(id) : undefined;
      if (inst) await saveSession({ kind: 'instance', instanceId: inst.id }, inst.serviceName);
    }),
    vscode.commands.registerCommand('otel.exportTrace', async (arg: unknown) => {
      const traceId = normalizeTraceId(stringProp(arg, 'traceId'));
      if (!traceId) return;
      const realm = TracesPanel.activeRealm() ?? LIVE_REALM;
      await saveSession({ kind: 'trace', traceId, realm }, `trace-${traceId.slice(0, 8)}`);
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
    }),
    vscode.commands.registerCommand('otel.removeSession', (arg: unknown) => {
      if (arg instanceof ImportedSessionNode) controller.store.removeSession(arg.view.session.id);
    }),
    vscode.commands.registerCommand('otel._revealTrace', (arg: unknown) => {
      const target = parseTraceTarget(arg);
      if (target) revealTrace(controller, { ...target, preferInstanceId: stringProp(arg, 'preferInstanceId') });
    }),
    vscode.commands.registerCommand('otel._revealLogs', async (arg: unknown) => {
      const target = parseTraceTarget(arg);
      if (target) {
        const seq = arg && typeof arg === 'object' ? (arg as Record<string, unknown>).focusSeq : undefined;
        await revealLogs(controller, {
          ...target,
          instanceId: stringProp(arg, 'instanceId'),
          focusSeq: Number.isInteger(seq) ? (seq as number) : undefined,
          realm: stringProp(arg, 'realm'),
        });
      }
    }),
    vscode.commands.registerCommand('otel._openSource', async (arg: unknown) => {
      const loc = parseSourceTarget(arg);
      if (loc) await openCodeLocation(loc);
    }),
    vscode.commands.registerCommand('otel.findTrace', () => findTrace())
  );

  const aiLog = vscode.window.createOutputChannel('OpenTelemetry AI', { log: true });
  context.subscriptions.push(aiLog);
  registerAiTools(context, controller, aiLog);
  registerOtelParticipant(context, controller, aiLog);

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

function stringProp(arg: unknown, key: string): string | undefined {
  const v = arg && typeof arg === 'object' ? (arg as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

async function findTrace(): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Find Trace by ID',
    prompt: 'Trace ID or W3C traceparent header',
    placeHolder: '4bf92f3577b34da6a3ce929d0e0e4736',
    validateInput: (v) =>
      !v.trim() || parseTraceIdInput(v) ? undefined : 'Enter a 32-character hex trace ID or a traceparent value',
  });
  const target = input ? parseTraceIdInput(input) : undefined;
  if (target) revealTrace(controller, target);
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

async function importLogs(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import Logs',
    filters: { 'Log files': ['json', 'jsonl', 'ndjson'] },
  });
  const uri = picked?.[0];
  if (!uri) return;

  const settings = readSettings();
  const maxBytes = settings.importMaxFileSizeMb * 1024 * 1024;

  try {
    // Size is checked before the file is read so an oversized file never reaches memory.
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxBytes) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      vscode.window.showErrorMessage(
        `File is ${mb} MB, above the ${settings.importMaxFileSizeMb} MB import limit. ` +
          'Raise otel.import.maxFileSize to import it.'
      );
      return;
    }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Importing logs…' },
      async () => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = parseLogFile(
          new TextDecoder('utf-8', { fatal: false }).decode(bytes),
          settings.importMaxRecords
        );
        return {
          id: controller.store.importLogs({
            serviceName: parsed.serviceName,
            resourceAttrs: parsed.resourceAttrs,
            logs: parsed.logs,
            sourceLabel: uri.path.split('/').pop() || 'imported',
          }),
          skipped: parsed.skipped ?? 0,
        };
      }
    );

    LogsPanel.show(controller, result.id);
    const inst = controller.store.getInstance(result.id);
    const skippedNote = result.skipped
      ? ` ${result.skipped} unreadable line${result.skipped === 1 ? '' : 's'} skipped.`
      : '';
    vscode.window.showInformationMessage(
      `Imported ${inst?.logCount ?? 0} logs from ${inst?.source ?? 'file'}.${skippedNote}`
    );
  } catch (e) {
    const message = e instanceof LogImportError ? e.message : (e as Error).message;
    vscode.window.showErrorMessage(`Could not import logs. ${message}`);
  }
}

export function deactivate(): void {
  controller?.dispose();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function saveSession(scope: SessionScope, label: string): Promise<void> {
  // Snapshot now so data arriving while the dialog is open doesn't change what is saved.
  const built = buildSession(controller.store, scope);
  const { spans, logs, metricPoints } = built.counts;
  if (!spans && !logs && !metricPoints) {
    vscode.window.showInformationMessage('OpenTelemetry: nothing to save yet.');
    return;
  }

  const fileName = defaultSessionFileName(label);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const uri = await vscode.window.showSaveDialog({
    saveLabel: scope.kind === 'trace' ? 'Export Trace' : 'Save Session',
    filters: { 'OpenTelemetry session': ['json'] },
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : vscode.Uri.file(fileName),
  });
  if (!uri) return;

  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(built.text, 'utf8'));
    vscode.window.showInformationMessage(
      `Saved ${plural(spans, 'span')}, ${plural(logs, 'log')} and ${plural(metricPoints, 'metric point')} ` +
        `to ${uri.path.split('/').pop()}.`
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Could not save the session. ${(e as Error).message}`);
  }
}

async function loadSession(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Load Session',
    filters: { 'OpenTelemetry session or OTLP/JSON': ['json', 'jsonl', 'ndjson'] },
  });
  const uri = picked?.[0];
  if (!uri) return;

  const settings = readSettings();
  const maxBytes = settings.importMaxFileSizeMb * 1024 * 1024;
  const source = uri.path.split('/').pop() || 'session';

  try {
    // Size is checked before the file is read so an oversized file never reaches memory.
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > maxBytes) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      vscode.window.showErrorMessage(
        `File is ${mb} MB, above the ${settings.importMaxFileSizeMb} MB import limit. ` +
          'Raise otel.import.maxFileSize to load it.'
      );
      return;
    }

    const { parsed, loaded } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading session…' },
      async () => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const parsed = parseSessionFile(
          new TextDecoder('utf-8', { fatal: false }).decode(bytes),
          settings.importMaxRecords
        );
        const loaded = controller.store.importSession({
          sourceLabel: source,
          traces: parsed.traces,
          logs: parsed.logs,
          metrics: parsed.metrics,
        });
        return { parsed, loaded };
      }
    );

    const instances = loaded.instanceIds.map((id) => controller.store.getInstance(id)!);
    const traceIds = new Set(instances.flatMap((i) => [...i.traces.keys()]));
    const spans = instances.reduce((n, i) => n + i.spanCount, 0);
    const logs = instances.reduce((n, i) => n + i.logCount, 0);
    const skippedNote = parsed.skipped
      ? ` ${plural(parsed.skipped, 'unreadable line')} skipped (${parsed.skippedSample}).`
      : '';
    vscode.window.showInformationMessage(
      `Loaded ${plural(spans, 'span')}, ${plural(logs, 'log')} and ` +
        `${plural(parsed.counts.metricPoints, 'metric point')} from ${source}.${skippedNote}`
    );
    if (traceIds.size === 1) {
      revealTrace(controller, { traceId: [...traceIds][0], preferInstanceId: loaded.instanceIds[0] });
    } else {
      await vscode.commands.executeCommand('otel.instances.focus');
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Could not load the session. ${(e as Error).message}`);
  }
}
