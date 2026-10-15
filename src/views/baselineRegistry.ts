// SPDX-License-Identifier: Apache-2.0
// Named baselines: unsaved ones in memory, saved ones as files with an index in workspace state.
// No vscode import: storage and state are injected (see baselineIo.ts for the VS Code side).

import { randomUUID } from 'crypto';
import { Snapshot, SnapshotSourceKind } from './baseline';
import { parseBaselineFile, sanitizeBaselineName, serializeBaseline } from './baselineFile';

export const MAX_UNSAVED_BASELINES = 5;
export const MAX_SAVED_BASELINES = 50;
const SOURCE_KINDS: ReadonlySet<string> = new Set<SnapshotSourceKind>(['window', 'mark', 'time', 'session', 'file']);
// Bodies kept parsed: the active one plus one more for baseline-vs-baseline.
const BODY_CACHE_SIZE = 2;
const INDEX_KEY = 'otel.baselines.index';
const ACTIVE_KEY = 'otel.baselines.active';
// Ids become file names, so only host-generated UUIDs are ever accepted.
export const BASELINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BaselineMeta {
  id: string;
  name: string;
  createdMs: number;
  sourceKind: SnapshotSourceKind;
  sourceLabel: string;
  saved: boolean;
  bytes?: number;
  unavailable?: boolean;
}

export interface StoredBaseline {
  meta: BaselineMeta;
  snapshot: Snapshot;
}

export interface BaselineStorage {
  read(id: string): Promise<string>;
  write(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface BaselineMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class BaselineRegistryError extends Error {}

function readIndex(raw: unknown): BaselineMeta[] {
  if (!Array.isArray(raw)) return [];
  const out: BaselineMeta[] = [];
  for (const r of raw.slice(0, MAX_SAVED_BASELINES)) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Record<string, unknown>;
    if (typeof m.id !== 'string' || !BASELINE_ID.test(m.id) || typeof m.createdMs !== 'number') continue;
    out.push({
      id: m.id,
      name: sanitizeBaselineName(m.name),
      createdMs: m.createdMs,
      sourceKind: typeof m.sourceKind === 'string' && SOURCE_KINDS.has(m.sourceKind) ? (m.sourceKind as SnapshotSourceKind) : 'file',
      sourceLabel: typeof m.sourceLabel === 'string' ? sanitizeBaselineName(m.sourceLabel, '') : '',
      saved: true,
      bytes: typeof m.bytes === 'number' ? m.bytes : undefined,
    });
  }
  return out;
}

export class BaselineRegistry {
  private readonly unsaved: StoredBaseline[] = [];
  private saved: BaselineMeta[];
  private readonly cache = new Map<string, StoredBaseline>();
  private readonly unavailable = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private active: string | undefined;

  constructor(
    private readonly memento: BaselineMemento,
    private readonly storage: BaselineStorage,
    private readonly newId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {
    this.saved = readIndex(memento.get(INDEX_KEY));
    const active = memento.get<unknown>(ACTIVE_KEY);
    this.active = typeof active === 'string' && this.saved.some((m) => m.id === active) ? active : undefined;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  // Unsaved first, then saved; newest first within each.
  list(): BaselineMeta[] {
    const saved = [...this.saved]
      .sort((a, b) => b.createdMs - a.createdMs)
      .map((m) => (this.unavailable.has(m.id) ? { ...m, unavailable: true } : { ...m }));
    return [...this.unsaved.map((u) => ({ ...u.meta })).reverse(), ...saved];
  }

  get activeId(): string | undefined {
    return this.active;
  }

  get(id: string): BaselineMeta | undefined {
    return this.list().find((m) => m.id === id);
  }

  // Returns the unsaved baseline dropped to stay under the limit, if any.
  add(name: string, snapshot: Snapshot): { meta: BaselineMeta; evicted?: BaselineMeta } {
    const meta: BaselineMeta = {
      id: this.newId(),
      name: sanitizeBaselineName(name),
      createdMs: this.now(),
      sourceKind: snapshot.source.kind,
      sourceLabel: snapshot.source.label,
      saved: false,
    };
    this.unsaved.push({ meta, snapshot });
    let evicted: BaselineMeta | undefined;
    if (this.unsaved.length > MAX_UNSAVED_BASELINES) {
      evicted = this.unsaved.shift()!.meta;
      if (this.active === evicted.id) this.active = undefined;
    }
    this.fire();
    return { meta: { ...meta }, evicted };
  }

  // Adds a validated file as an unsaved baseline; it never matches a live realm, so no cut-off applies.
  importText(text: string, fileName: string): BaselineMeta {
    const file = parseBaselineFile(text);
    const label = sanitizeBaselineName(fileName, 'file');
    const snapshot: Snapshot = { ...file.snapshot, source: { ...file.snapshot.source, kind: 'file', label, realm: `file:${label}` } };
    return this.add(file.name, snapshot).meta;
  }

  async exportText(id: string): Promise<string | undefined> {
    const b = await this.load(id);
    return b && serializeBaseline({ name: b.meta.name, createdMs: b.meta.createdMs, snapshot: b.snapshot });
  }

  // A failed write leaves the unsaved copy in place.
  async save(id: string): Promise<BaselineMeta> {
    const i = this.unsaved.findIndex((u) => u.meta.id === id);
    if (i < 0) throw new BaselineRegistryError('Only unsaved baselines can be saved.');
    if (this.saved.length >= MAX_SAVED_BASELINES) {
      throw new BaselineRegistryError(`You can keep up to ${MAX_SAVED_BASELINES} saved baselines. Delete one first.`);
    }
    const { meta, snapshot } = this.unsaved[i];
    const text = serializeBaseline({ name: meta.name, createdMs: meta.createdMs, snapshot });
    await this.storage.write(id, text);
    const savedMeta: BaselineMeta = { ...meta, saved: true, bytes: text.length };
    this.unsaved.splice(this.unsaved.findIndex((u) => u.meta.id === id), 1);
    this.saved = [...this.saved, savedMeta];
    this.remember(id, { meta: savedMeta, snapshot });
    await this.persistIndex();
    this.fire();
    return { ...savedMeta };
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = sanitizeBaselineName(name);
    const u = this.unsaved.find((x) => x.meta.id === id);
    if (u) u.meta.name = clean;
    else {
      const s = this.saved.find((x) => x.id === id);
      if (!s) return;
      this.saved = this.saved.map((x) => (x.id === id ? { ...x, name: clean } : x));
      const cached = this.cache.get(id);
      if (cached) cached.meta = { ...cached.meta, name: clean };
      await this.persistIndex();
    }
    this.fire();
  }

  async remove(id: string): Promise<void> {
    const i = this.unsaved.findIndex((u) => u.meta.id === id);
    if (i >= 0) this.unsaved.splice(i, 1);
    else if (this.saved.some((m) => m.id === id)) {
      this.saved = this.saved.filter((m) => m.id !== id);
      this.cache.delete(id);
      this.unavailable.delete(id);
      await this.persistIndex();
      // The index no longer points at the file, so a failed delete only leaves an orphan.
      await this.storage.remove(id).catch(() => undefined);
    } else return;
    if (this.active === id) await this.setActive(undefined);
    this.fire();
  }

  async setActive(id: string | undefined): Promise<void> {
    if (id !== undefined && !this.get(id)) throw new BaselineRegistryError('That baseline no longer exists.');
    this.active = id;
    // Unsaved baselines vanish on reload, so only saved ones are remembered as active.
    await this.memento.update(ACTIVE_KEY, id !== undefined && this.saved.some((m) => m.id === id) ? id : undefined);
    this.fire();
  }

  // Undefined when missing or unreadable; unreadable ones are flagged in list().
  async load(id: string): Promise<StoredBaseline | undefined> {
    const u = this.unsaved.find((x) => x.meta.id === id);
    if (u) return u;
    const meta = this.saved.find((m) => m.id === id);
    if (!meta) return undefined;
    const cached = this.cache.get(id);
    if (cached) {
      this.remember(id, cached);
      return cached;
    }
    try {
      const file = parseBaselineFile(await this.storage.read(id));
      const loaded = { meta: { ...meta }, snapshot: file.snapshot };
      this.unavailable.delete(id);
      this.remember(id, loaded);
      return loaded;
    } catch {
      if (!this.unavailable.has(id)) {
        this.unavailable.add(id);
        this.fire();
      }
      return undefined;
    }
  }

  private remember(id: string, b: StoredBaseline): void {
    this.cache.delete(id);
    this.cache.set(id, b);
    while (this.cache.size > BODY_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }

  private persistIndex(): Thenable<void> {
    return this.memento.update(
      INDEX_KEY,
      this.saved.map(({ id, name, createdMs, sourceKind, sourceLabel, bytes }) => ({ id, name, createdMs, sourceKind, sourceLabel, bytes }))
    );
  }
}
