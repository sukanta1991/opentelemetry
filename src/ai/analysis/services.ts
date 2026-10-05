// SPDX-License-Identifier: Apache-2.0
// otel_listServices: applications, instances and what each currently holds.

import { Instance, TelemetryStore } from '../../store/store';
import { ListServicesInput } from '../toolInputs';
import { iso } from '../serialize';
import { AnalysisContext, AnalysisOutput } from './common';

function instanceRow(inst: Instance) {
  return {
    id: inst.id,
    serviceInstanceId: inst.serviceInstanceId,
    kind: inst.kind,
    imported: inst.kind === 'imported' ? true : undefined,
    source: inst.source,
    logCount: inst.logCount,
    spanCount: inst.spanCount,
    traceCount: inst.traces.size,
    metricCount: inst.metrics.size,
    firstSeen: iso(inst.firstSeen),
    lastSeen: iso(inst.lastSeen),
  };
}

export function listServices(store: TelemetryStore, _input: ListServicesInput, ctx: AnalysisContext): AnalysisOutput {
  const byApp = new Map<string, Instance[]>();
  const traceIds = new Set<string>();
  let logsHeld = 0;
  let metrics = 0;
  for (const inst of store.getAllInstances()) {
    const list = byApp.get(inst.serviceName) ?? [];
    list.push(inst);
    byApp.set(inst.serviceName, list);
    for (const id of inst.traces.keys()) traceIds.add(id);
    logsHeld += store.getLogs(inst.id).length;
    metrics += inst.metrics.size;
  }

  const applications = [...byApp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, instances]) => ({
      name,
      instanceCount: instances.length,
      instances: instances
        .sort((a, b) => (a.serviceInstanceId ?? a.id).localeCompare(b.serviceInstanceId ?? b.id))
        .map(instanceRow),
    }));

  return {
    result: {
      receiverRunning: ctx.receiverRunning ?? false,
      // What is still held in memory; per-instance logCount/spanCount count everything received.
      totals: {
        applications: applications.length,
        instances: store.getAllInstances().length,
        traces: traceIds.size,
        logs: logsHeld,
        metrics,
      },
      applications,
    },
    refs: [],
    listKey: 'applications',
  };
}
