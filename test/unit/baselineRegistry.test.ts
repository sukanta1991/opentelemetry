// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { BaselineFileError } from '../../src/views/baselineFile';
import {
  BaselineMemento,
  BaselineRegistry,
  BaselineRegistryError,
  BaselineStorage,
  MAX_SAVED_BASELINES,
  MAX_UNSAVED_BASELINES,
} from '../../src/views/baselineRegistry';
import { T0 } from './aiFixtures';
import { apiCalls, capture } from './baselineFixtures';

const snapshot = capture(apiCalls(Array.from({ length: 10 }, (_, i) => ({ endMs: T0 + i, dbMs: 2 }))));

class FakeMemento implements BaselineMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
}

class FakeStorage implements BaselineStorage {
  readonly files = new Map<string, string>();
  reads = 0;
  failWrite = false;
  failRemove = false;
  async read(id: string): Promise<string> {
    this.reads++;
    const text = this.files.get(id);
    if (text === undefined) throw new Error('ENOENT');
    return text;
  }
  async write(id: string, text: string): Promise<void> {
    if (this.failWrite) throw new Error('disk full');
    this.files.set(id, text);
  }
  async remove(id: string): Promise<void> {
    if (this.failRemove) throw new Error('busy');
    this.files.delete(id);
  }
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

function setup(memento = new FakeMemento(), storage = new FakeStorage()) {
  let clock = T0;
  const registry = new BaselineRegistry(memento, storage, uuid, () => (clock += 1000));
  let changes = 0;
  registry.onDidChange(() => changes++);
  return { registry, memento, storage, changes: () => changes };
}

describe('BaselineRegistry', () => {
  it('lists unsaved then saved baselines, newest first, and fires changes', async () => {
    const { registry, changes } = setup();
    const a = registry.add('a', snapshot).meta;
    const b = registry.add('b', snapshot).meta;
    await registry.save(a.id);
    const c = registry.add('c', snapshot).meta;
    assert.deepStrictEqual(
      registry.list().map((m) => [m.name, m.saved]),
      [
        ['c', false],
        ['b', false],
        ['a', true],
      ]
    );
    assert.strictEqual(registry.get(c.id)?.sourceKind, 'window');
    assert.strictEqual(changes(), 4);
    assert.strictEqual(b.createdMs < c.createdMs, true);
  });

  it(`keeps at most ${MAX_UNSAVED_BASELINES} unsaved baselines, dropping the oldest and its active flag`, async () => {
    const { registry } = setup();
    const first = registry.add('first', snapshot).meta;
    await registry.setActive(first.id);
    let evicted;
    for (let i = 0; i < MAX_UNSAVED_BASELINES; i++) evicted = registry.add(`n${i}`, snapshot).evicted;
    assert.strictEqual(evicted?.id, first.id);
    assert.strictEqual(registry.list().length, MAX_UNSAVED_BASELINES);
    assert.strictEqual(registry.activeId, undefined);
  });

  it('saves to storage, persists the index, and restores saved baselines on reload', async () => {
    const { registry, memento, storage } = setup();
    const kept = registry.add('kept', snapshot).meta;
    registry.add('scratch', snapshot);
    const saved = await registry.save(kept.id);
    await registry.setActive(kept.id);
    assert.strictEqual(saved.saved, true);
    assert.strictEqual(saved.bytes, storage.files.get(kept.id)!.length);

    const reloaded = setup(memento, storage).registry;
    assert.deepStrictEqual(
      reloaded.list().map((m) => m.name),
      ['kept']
    );
    assert.strictEqual(reloaded.activeId, kept.id);
    assert.deepStrictEqual((await reloaded.load(kept.id))?.snapshot, snapshot);
  });

  it('keeps the unsaved copy when the write fails, and enforces the saved limit', async () => {
    const { registry, storage } = setup();
    const a = registry.add('a', snapshot).meta;
    storage.failWrite = true;
    await assert.rejects(registry.save(a.id), /disk full/);
    assert.strictEqual(registry.get(a.id)?.saved, false);
    storage.failWrite = false;
    await assert.rejects(registry.save('nope'), BaselineRegistryError);

    for (let i = 0; i < MAX_SAVED_BASELINES; i++) await registry.save(registry.add(`s${i}`, snapshot).meta.id);
    await assert.rejects(registry.save(a.id), /up to 50 saved/);
  });

  it('remembers only saved baselines as active, and refuses unknown ids', async () => {
    const { registry, memento, storage } = setup();
    const scratch = registry.add('scratch', snapshot).meta;
    await registry.setActive(scratch.id);
    assert.strictEqual(registry.activeId, scratch.id);
    assert.strictEqual(setup(memento, storage).registry.activeId, undefined);
    await assert.rejects(registry.setActive('missing'), BaselineRegistryError);
  });

  it('loads saved bodies once, keeps two parsed, and re-reads evicted ones', async () => {
    const { registry, memento, storage } = setup();
    const ids: string[] = [];
    for (const n of ['a', 'b', 'c']) {
      const id = registry.add(n, snapshot).meta.id;
      await registry.save(id);
      ids.push(id);
    }
    const fresh = setup(memento, storage).registry;
    await fresh.load(ids[0]);
    await fresh.load(ids[0]);
    assert.strictEqual(storage.reads, 1);
    await fresh.load(ids[1]);
    await fresh.load(ids[2]);
    await fresh.load(ids[0]);
    assert.strictEqual(storage.reads, 4);
  });

  it('flags unreadable bodies as unavailable and recovers once fixed', async () => {
    const { registry, memento, storage } = setup();
    const id = registry.add('x', snapshot).meta.id;
    await registry.save(id);
    const good = storage.files.get(id)!;
    storage.files.set(id, '{"format":"otel-baseline","version":1,"snapshot":{}}');
    const fresh = setup(memento, storage);
    assert.strictEqual(await fresh.registry.load(id), undefined);
    assert.strictEqual(fresh.registry.get(id)?.unavailable, true);
    assert.strictEqual(fresh.changes(), 1);
    storage.files.set(id, good);
    assert.ok(await fresh.registry.load(id));
    assert.strictEqual(fresh.registry.get(id)?.unavailable, undefined);
  });

  it('renames with the same cleaning as names on capture', async () => {
    const { registry, memento, storage } = setup();
    const u = registry.add('u', snapshot).meta.id;
    const s = registry.add('s', snapshot).meta.id;
    await registry.save(s);
    await registry.rename(u, ' new\u202e ');
    await registry.rename(s, 'saved name');
    assert.strictEqual(registry.get(u)?.name, 'new');
    assert.strictEqual(setup(memento, storage).registry.get(s)?.name, 'saved name');
  });

  it('removes baselines, their files and their active flag, even if the file delete fails', async () => {
    const { registry, memento, storage } = setup();
    const id = registry.add('x', snapshot).meta.id;
    await registry.save(id);
    await registry.setActive(id);
    storage.failRemove = true;
    await registry.remove(id);
    assert.strictEqual(registry.get(id), undefined);
    assert.strictEqual(registry.activeId, undefined);
    assert.deepStrictEqual(setup(memento, storage).registry.list(), []);
    const u = registry.add('u', snapshot).meta.id;
    await registry.remove(u);
    assert.deepStrictEqual(registry.list(), []);
  });

  it('imports files as unsaved baselines that never match a live realm', async () => {
    const { registry } = setup();
    const id = registry.add('main', snapshot).meta.id;
    const text = (await registry.exportText(id))!;
    const imported = registry.importText(text, 'team-main.otel-baseline.json');
    assert.deepStrictEqual([imported.name, imported.saved, imported.sourceKind, imported.sourceLabel], ['main', false, 'file', 'team-main.otel-baseline.json']);
    const loaded = (await registry.load(imported.id))!;
    assert.strictEqual(loaded.snapshot.source.realm, 'file:team-main.otel-baseline.json');
    assert.deepStrictEqual(loaded.snapshot.entries, snapshot.entries);
    assert.throws(() => registry.importText('{}', 'x.json'), BaselineFileError);
  });

  it('ignores index entries whose ids could escape the storage folder', () => {
    const memento = new FakeMemento();
    memento.values.set('otel.baselines.index', [
      { id: '../../evil', name: 'evil', createdMs: 1 },
      { id: uuid(), name: 'ok\u0000', createdMs: 2, sourceKind: 'bogus' },
      'junk',
      null,
    ]);
    memento.values.set('otel.baselines.active', '../../evil');
    const { registry } = setup(memento);
    assert.deepStrictEqual(
      registry.list().map((m) => [m.name, m.sourceKind]),
      [['ok', 'file']]
    );
    assert.strictEqual(registry.activeId, undefined);
  });

  it('keeps notifying other listeners when one throws', () => {
    const { registry, changes } = setup();
    registry.onDidChange(() => {
      throw new Error('listener bug');
    });
    registry.add('x', snapshot);
    assert.strictEqual(changes(), 1);
  });
});
