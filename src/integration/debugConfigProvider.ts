import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readSettings } from '../settings';

/** Injects the OTLP endpoint env var into launch/debug configurations. */
export class OtelDebugConfigProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly controller: OtelController) {}

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const settings = readSettings();
    if (!settings.overwriteEnvVars) return config;
    const ep = this.controller.getEndpoints();
    if (!ep) return config;
    const env = { ...(config.env ?? {}) };
    if (env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      env.OTEL_EXPORTER_OTLP_ENDPOINT = ep.grpcEndpoint;
    }
    if (env.OTEL_EXPORTER_OTLP_PROTOCOL === undefined) {
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    }
    config.env = env;
    return config;
  }
}
