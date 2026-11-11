// SPDX-License-Identifier: Apache-2.0
import { Application, Instance } from '../store/store';

export function instanceLabel(inst: Instance): string {
  // The hash is the last id segment for live (svc::hash) and loaded (imported::file::n::svc::hash) ids.
  return inst.serviceInstanceId ?? inst.id.split('::').pop() ?? inst.id;
}

export function instanceDescription(inst: Instance, withSource = true): string {
  const counts = `${inst.logCount} logs · ${inst.traces.size} traces · ${inst.metrics.size} metrics`;
  return inst.kind === 'imported' && withSource ? `${inst.source ?? 'file'} · ${counts}` : counts;
}

export function serviceDescription(instances: readonly Instance[]): string {
  let logs = 0;
  let traces = 0;
  let metrics = 0;
  for (const i of instances) {
    logs += i.logCount;
    traces += i.traces.size;
    metrics += i.metrics.size;
  }
  const n = instances.length;
  return `${n} instance${n === 1 ? '' : 's'} · ${logs} logs · ${traces} traces · ${metrics} metrics`;
}

export type Signal = 'traces' | 'logs' | 'metrics';

export interface SignalRow {
  signal: Signal;
  label: string;
  count: number;
  description: string;
  icon: string;
  command: string;
  tooltip: string;
}

const SIGNALS: { signal: Signal; label: string; icon: string; command: string; noun: string; exporter: string }[] = [
  { signal: 'traces', label: 'Traces', icon: 'list-tree', command: 'otel.openTraces', noun: 'traces', exporter: 'OTEL_TRACES_EXPORTER' },
  { signal: 'logs', label: 'Logs', icon: 'output', command: 'otel.openLogs', noun: 'logs', exporter: 'OTEL_LOGS_EXPORTER' },
  { signal: 'metrics', label: 'Metrics', icon: 'dashboard', command: 'otel.openMetrics', noun: 'metrics', exporter: 'OTEL_METRICS_EXPORTER' },
];

function signalCount(inst: Instance, signal: Signal): number {
  if (signal === 'traces') return inst.traces.size;
  if (signal === 'logs') return inst.logCount;
  return inst.metrics.size;
}

/** The Traces / Logs / Metrics rows shown under an instance, with a hint when a signal has no data. */
export function signalRows(inst: Instance): SignalRow[] {
  const imported = inst.kind === 'imported';
  return SIGNALS.map(({ signal, label, icon, command, noun, exporter }) => {
    const count = signalCount(inst, signal);
    let description = String(count);
    let tooltip = `Open ${noun} for ${inst.serviceName}`;
    if (!count) {
      description = imported ? 'none' : 'none yet';
      tooltip = imported
        ? `This file has no ${noun} for ${inst.serviceName}.`
        : `No ${noun} received from ${inst.serviceName} yet. They appear as soon as its SDK exports ${noun} over OTLP ` +
          `(${exporter}=otlp). Some SDKs need ${noun} enabled separately.`;
    }
    return { signal, label, count, description, icon, command, tooltip };
  });
}

// Changes only when apps/instances are added, removed or reordered — not when counts change.
export function treeShape(apps: Application[], imported: Instance[]): string {
  return JSON.stringify([
    apps.map((a) => [a.name, a.instances.map((i) => i.id)]),
    imported.map((i) => [i.realm, i.id]),
  ]);
}

export function diffDescriptions(
  prev: ReadonlyMap<string, string>,
  instances: Instance[]
): { changed: string[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const changed: string[] = [];
  for (const inst of instances) {
    const desc = instanceDescription(inst);
    next.set(inst.id, desc);
    if (prev.get(inst.id) !== desc) changed.push(inst.id);
  }
  return { changed, next };
}
