// SPDX-License-Identifier: Apache-2.0
import * as vscode from 'vscode';
import { AiSettings, sanitizeAiSettings } from './ai/aiSettings';
import { DEFAULT_MAX_ITEMS } from './ai/limits';
import { ReceiverConfig } from './receiver/receiver';
import { BaselineSettings, DEFAULT_BASELINE_SETTINGS, sanitizeBaselineSettings } from './views/baselineCompare';
import { DEFAULT_PRICING, Pricing, sanitizePricing } from './views/cardinalityCost';
import { CardinalitySettings, DEFAULT_CARDINALITY_SETTINGS, sanitizeCardinalitySettings } from './views/cardinalityRules';
import { ServiceMapThresholds, sanitizeThresholds } from './views/serviceMapModel';

export interface OtelSettings extends ReceiverConfig {
  launchOnStartup: boolean;
  overwriteEnvVars: boolean;
  maxLogsPerInstance: number;
  maxTracesPerInstance: number;
  maxMetricPointsPerSeries: number;
  importMaxFileSizeMb: number;
  importMaxRecords: number;
  cardinalityEnabled: boolean;
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
    importMaxFileSizeMb: Math.max(1, c.get<number>('import.maxFileSize', 200)),
    importMaxRecords: Math.max(1, c.get<number>('import.maxRecords', 50000)),
    cardinalityEnabled: c.get<boolean>('cardinality.enabled', true) !== false,
  };
}

export function useLocalTime(): boolean {
  return vscode.workspace.getConfiguration('otel').get<boolean>('useLocalTime', true);
}

export function readServiceMapThresholds(): ServiceMapThresholds {
  const c = vscode.workspace.getConfiguration('otel.serviceMap');
  return sanitizeThresholds({
    latencyWarnMs: c.get<unknown>('latencyWarnMs'),
    latencyCriticalMs: c.get<unknown>('latencyCriticalMs'),
    errorRateWarn: c.get<unknown>('errorRateWarn'),
    errorRateCritical: c.get<unknown>('errorRateCritical'),
  });
}

export function readBaselineSettings(): BaselineSettings {
  const c = vscode.workspace.getConfiguration('otel.serviceMap.baseline');
  return sanitizeBaselineSettings(
    Object.fromEntries(Object.keys(DEFAULT_BASELINE_SETTINGS).map((k) => [k, c.get<unknown>(k)]))
  );
}

export function readCardinalitySettings(): CardinalitySettings {
  const c = vscode.workspace.getConfiguration('otel.cardinality');
  return sanitizeCardinalitySettings(
    Object.fromEntries(Object.keys(DEFAULT_CARDINALITY_SETTINGS).map((k) => [k, c.get<unknown>(k)]))
  );
}

/** Prices from settings; the panel's workspace overrides are applied on top by the caller. */
export function readPricing(): Pricing {
  const c = vscode.workspace.getConfiguration('otel.cost');
  return sanitizePricing(Object.fromEntries(Object.keys(DEFAULT_PRICING).map((k) => [k, c.get<unknown>(k)])));
}

export function readAiSettings(): AiSettings {
  const c = vscode.workspace.getConfiguration('otel');
  // Only the user-level value can enable AI access; workspace values are ignored even if present.
  const enabled = typeof c.inspect === 'function' ? c.inspect<boolean>('ai.enabled')?.globalValue : c.get<boolean>('ai.enabled');
  return sanitizeAiSettings({
    enabled,
    redactAttributeKeys: c.get<unknown>('ai.redactAttributeKeys', []),
    maxResultItems: c.get<unknown>('ai.maxResultItems', DEFAULT_MAX_ITEMS),
  });
}
