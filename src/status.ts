// SPDX-License-Identifier: Apache-2.0
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

export interface BaselineStatusState {
  name: string;
  // From the live map's last refresh; undefined when no live map is comparing.
  summary?: { regressed: number; improved: number };
  waiting?: boolean;
}

// Shown only while a baseline is active; never computes anything itself.
export class BaselineStatus {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);

  constructor() {
    this.item.command = 'otel.openServiceMap';
  }

  update(state: BaselineStatusState | undefined): void {
    if (!state) {
      this.item.hide();
      return;
    }
    // A `$(` in a user-chosen name would render as an icon.
    const name = state.name.replace(/\$\(/g, '$ (');
    if (state.waiting) {
      this.item.text = `$(history) ${name}: waiting`;
      this.item.tooltip = `Baseline “${state.name}”: no calls since the cut-off yet. Click to open the service map.`;
    } else if (state.summary) {
      const { regressed, improved } = state.summary;
      this.item.text = `$(history) ${name}: $(arrow-up)${regressed} $(arrow-down)${improved}`;
      this.item.tooltip =
        `Baseline “${state.name}”: ${regressed} regressed, ${improved} improved (services and calls). ` +
        'Click to open the service map.';
    } else {
      this.item.text = `$(history) ${name}`;
      this.item.tooltip = `Baseline “${state.name}” is active. Open the service map in “vs Baseline” mode to compare.`;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
