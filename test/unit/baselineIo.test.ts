// SPDX-License-Identifier: Apache-2.0
// baselineIo against a minimal `vscode` fake: file storage, export warning and dialogs, import size checks.
import * as assert from 'assert';
import Module = require('module');
import { BaselineMemento } from '../../src/views/baselineRegistry';
import { T0 } from './aiFixtures';
import { apiCalls, capture } from './baselineFixtures';

interface FakeUri {
  path: string;
  fsPath: string;
}
const uri = (path: string): FakeUri => ({ path, fsPath: path });

const files = new Map<string, Uint8Array>();
const fsCalls: string[] = [];
let warningChoice: string | undefined;
let saveTarget: FakeUri | undefined;
let openTarget: FakeUri | undefined;
let statSize: number | undefined;
const shown: { kind: string; text: string; modal?: boolean }[] = [];

const fakeVscode = {
  Uri: {
    joinPath: (base: FakeUri, ...parts: string[]) => uri([base.path, ...parts].join('/')),
    file: (p: string) => uri(p),
  },
  workspace: {
    workspaceFolders: [{ uri: uri('/ws') }],
    fs: {
      readFile: async (u: FakeUri) => {
        fsCalls.push(`read ${u.path}`);
        const b = files.get(u.path);
        if (!b) throw new Error('ENOENT');
        return b;
      },
      writeFile: async (u: FakeUri, b: Uint8Array) => {
        fsCalls.push(`write ${u.path}`);
        files.set(u.path, b);
      },
      rename: async (from: FakeUri, to: FakeUri) => {
        fsCalls.push(`rename ${from.path} -> ${to.path}`);
        files.set(to.path, files.get(from.path)!);
        files.delete(from.path);
      },
      delete: async (u: FakeUri) => {
        fsCalls.push(`delete ${u.path}`);
        files.delete(u.path);
      },
      createDirectory: async (u: FakeUri) => {
        fsCalls.push(`mkdir ${u.path}`);
      },
      stat: async (u: FakeUri) => {
        fsCalls.push(`stat ${u.path}`);
        return { size: statSize ?? files.get(u.path)?.length ?? 0 };
      },
    },
  },
  window: {
    showWarningMessage: async (text: string, opts: { modal?: boolean }) => {
      shown.push({ kind: 'warning', text, modal: opts?.modal });
      return warningChoice;
    },
    showSaveDialog: async () => saveTarget,
    showOpenDialog: async () => (openTarget ? [openTarget] : undefined),
    showInformationMessage: async (text: string) => {
      shown.push({ kind: 'info', text });
    },
    showErrorMessage: async (text: string) => {
      shown.push({ kind: 'error', text });
    },
  },
};

class FakeMemento implements BaselineMemento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const snapshot = capture(apiCalls(Array.from({ length: 10 }, (_, i) => ({ endMs: T0 + i }))));
const text = (path: string) => new TextDecoder().decode(files.get(path));

describe('baselineIo', () => {
  const origLoad = (Module as any)._load;
  let io: typeof import('../../src/views/baselineIo');
  let reg: typeof import('../../src/views/baselineRegistry');

  // Modules load after the vscode fake is installed, so they are required here rather than imported.
  /* eslint-disable @typescript-eslint/no-require-imports */
  before(() => {
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    io = require('../../src/views/baselineIo');
    reg = require('../../src/views/baselineRegistry');
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(() => {
    (Module as any)._load = origLoad;
  });

  beforeEach(() => {
    files.clear();
    fsCalls.length = 0;
    shown.length = 0;
    warningChoice = undefined;
    saveTarget = undefined;
    openTarget = undefined;
    statSize = undefined;
  });

  const registry = () => new reg.BaselineRegistry(new FakeMemento(), io.fileBaselineStorage(uri('/store/baselines') as any));

  describe('fileBaselineStorage', () => {
    it('writes through a temp file and rename, then reads back', async () => {
      const r = registry();
      const id = r.add('main', snapshot).meta.id;
      await r.save(id);
      assert.deepStrictEqual(fsCalls, [
        'mkdir /store/baselines',
        `write /store/baselines/${id}.json.tmp`,
        `rename /store/baselines/${id}.json.tmp -> /store/baselines/${id}.json`,
      ]);
      const storage = io.fileBaselineStorage(uri('/store/baselines') as any);
      assert.strictEqual(await storage.read(id), text(`/store/baselines/${id}.json`));
    });

    it('refuses ids that are not UUIDs before touching the file system', async () => {
      const storage = io.fileBaselineStorage(uri('/store/baselines') as any);
      for (const id of ['../../etc/passwd', 'x', '']) {
        await assert.rejects(storage.read(id), /Invalid baseline id/);
        await assert.rejects(storage.write(id, '{}'), /Invalid baseline id/);
        await assert.rejects(storage.remove(id), /Invalid baseline id/);
      }
      assert.deepStrictEqual(fsCalls, []);
    });
  });

  describe('exportBaselineToFile', () => {
    it('writes nothing when the warning is dismissed', async () => {
      const r = registry();
      const id = r.add('main', snapshot).meta.id;
      saveTarget = uri('/ws/out.json');
      assert.strictEqual(await io.exportBaselineToFile(r, id), false);
      assert.deepStrictEqual(shown, [{ kind: 'warning', text: io.EXPORT_WARNING, modal: true }]);
      assert.deepStrictEqual(fsCalls, []);
    });

    it('writes the file after the warning and the save dialog', async () => {
      const r = registry();
      const id = r.add('main/branch', snapshot).meta.id;
      warningChoice = 'Export';
      saveTarget = uri('/ws/out.json');
      assert.strictEqual(await io.exportBaselineToFile(r, id), true);
      assert.deepStrictEqual(fsCalls, ['write /ws/out.json']);
      assert.ok(text('/ws/out.json').includes('"format":"otel-baseline"'));
      assert.strictEqual(shown[1].kind, 'info');
    });

    it('writes nothing when the save dialog is cancelled', async () => {
      const r = registry();
      const id = r.add('main', snapshot).meta.id;
      warningChoice = 'Export';
      assert.strictEqual(await io.exportBaselineToFile(r, id), false);
      assert.deepStrictEqual(fsCalls, []);
    });
  });

  describe('importBaselineFromFile', () => {
    it('adds a valid file as an unsaved baseline', async () => {
      const source = registry();
      const exported = (await source.exportText(source.add('team main', snapshot).meta.id))!;
      files.set('/ws/team.otel-baseline.json', Buffer.from(exported, 'utf8'));
      openTarget = uri('/ws/team.otel-baseline.json');
      const r = registry();
      const meta = await io.importBaselineFromFile(r);
      assert.deepStrictEqual([meta?.name, meta?.saved, meta?.sourceLabel], ['team main', false, 'team.otel-baseline.json']);
      assert.strictEqual(r.list().length, 1);
    });

    it('refuses oversized files without reading them', async () => {
      openTarget = uri('/ws/huge.json');
      statSize = 9 * 1024 * 1024;
      assert.strictEqual(await io.importBaselineFromFile(registry()), undefined);
      assert.deepStrictEqual(fsCalls, ['stat /ws/huge.json']);
      assert.match(shown[0].text, /9\.0 MB, above the 8 MB/);
    });

    it('reports why a file was rejected', async () => {
      files.set('/ws/bad.json', Buffer.from('{"format":"otel-session"}', 'utf8'));
      openTarget = uri('/ws/bad.json');
      const r = registry();
      assert.strictEqual(await io.importBaselineFromFile(r), undefined);
      assert.deepStrictEqual(shown, [{ kind: 'error', text: 'Could not import the baseline. Not an OpenTelemetry baseline file.' }]);
      assert.deepStrictEqual(r.list(), []);
    });
  });
});
