import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Receiver, ReceiverEndpoints } from './receiver/receiver';
import { TelemetryStore } from './store/store';
import { StatusBar } from './status';
import { OtelSettings, readSettings } from './settings';

function resolveProtoRoot(extensionPath: string): string {
  const distProto = path.join(extensionPath, 'dist', 'proto');
  if (fs.existsSync(distProto)) return distProto;
  return path.join(extensionPath, 'proto');
}

export class OtelController {
  readonly store: TelemetryStore;
  private readonly receiver: Receiver;
  private readonly statusBar: StatusBar;
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  constructor(extensionPath: string) {
    const settings = readSettings();
    this.store = new TelemetryStore(
      settings.maxLogsPerInstance,
      settings.maxTracesPerInstance
    );
    this.receiver = new Receiver(resolveProtoRoot(extensionPath), this.store);
    this.statusBar = new StatusBar();
    void this.setRunningContext(false);
  }

  isRunning(): boolean {
    return this.receiver.isRunning();
  }

  getEndpoints(): ReceiverEndpoints | undefined {
    return this.receiver.getEndpoints();
  }

  private async setRunningContext(running: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'otel.running', running);
  }

  async start(): Promise<void> {
    if (this.receiver.isRunning()) return;
    const settings = readSettings();
    this.store.setRetention(settings.maxLogsPerInstance, settings.maxTracesPerInstance);
    try {
      const ep = await this.receiver.start(settings);
      this.statusBar.setRunning(ep);
      await this.setRunningContext(true);
      this.onDidChangeStateEmitter.fire();
    } catch (e: any) {
      await this.handleStartError(e, settings);
    }
  }

  private async handleStartError(e: any, settings: OtelSettings): Promise<void> {
    const inUse = e && (e.code === 'EADDRINUSE' || /in use|address already/i.test(String(e?.message)));
    this.statusBar.setError(String(e?.message ?? e));
    if (inUse && settings.portMode === 'fixed') {
      const pick = await vscode.window.showErrorMessage(
        `OpenTelemetry: port ${settings.grpcPort}/${settings.httpPort} is in use.`,
        'Retry on random ports'
      );
      if (pick) {
        try {
          const ep = await this.receiver.start({ ...settings, portMode: 'random' });
          this.statusBar.setRunning(ep);
          await this.setRunningContext(true);
          this.onDidChangeStateEmitter.fire();
          return;
        } catch (e2: any) {
          this.statusBar.setError(String(e2?.message ?? e2));
        }
      }
    } else {
      vscode.window.showErrorMessage(`OpenTelemetry: failed to start receiver: ${e?.message ?? e}`);
    }
  }

  async stop(): Promise<void> {
    await this.receiver.stop();
    this.statusBar.setStopped();
    await this.setRunningContext(false);
    this.onDidChangeStateEmitter.fire();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  clear(): void {
    this.store.clear();
  }

  reloadRetention(): void {
    const s = readSettings();
    this.store.setRetention(s.maxLogsPerInstance, s.maxTracesPerInstance);
  }

  /** Endpoint apps should export to (gRPC by convention, matching OTEL default). */
  exportEndpoint(): string | undefined {
    const ep = this.receiver.getEndpoints();
    return ep?.grpcEndpoint;
  }

  dispose(): void {
    this.statusBar.dispose();
    this.onDidChangeStateEmitter.dispose();
    void this.receiver.stop();
  }
}
