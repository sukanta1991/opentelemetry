// SPDX-License-Identifier: Apache-2.0
// ServiceMapPanel against a minimal `vscode` fake: refresh throttling, hidden panels, de-duplication,
// message validation, actions and lifecycle. Uses real timers (store debounce 150 ms, throttle 500 ms).
import * as assert from 'assert';
import Module = require('module');
import { TelemetryStore } from '../../src/store/store';
import { addDistributedTrace, addSpans, span } from './aiFixtures';

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
    showQuickPick: (items: any[]) => Promise.resolve(quickPick(items)),
  },
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
};

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
  /* eslint-disable @typescript-eslint/no-var-requires */
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
  /* eslint-enable @typescript-eslint/no-var-requires */

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
});
