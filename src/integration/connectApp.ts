// SPDX-License-Identifier: Apache-2.0
// VS Code-free building blocks for the "Connect Your App…" flow.
import type { ReceiverEndpoints } from '../receiver/receiver';

export type Shell = 'posix' | 'powershell';

/** Environment that points any OpenTelemetry SDK at the receiver's gRPC endpoint for all three signals. */
export function otlpEnv(grpcEndpoint: string): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: grpcEndpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
  };
}

// Single quotes keep values literal in both shells; the endpoint host comes from user settings.
function quote(value: string, shell: Shell): string {
  return shell === 'powershell' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function envLine(name: string, value: string, shell: Shell): string {
  return shell === 'powershell' ? `$env:${name} = ${quote(value, shell)}` : `export ${name}=${quote(value, shell)}`;
}

export function envBlock(env: Record<string, string>, shell: Shell): string {
  return Object.entries(env)
    .map(([k, v]) => envLine(k, v, shell))
    .join('\n');
}

export type ConnectAction = 'debug' | 'terminal' | 'copyEnvPosix' | 'copyEnvPowerShell' | 'copyGrpc' | 'copyHttp' | 'snippet';

export interface MenuItem<A extends string> {
  /** Undefined for separators. */
  action?: A;
  label: string;
  description?: string;
  detail?: string;
  separator?: boolean;
}

export interface ConnectOptions {
  endpoints: ReceiverEndpoints;
  overwriteEnvVars: boolean;
  /** Lists the PowerShell variant first. */
  windows: boolean;
}

export function connectItems({ endpoints, overwriteEnvVars, windows }: ConnectOptions): MenuItem<ConnectAction>[] {
  const posix: MenuItem<ConnectAction> = {
    action: 'copyEnvPosix',
    label: '$(copy) Copy environment variables (bash/zsh)',
    detail: 'Paste into the shell that starts your app. Sets the endpoint, protocol and the traces, metrics and logs exporters.',
  };
  const powershell: MenuItem<ConnectAction> = {
    action: 'copyEnvPowerShell',
    label: '$(copy) Copy environment variables (PowerShell)',
    detail: 'Paste into the PowerShell session that starts your app.',
  };
  return [
    { label: 'Launch from VS Code', separator: true },
    {
      action: 'debug',
      label: '$(debug-alt) Start debugging (F5)',
      detail: overwriteEnvVars
        ? 'Debug sessions get OTEL_EXPORTER_OTLP_ENDPOINT automatically while the receiver is running.'
        : 'Automatic endpoint injection is off (otel.overwriteEnvVars). Add the environment variables to your launch configuration.',
    },
    {
      action: 'terminal',
      label: '$(terminal) Open terminal with OTLP environment',
      detail: 'Run your app from this terminal; the OTEL_* variables are already set.',
    },
    { label: 'Configure manually', separator: true },
    ...(windows ? [powershell, posix] : [posix, powershell]),
    {
      action: 'copyGrpc',
      label: '$(link) Copy gRPC endpoint',
      description: endpoints.grpcEndpoint,
      detail: 'For exporters using OTLP/gRPC (the default for most SDKs).',
    },
    {
      action: 'copyHttp',
      label: '$(link) Copy HTTP endpoint',
      description: endpoints.httpEndpoint,
      detail: 'For OTLP/HTTP exporters (OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf or http/json).',
    },
    {
      action: 'snippet',
      label: '$(code) Show code snippet…',
      detail: 'Exporter setup for Node.js, Python, Go, .NET and Java.',
    },
  ];
}

export interface StatusMenuOptions {
  running: boolean;
  hasData: boolean;
  /** Message of the last failed start, if the receiver is stopped because of it. */
  startError?: string;
}

/** Status bar quick actions; each `action` is the command to run. */
export function statusMenuItems({ running, hasData, startError }: StatusMenuOptions): MenuItem<string>[] {
  const items: MenuItem<string>[] = [];
  if (running) {
    items.push({ action: 'otel.connectApp', label: '$(plug) Connect Your App…', detail: 'Send telemetry from your app to this receiver.' });
  } else {
    items.push({
      action: 'otel.start',
      label: '$(play) Start Receiver',
      detail: startError ? `Last attempt failed: ${startError}. Ports and host are under Settings.` : 'Listen for OTLP from your apps.',
    });
    items.push(
      { action: 'otel.connectApp', label: '$(plug) Connect Your App…' },
      { action: 'otel.loadSession', label: '$(go-to-file) Load Saved Session…', detail: 'Explore telemetry saved earlier, without a running app.' }
    );
  }
  if (hasData) {
    items.push(
      { label: 'Explore', separator: true },
      { action: 'otel.openServiceMap', label: '$(type-hierarchy) Open Service Map' },
      { action: 'otel.openTraces', label: '$(list-tree) Open Traces…' },
      { action: 'otel.openLogs', label: '$(output) Open Logs…' },
      { action: 'otel.openMetrics', label: '$(dashboard) Open Metrics…' },
      { action: 'otel.findTrace', label: '$(search) Find Trace by ID…' }
    );
  }
  if (running) {
    items.push(
      { label: 'Receiver', separator: true },
      { action: 'otel.copyEndpoint', label: '$(copy) Copy Endpoint…' },
      { action: 'otel.restart', label: '$(debug-restart) Restart Receiver' },
      { action: 'otel.stop', label: '$(debug-stop) Stop Receiver', detail: 'Collected data stays until you clear it or close VS Code.' }
    );
  }
  items.push(
    { label: 'Help', separator: true },
    { action: 'otel.openWalkthrough', label: '$(rocket) Get Started' },
    { action: 'otel.openSettings', label: '$(gear) Settings' }
  );
  return items;
}
