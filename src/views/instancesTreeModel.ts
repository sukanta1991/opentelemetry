import { Application, Instance } from '../store/store';

export function instanceLabel(inst: Instance): string {
  return inst.serviceInstanceId ?? inst.id.split('::')[1] ?? inst.id;
}

export function instanceDescription(inst: Instance): string {
  if (inst.kind === 'imported') return `${inst.source ?? 'file'} · ${inst.logCount} logs`;
  return `${inst.logCount} logs · ${inst.traces.size} traces · ${inst.metrics.size} metrics`;
}

// Changes only when apps/instances are added, removed or reordered — not when counts change.
export function treeShape(apps: Application[], imported: Instance[]): string {
  return JSON.stringify([
    apps.map((a) => [a.name, a.instances.map((i) => i.id)]),
    imported.map((i) => i.id),
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
