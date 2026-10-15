// SPDX-License-Identifier: Apache-2.0
// ServiceMapPanel against a minimal `vscode` fake: refresh throttling, hidden panels, de-duplication,
// message validation, actions and lifecycle. Uses real timers (store debounce 150 ms, throttle 500 ms).
import * as assert from 'assert';
import Module = require('module');
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { captureSnapshot } from '../../src/views/baseline';
import { BaselineRegistry } from '../../src/views/baselineRegistry';
import { T0, addDistributedTrace, addSpans, span } from './aiFixtures';

type Listener = (e?: any) => void;

function event(list: Listener[]) {
  return (cb: Listener, _this?: unknown, disposables?: { dispose(): void }[]) => {
    list.push(cb);
    const d = { dispose: () => list.splice(list.indexOf(cb) >>> 0, 1) };
    disposables?.push(d);
    return d;
  };
}

class FakePanel {
  visible = true;
  disposed = false;
  posted: any[] = [];
  receive: Listener[] = [];
  viewState: Listener[] = [];
  disposeListeners: Listener[] = [];
  webview = {
    html: '',
    cspSource: 'fake',
    asWebviewUri: (u: unknown) => u,
    onDidReceiveMessage: event(this.receive),
    postMessage: (m: unknown) => {
      this.posted.push(JSON.parse(JSON.stringify(m)));
      return Promise.resolve(true);
    },
  };
  onDidChangeViewState = event(this.viewState);
  onDidDispose = event(this.disposeListeners);
  reveal() {}
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const l of [...this.disposeListeners]) l();
  }
  send(m: unknown) {
    for (const l of this.receive) l(m);
  }
  setVisible(v: boolean) {
    this.visible = v;
    for (const l of this.viewState) l();
  }
  updates() {
    return this.posted.filter((m) => m.type === 'update');
  }
}

const panels: FakePanel[] = [];
const configListeners: Listener[] = [];
let config: Record<string, unknown> = {};
let quickPick: (items: any[]) => any = () => undefined;
const info: string[] = [];

const fakeVscode = {
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const fsPath = [base.fsPath, ...parts].join('/');
      return { fsPath, toString: () => fsPath };
    },
  },
  window: {
    createWebviewPanel: () => {
      const p = new FakePanel();
      panels.push(p);
      return p;
    },
    showInformationMessage: (m: string) => {
      info.push(m);
      return Promise.resolve(undefined);
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showQuickPick: (items: any[]) => Promise.resolve(quickPick(items)),
  },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        const full = section ? `${section}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : def;
      },
    }),
    onDidChangeConfiguration: event(configListeners),
  },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  env: {
    clipboard: {
      writeText: (t: string) => {
        clipboard.push(t);
        return Promise.resolve();
      },
    },
  },
};
const clipboard: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

describe('ServiceMapPanel', function () {
  this.timeout(10_000);
  const origLoad = (Module as any)._load;
  let ServiceMapPanel: any;
  let model: any;
  let calls: { builds: number; throwNext: boolean };
  const opened: [string, string][] = [];
  const revealed: any[] = [];
  const sources: any[] = [];
  let restore: (() => void)[] = [];

  // Modules load after the vscode fake is installed, so they are required here rather than imported.
  /* eslint-disable @typescript-eslint/no-require-imports */
  before(() => {
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    model = require('../../src/views/serviceMapModel');
    const patch = (mod: any, key: string, fn: any) => {
      const orig = mod[key];
      mod[key] = fn;
      restore.push(() => (mod[key] = orig));
    };
    calls = { builds: 0, throwNext: false };
    const realBuild = model.buildServiceMap;
    patch(model, 'buildServiceMap', (...args: unknown[]) => {
      calls.builds++;
      if (calls.throwNext) {
        calls.throwNext = false;
        throw new Error('boom');
      }
      return realBuild(...args);
    });
    patch(require('../../src/views/tracesPanel').TracesPanel, 'show', (_c: unknown, id: string) => opened.push(['traces', id]));
    patch(require('../../src/views/logsPanel').LogsPanel, 'show', (_c: unknown, id: string) => opened.push(['logs', id]));
    patch(require('../../src/views/metricsPanel').MetricsPanel, 'show', (_c: unknown, id: string) => opened.push(['metrics', id]));
    patch(require('../../src/views/navigation'), 'revealTrace', (_c: unknown, args: unknown) => revealed.push(args));
    patch(require('../../src/views/codeNav'), 'openCodeLocation', async (loc: unknown) => {
      sources.push(loc);
    });
    ServiceMapPanel = require('../../src/views/serviceMapPanel').ServiceMapPanel;
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(() => {
    for (const r of restore) r();
    restore = [];
    (Module as any)._load = origLoad;
  });

  afterEach(() => {
    for (const p of panels) p.dispose();
    panels.length = 0;
    opened.length = 0;
    revealed.length = 0;
    sources.length = 0;
    info.length = 0;
    config = {};
    quickPick = () => undefined;
  });

  function open(store: TelemetryStore, realm?: string): FakePanel {
    ServiceMapPanel.show({ store, extensionUri: { fsPath: '/ext' } }, realm);
    return panels[panels.length - 1];
  }

  function liveStore(): TelemetryStore {
    const store = new TelemetryStore();
    addDistributedTrace(store);
    return store;
  }

  it('posts nothing before ready, then one update', () => {
    const store = liveStore();
    const p = open(store);
    assert.ok(p.webview.html.includes('serviceMap.js'));
    assert.strictEqual(p.posted.length, 0);
    p.send({ type: 'ready', range: 'all', selection: null });
    assert.strictEqual(p.posted.length, 1);
    const [u] = p.posted;
    assert.strictEqual(u.type, 'update');
    assert.strictEqual(u.seq, 1);
    assert.strictEqual(u.model.range, 'all');
    assert.strictEqual(u.model.nodes.length, 3);
    assert.strictEqual(u.details, null);
  });

  it('skips identical payloads and ignores invalid messages', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', range: '5m', selection: null });
    p.send({ type: 'setRange', range: '5m' });
    p.send({ type: 'setRange', range: 'forever' });
    p.send({ type: 'select', selection: { kind: 'node', id: 'svc:ghost' } });
    p.send({ type: 'nope' });
    p.send('ready');
    assert.strictEqual(p.posted.length, 1);
    p.send({ type: 'setRange', range: '1h' });
    assert.deepStrictEqual(
      p.updates().map((u) => [u.seq, u.model.range]),
      [
        [1, '5m'],
        [2, '1h'],
      ]
    );
  });

  it('sends details for a selection and drops it when the node disappears', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', range: 'all', selection: { kind: 'node', id: 'svc:gone' } });
    assert.strictEqual(p.posted[0].details, null);
    p.send({ type: 'select', selection: { kind: 'node', id: 'svc:checkout' } });
    const u = p.posted[1];
    assert.deepStrictEqual(u.details.selection, { kind: 'node', id: 'svc:checkout' });
    assert.strictEqual(u.details.slowTraces.length, 1);
  });

  it('throttles store-driven refreshes', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', range: 'all', selection: null });
    addSpans(store, 'worker', [span({ traceId: 'e'.repeat(32), spanId: 'e'.repeat(16) })]);
    await sleep(250); // store fired (150 ms), throttle still holding
    assert.strictEqual(p.posted.length, 1);
    await sleep(400);
    assert.strictEqual(p.posted.length, 2);
    assert.ok(p.posted[1].model.nodes.some((n: any) => n.id === 'svc:worker'));
  });

  it('does no work while hidden and catches up when shown', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', range: 'all', selection: null });
    const builds = calls.builds;
    p.setVisible(false);
    addSpans(store, 'worker', [span({ traceId: 'e'.repeat(32), spanId: 'e'.repeat(16) })]);
    await sleep(250);
    assert.strictEqual(calls.builds, builds, 'no compute while hidden');
    p.setVisible(true);
    await sleep(600);
    assert.strictEqual(calls.builds, builds + 1);
    assert.strictEqual(p.posted.length, 2);
  });

  it('recolours immediately when thresholds change', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', range: 'all', selection: null });
    const health = (u: any) => u.model.nodes.find((n: any) => n.id === 'svc:frontend').health;
    assert.strictEqual(health(p.posted[0]), 'warn');
    config = { 'otel.serviceMap.latencyWarnMs': 5000, 'otel.serviceMap.latencyCriticalMs': 5000 };
    for (const l of [...configListeners]) l({ affectsConfiguration: (s: string) => 'otel.serviceMap.latencyWarnMs'.startsWith(s) });
    assert.strictEqual(health(p.posted[1]), 'ok');
  });

  it('reveals traces and opens sources only for current, in-range indexes', async () => {
    const p = open(liveStore());
    p.send({ type: 'ready', range: 'all', selection: { kind: 'node', id: 'svc:checkout' } });
    const seq = p.posted[0].seq;
    p.send({ type: 'revealTrace', seq: seq - 1, list: 'slow', index: 0 });
    p.send({ type: 'revealTrace', seq, list: 'slow', index: 5 });
    p.send({ type: 'openSource', seq, index: 3 });
    await tick();
    assert.strictEqual(revealed.length, 0);
    assert.strictEqual(sources.length, 0);
    p.send({ type: 'revealTrace', seq, list: 'slow', index: 0 });
    p.send({ type: 'openSource', seq, index: 0 });
    await tick();
    assert.deepStrictEqual(revealed, [
      { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: 'b000000000000001', preferInstanceId: 'checkout::i1' },
    ]);
    assert.strictEqual(sources[0].filepath, '/srv/checkout/orders.py');
  });

  it('opens one instance directly and asks when there are several', async () => {
    const store = liveStore();
    addSpans(store, 'checkout', [span({ traceId: 'c'.repeat(32), spanId: 'c'.repeat(16), kind: 'SERVER' })], 'i2');
    const p = open(store);
    p.send({ type: 'ready', range: 'all', selection: { kind: 'node', id: 'svc:frontend' } });
    p.send({ type: 'open', target: 'logs' });
    await tick();
    assert.deepStrictEqual(opened, [['logs', 'frontend::i1']]);

    p.send({ type: 'select', selection: { kind: 'node', id: 'svc:checkout' } });
    let offered: string[] = [];
    quickPick = (items) => {
      offered = items.map((i) => i.id).sort();
      return items.find((i) => i.id === 'checkout::i2');
    };
    p.send({ type: 'open', target: 'traces' });
    await tick();
    assert.deepStrictEqual(offered, ['checkout::i1', 'checkout::i2']);
    assert.deepStrictEqual(opened[1], ['traces', 'checkout::i2']);

    quickPick = () => undefined;
    p.send({ type: 'open', target: 'metrics' });
    await tick();
    assert.strictEqual(opened.length, 2, 'cancelled pick opens nothing');

    p.send({ type: 'select', selection: { kind: 'node', id: 'db:postgresql:shop' } });
    p.send({ type: 'open', target: 'traces' });
    await tick();
    assert.strictEqual(opened.length, 2, 'dependencies have no instances to open');
  });

  it('posts gone once when its session is removed', async () => {
    const store = new TelemetryStore();
    const { sessionId } = store.importSession({
      sourceLabel: 'old.json',
      traces: [{ resource: { serviceName: 'legacy', attrs: {} }, spans: [span({ traceId: 'a'.repeat(32), spanId: 'a'.repeat(16) })] }],
      logs: [],
      metrics: [],
    });
    const p = open(store, sessionId);
    p.send({ type: 'ready', range: 'all', selection: null });
    assert.deepStrictEqual(
      p.posted[0].model.nodes.map((n: any) => n.id),
      ['svc:legacy']
    );
    store.removeSession(sessionId);
    await sleep(700);
    addDistributedTrace(store);
    await sleep(700);
    assert.deepStrictEqual(
      p.posted.map((m) => m.type),
      ['update', 'gone']
    );
  });

  it('reports build errors without breaking later refreshes', () => {
    const p = open(liveStore());
    calls.throwNext = true;
    p.send({ type: 'ready', range: 'all', selection: null });
    assert.deepStrictEqual(p.posted[0], { type: 'error', message: 'boom' });
    p.send({ type: 'setRange', range: '5m' });
    assert.strictEqual(p.posted[1].type, 'update');
  });

  it('stops refreshing after dispose', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', range: 'all', selection: null });
    addSpans(store, 'worker', [span({ traceId: 'e'.repeat(32), spanId: 'e'.repeat(16) })]);
    await sleep(200);
    p.dispose();
    await sleep(500);
    assert.strictEqual(p.posted.length, 1);
  });

  describe('baseline mode', () => {
    let registry: BaselineRegistry;
    let statuses: any[];
    let sub: { dispose(): void };
    const tidOf = (i: number) => (i + 1).toString(16).padStart(32, '0');

    // `n` checkout traces whose database call takes `dbMs`.
    function tracesStore(n: number, dbMs: number, from = 0): TelemetryStore {
      const store = new TelemetryStore();
      for (let i = 0; i < n; i++) addDistributedTrace(store, tidOf(from + i), T0 + (from + i) * 2000, dbMs + (i % 5));
      return store;
    }

    async function activate(name: string, store: TelemetryStore, realm = 'other'): Promise<string> {
      const snapshot = captureSnapshot(store.getAllTaggedSpans(), { kind: 'session', label: name, realm });
      const { meta } = registry.add(name, snapshot);
      await registry.setActive(meta.id);
      return meta.id;
    }

    const last = (p: FakePanel) => p.updates()[p.updates().length - 1];
    const dbEdge = (u: any) => u.model.edges.find((e: any) => e.target === 'db:postgresql:shop');

    beforeEach(() => {
      const values = new Map<string, unknown>();
      const files = new Map<string, string>();
      registry = new BaselineRegistry(
        { get: (k: string) => values.get(k) as any, update: (k: string, v: unknown) => (values.set(k, v), Promise.resolve()) },
        {
          read: async (id) => files.get(id) ?? Promise.reject(new Error('ENOENT')),
          write: async (id, t) => void files.set(id, t),
          remove: async (id) => void files.delete(id),
        }
      );
      statuses = [];
      sub = ServiceMapPanel.useBaselines({ registry, status: (s: unknown) => statuses.push(s) });
    });

    afterEach(() => sub.dispose());

    it('compares with the active baseline by default and reports to the status bar', async () => {
      await activate('main', tracesStore(30, 100));
      const p = open(tracesStore(30, 800));
      p.send({ type: 'ready', range: 'all', selection: null });
      await tick();
      const u = last(p);
      assert.strictEqual(u.colorMode, 'baseline');
      assert.strictEqual(u.readOnly, false);
      assert.deepStrictEqual([u.baseline.name, u.baseline.waiting, u.baseline.cutoffMs], ['main', false, undefined]);
      assert.strictEqual(dbEdge(u).cmp.verdict, 'regressed');
      assert.ok(u.baseline.summary.regressed > 0);
      assert.deepStrictEqual(statuses[statuses.length - 1], { name: 'main', summary: { regressed: u.baseline.summary.regressed, improved: 0 }, waiting: false });
    });

    it('drops comparison data in absolute mode and keeps the status bar to the name', async () => {
      await activate('main', tracesStore(30, 100));
      const p = open(tracesStore(30, 800));
      p.send({ type: 'ready', range: 'all', selection: null, colorMode: 'absolute' });
      await tick();
      const u = last(p);
      assert.deepStrictEqual([u.colorMode, u.baseline, u.hasBaseline], ['absolute', null, true]);
      assert.strictEqual(dbEdge(u).cmp, undefined);
      assert.deepStrictEqual(statuses[statuses.length - 1], { name: 'main' });
      p.send({ type: 'setColorMode', colorMode: 'baseline' });
      assert.strictEqual(dbEdge(last(p)).cmp.verdict, 'regressed');
    });

    it('rebuilds the compared map for new data but not for a new selection', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bm = require('../../src/views/baselineMap');
      const orig = bm.buildComparedMap;
      let builds = 0;
      bm.buildComparedMap = (...args: unknown[]) => (builds++, orig(...args));
      try {
        await activate('main', tracesStore(30, 100));
        const store = tracesStore(30, 800);
        const p = open(store);
        p.send({ type: 'ready', range: 'all', selection: null });
        await tick();
        const before = builds;
        p.send({ type: 'select', selection: { kind: 'node', id: 'svc:checkout' } });
        p.send({ type: 'select', selection: { kind: 'edge', source: 'svc:checkout', target: 'db:postgresql:shop' } });
        assert.strictEqual(builds, before, 'selection reuses the cached comparison');
        assert.strictEqual(last(p).details.operations[0].cmp.verdict, 'regressed');
        addDistributedTrace(store, 'f'.repeat(32), T0 + 99_000, 800);
        await sleep(700);
        assert.strictEqual(builds, before + 1);
      } finally {
        bm.buildComparedMap = orig;
      }
    });

    it('waits for calls after a cut-off in the same realm', async () => {
      const store = tracesStore(20, 100);
      await activate('mark', store, LIVE_REALM);
      const p = open(store);
      p.send({ type: 'ready', range: 'all', selection: null });
      await tick();
      assert.strictEqual(last(p).baseline.waiting, true);
      assert.ok(last(p).model.cutoffMs > 0);
      assert.deepStrictEqual(statuses[statuses.length - 1], { name: 'mark', summary: undefined, waiting: true });
      for (let i = 0; i < 20; i++) addDistributedTrace(store, tidOf(100 + i), T0 + 100_000 + i * 2000, 800 + (i % 5));
      await sleep(700);
      const u = last(p);
      assert.strictEqual(u.baseline.waiting, false);
      assert.strictEqual(dbEdge(u).cmp.verdict, 'regressed');
      assert.strictEqual(dbEdge(u).stats.count, 20, 'only calls after the cut-off count');
    });

    it('captures up to a sparkline bucket and makes it active', async () => {
      const p = open(tracesStore(30, 100));
      p.send({ type: 'ready', range: 'all', selection: null });
      const { seq, model } = p.posted[0];
      p.send({ type: 'captureAtBucket', seq, index: 30 });
      p.send({ type: 'captureAtBucket', seq: seq + 1, index: 0 });
      await tick();
      assert.strictEqual(registry.list().length, 0, 'invalid captures are ignored');
      p.send({ type: 'captureAtBucket', seq, index: 14 });
      await tick();
      const [meta] = registry.list();
      assert.strictEqual(meta.sourceKind, 'time');
      assert.strictEqual(registry.activeId, meta.id);
      const snap = (await registry.load(meta.id))!.snapshot;
      assert.ok(Math.abs(snap.source.toMs - (model.fromMs + (15 * model.effectiveWindowMs) / 30)) < 1e-6);
    });

    it('reveals baseline example traces still in the store', async () => {
      const store = tracesStore(30, 100);
      await activate('main', store);
      const p = open(store);
      p.send({ type: 'ready', range: 'all', selection: { kind: 'node', id: 'svc:checkout' } });
      await tick();
      const u = last(p);
      assert.ok(u.details.baselineTraces.length > 0);
      p.send({ type: 'revealTrace', seq: u.seq, list: 'baseline', index: 9 });
      p.send({ type: 'revealTrace', seq: u.seq, list: 'baseline', index: 0 });
      await tick();
      assert.deepStrictEqual(revealed, [{ traceId: u.details.baselineTraces[0] }]);
    });

    it('opens a read-only comparison that ignores live-only actions and goes away with its baseline', async () => {
      const a = await activate('before', tracesStore(30, 100));
      const b = await activate('after', tracesStore(30, 800));
      ServiceMapPanel.showComparison({ store: new TelemetryStore(), extensionUri: { fsPath: '/ext' } }, a, b);
      const p = panels[panels.length - 1];
      p.send({ type: 'ready', range: 'all', selection: null });
      await tick();
      const u = last(p);
      assert.deepStrictEqual([u.readOnly, u.baseline.name, u.baseline.against], [true, 'before', 'after']);
      assert.strictEqual(dbEdge(u).cmp.verdict, 'regressed');
      const posted = p.posted.length;
      p.send({ type: 'setRange', range: '5m' });
      p.send({ type: 'captureAtBucket', seq: u.seq, index: 0 });
      assert.strictEqual(p.posted.length, posted);
      await registry.remove(b);
      await tick();
      assert.strictEqual(p.posted[p.posted.length - 1].type, 'gone');
    });

    it('opens the baseline menu with capture actions for live maps', async () => {
      const p = open(tracesStore(5, 100));
      p.send({ type: 'ready', range: 'all', selection: null });
      let labels: string[] = [];
      quickPick = (items) => {
        labels = items.map((i) => i.label);
        return undefined;
      };
      p.send({ type: 'baselineMenu' });
      await tick();
      assert.ok(labels.includes('$(pin) Mark now'), labels.join(' | '));
      assert.ok(labels.includes('$(cloud-download) Import from file…'));
    });

    it('keeps baseline names from rendering as icons in pickers', async () => {
      await activate('$(alert) urgent', tracesStore(5, 100));
      const p = open(tracesStore(5, 100));
      p.send({ type: 'ready', range: 'all', selection: null });
      let descriptions: string[] = [];
      quickPick = (items) => {
        descriptions = items.map((i) => i.description ?? '');
        return undefined;
      };
      p.send({ type: 'baselineMenu' });
      await tick();
      assert.ok(descriptions.includes('Active: $\u200b(alert) urgent'), descriptions.join(' | '));
    });

    it('captures from a recent window and copies a report, from commands without a map', async () => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const actions = require('../../src/views/baselineActions');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const before = tracesStore(30, 100);
      const deps = { controller: { store: before }, registry, openComparison: () => undefined };
      quickPick = (items) => items.find((i) => i.range === 'all');
      await actions.captureWindowFromCommand(deps);
      const [meta] = registry.list();
      assert.deepStrictEqual([meta.sourceKind, registry.activeId], ['window', meta.id]);

      deps.controller.store = tracesStore(30, 800, 100);
      await actions.copyBaselineReport(deps);
      assert.strictEqual(clipboard.length, 1);
      assert.ok(clipboard[0].startsWith('## Service map vs baseline “Window to '), clipboard[0]);
      assert.ok(clipboard[0].includes('| ⬆ | checkout → postgresql: shop |'), clipboard[0]);
      clipboard.length = 0;
    });
  });
});
