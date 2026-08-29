import * as vscode from 'vscode';
import { ReceiverConfig } from './receiver/receiver';

export interface OtelSettings extends ReceiverConfig {
  launchOnStartup: boolean;
  overwriteEnvVars: boolean;
  maxLogsPerInstance: number;
  maxTracesPerInstance: number;
  maxMetricPointsPerSeries: number;
}

export function readSettings(): OtelSettings {
  const c = vscode.workspace.getConfiguration('otel');
  const mode = c.get<string>('port.mode', 'fixed') === 'random' ? 'random' : 'fixed';
  return {
    host: c.get<string>('host', '127.0.0.1'),
    portMode: mode,
    grpcPort: c.get<number>('port.grpc', 4317),
    httpPort: c.get<number>('port.http', 4318),
    launchOnStartup: c.get<boolean>('launchOnStartup', false),
    overwriteEnvVars: c.get<boolean>('overwriteEnvVars', true),
    maxLogsPerInstance: c.get<number>('retention.maxLogsPerInstance', 5000),
    maxTracesPerInstance: c.get<number>('retention.maxTracesPerInstance', 2000),
    maxMetricPointsPerSeries: c.get<number>('retention.maxMetricPointsPerSeries', 500),
  };
}
