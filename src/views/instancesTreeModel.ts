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
