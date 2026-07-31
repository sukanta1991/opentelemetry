import * as vscode from 'vscode';
import { ReceiverEndpoints } from './receiver/receiver';

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.show();
    this.setStopped();
  }

  setStopped(): void {
    this.item.text = '$(circle-slash) OTel: off';
    this.item.tooltip = 'OpenTelemetry receiver is stopped. Click to start.';
    this.item.command = 'otel.start';
    this.item.backgroundColor = undefined;
  }

  setRunning(ep: ReceiverEndpoints): void {
    this.item.text = `$(broadcast) OTel: ${ep.grpcPort}/${ep.httpPort}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**OpenTelemetry receiver running**\n\n` +
        `- gRPC: \`${ep.host}:${ep.grpcPort}\`\n` +
        `- HTTP: \`${ep.host}:${ep.httpPort}\`\n\n` +
        `\`OTEL_EXPORTER_OTLP_ENDPOINT=${ep.grpcEndpoint}\`\n\nClick to stop.`
    );
    this.item.command = 'otel.stop';
  }

  setError(message: string): void {
    this.item.text = '$(error) OTel: error';
    this.item.tooltip = message;
    this.item.command = 'otel.start';
  }

  dispose(): void {
    this.item.dispose();
  }
}
