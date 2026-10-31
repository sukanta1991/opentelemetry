// SPDX-License-Identifier: Apache-2.0
// CardinalityPanel against a minimal `vscode` fake: lifecycle, throttling, hidden panels, message validation,
// details, pricing overrides and baselines. Uses real timers (store debounce 150 ms, throttle 1000 ms).
import * as assert from 'assert';
import Module = require('module');
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { captureSnapshot } from '../../src/views/baseline';
import { BaselineRegistry } from '../../src/views/baselineRegistry';
import { captureCardinality } from '../../src/views/cardinalityBaseline';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';

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
  revealed = 0;
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
  reveal() {
    this.revealed++;
  }
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
  last() {
    return this.posted[this.posted.length - 1];
  }
}

const panels: FakePanel[] = [];
const configListeners: Listener[] = [];
let config: Record<string, unknown> = {};
const commands: unknown[][] = [];

const fakeVscode = {
  ViewColumn: { Active: -1 },
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
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
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
  commands: {
    executeCommand: (...args: unknown[]) => {
      commands.push(args);
      return Promise.resolve(undefined);
    },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

function liveStore(): TelemetryStore {
  const store = new TelemetryStore();
  const users = Array.from({ length: 40 }, (_, i) => span({ ...ids(i), name: 'GET /users/{id}', startMs: T0 + i, attrs: { 'user.id': uuid(i) } }));
  addSpans(store, 'api', users.slice(0, 30), 'i1');
  addSpans(store, 'api', users.slice(30), 'i2');
  addLogs(store, 'worker', [log({ timeMs: T0, body: 'job done' })]);
  return store;
}

function memento() {
  const values = new Map<string, unknown>();
  return { values, get: (k: string) => values.get(k) as any, update: (k: string, v: unknown) => (values.set(k, v), Promise.resolve()) };
}

describe('CardinalityPanel', function () {
  this.timeout(10_000);
  const origLoad = (Module as any)._load;
  let CardinalityPanel: any;
  let calls: { builds: number; throwNext: boolean };
  let restore: (() => void)[] = [];
  let state: ReturnType<typeof memento>;
  let preloaded: Set<string>;

  /* eslint-disable @typescript-eslint/no-require-imports */
  before(() => {
    preloaded = new Set(Object.keys(require.cache));
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    const model = require('../../src/views/cardinalityModel');
    const realBuild = model.buildCardinalityModel;
    calls = { builds: 0, throwNext: false };
    model.buildCardinalityModel = (...args: unknown[]) => {
      calls.builds++;
      if (calls.throwNext) {
        calls.throwNext = false;
        throw new Error('boom');
      }
      return realBuild(...args);
    };
    restore.push(() => (model.buildCardinalityModel = realBuild));
    CardinalityPanel = require('../../src/views/cardinalityPanel').CardinalityPanel;
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(() => {
    for (const r of restore) r();
    restore = [];
    (Module as any)._load = origLoad;
    // Modules first loaded here hold this file's vscode fake; later tests must load their own.
    for (const id of Object.keys(require.cache)) if (!preloaded.has(id)) delete require.cache[id];
  });

  beforeEach(() => {
    state = memento();
  });

  afterEach(() => {
    for (const p of panels) p.dispose();
    panels.length = 0;
    commands.length = 0;
    config = {};
  });

  function open(store: TelemetryStore, deps: Record<string, unknown> = {}, scope?: unknown): FakePanel {
    const before = panels.length;
    CardinalityPanel.show({ store, extensionUri: { fsPath: '/ext' } }, { workspaceState: state, ...deps }, scope);
    return panels.length > before ? panels[panels.length - 1] : panels[0];
  }

  it('posts nothing before ready, then one update for the overview', () => {
    const p = open(liveStore());
    assert.ok(p.webview.html.includes('cardinality.js'));
    assert.ok(p.webview.html.includes("script-src 'nonce-"));
    assert.strictEqual(p.posted.length, 0);
    p.send({ type: 'ready', tab: 'overview' });
    assert.strictEqual(p.posted.length, 1);
    const u = p.posted[0];
    assert.deepStrictEqual([u.type, u.seq, u.tab, u.scope], ['update', 1, 'overview', { realm: LIVE_REALM }]);
    assert.deepStrictEqual(u.options, { realms: [{ id: LIVE_REALM, label: 'Live' }], services: ['api', 'worker'], instances: [] });
    assert.strictEqual(u.summary.totals.traces.count, 40);
    assert.deepStrictEqual(
      u.data.findings.map((f: any) => [f.service, f.key]),
      [['api', 'user.id']]
    );
  });

  it('switches tabs and scopes, skips identical payloads and ignores invalid messages', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', tab: 'attributes' });
    p.send({ type: 'setTab', tab: 'attributes' });
    for (const bad of [
      { type: 'setTab', tab: 'nope' },
      { type: 'setScope', scope: { realm: 'ghost' } },
      { type: 'setScope', scope: { realm: LIVE_REALM, service: 'ghost' } },
      { type: 'setScope', scope: { realm: LIVE_REALM, service: 'api', instanceId: 'api::i1' } },
      { type: 'select', seq: 1, table: 'metrics', index: 0 },
      { type: 'setPricing', overrides: { perGbIngested: -1 } },
      { type: 'nope' },
      'ready',
    ]) {
      p.send(bad);
    }
    assert.strictEqual(p.posted.length, 1);
    assert.ok(p.posted[0].data.keys.length > 0);
    p.send({ type: 'setScope', scope: { realm: LIVE_REALM, service: 'api' } });
    let u = p.last();
    assert.deepStrictEqual([u.seq, u.tab, u.scope], [2, 'attributes', { realm: LIVE_REALM, service: 'api' }]);
    assert.deepStrictEqual(
      u.options.instances.map((i: any) => i.id),
      ['api::i1', 'api::i2']
    );
    p.send({ type: 'setScope', scope: { realm: LIVE_REALM, service: 'api', instanceId: 'api::i2' } });
    u = p.last();
    assert.deepStrictEqual(u.scope, { realm: LIVE_REALM, service: 'api', instanceId: 'api::i2' });
    assert.strictEqual(u.summary.totals.traces.count, 10);
    p.send({ type: 'setTab', tab: 'metrics' });
    assert.deepStrictEqual([p.last().tab, p.last().data.metrics], ['metrics', []]);
  });

  it('answers detail requests for the current update only', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', tab: 'attributes' });
    const u = p.last();
    const index = u.data.keys.findIndex((k: any) => k.key === 'user.id');
    p.send({ type: 'select', seq: u.seq - 1, table: 'keys', index });
    p.send({ type: 'select', seq: u.seq, table: 'keys', index: u.data.keys.length });
    assert.strictEqual(p.posted.length, 1);
    p.send({ type: 'select', seq: u.seq, table: 'keys', index });
    const d = p.last();
    assert.deepStrictEqual([d.type, d.seq, d.table, d.index, d.details.kind], ['details', u.seq, 'keys', index, 'key']);
    assert.strictEqual(d.details.samples.length, 3);
  });

  it('throttles store-driven refreshes to one a second', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', tab: 'overview' });
    addSpans(store, 'batch', [span({ ...ids(500), name: 'run' })]);
    await sleep(500);
    assert.strictEqual(p.posted.length, 1);
    await sleep(800);
    assert.strictEqual(p.posted.length, 2);
    assert.deepStrictEqual(p.last().options.services, ['api', 'batch', 'worker']);
  });

  it('does no work while hidden and catches up when shown', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', tab: 'overview' });
    const builds = calls.builds;
    p.setVisible(false);
    addSpans(store, 'batch', [span({ ...ids(500), name: 'run' })]);
    await sleep(1300);
    assert.strictEqual(calls.builds, builds, 'no compute while hidden');
    p.setVisible(true);
    await sleep(50);
    assert.strictEqual(calls.builds, builds + 1);
    assert.strictEqual(p.posted.length, 2);
  });

  it('reuses the model for tab switches and rebuilds when settings change', () => {
    const p = open(liveStore());
    p.send({ type: 'ready', tab: 'overview' });
    const builds = calls.builds;
    p.send({ type: 'setTab', tab: 'attributes' });
    p.send({ type: 'setTab', tab: 'logs' });
    assert.strictEqual(calls.builds, builds);
    config = { 'otel.cardinality.minDistinct': 10, 'otel.cardinality.minDistinctRatio': 0 };
    for (const l of [...configListeners]) l({ affectsConfiguration: (s: string) => 'otel.cardinality.minDistinct'.startsWith(s) });
    assert.strictEqual(calls.builds, builds + 1);
  });

  it('says when the analyzer is off and recovers when it is back on', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', tab: 'overview' });
    store.setCardinality(false);
    await sleep(1300);
    assert.deepStrictEqual(p.last(), { type: 'disabled' });
    store.setCardinality(true);
    addSpans(store, 'api', [span({ ...ids(900), name: 'GET /' })]);
    await sleep(1300);
    assert.strictEqual(p.last().type, 'update');
    assert.strictEqual(p.last().summary.totals.traces.count, 1, 'counting restarts');
  });

  it('stores pricing overrides per workspace, prices with them and resets', async () => {
    const p = open(liveStore());
    config = { 'otel.cost.perGbIngested': 0.25 };
    p.send({ type: 'ready', tab: 'pricing' });
    let pricing = p.last().data.pricing;
    assert.deepStrictEqual([pricing.source, pricing.effective.perGbIngested, pricing.cost.lines.length], ['settings', 0.25, 1]);
    p.send({ type: 'setPricing', overrides: { perMillionSpans: 2, currency: 'EUR' } });
    await tick();
    assert.deepStrictEqual(state.values.get('otel.cost.overrides'), { perMillionSpans: 2, currency: 'EUR' });
    pricing = p.last().data.pricing;
    assert.deepStrictEqual([pricing.source, pricing.cost.currency, pricing.cost.lines.length], ['workspace', 'EUR', 2]);
    assert.strictEqual(p.last().summary.cost.currency, 'EUR');
    p.send({ type: 'resetPricing' });
    await tick();
    assert.strictEqual(state.values.get('otel.cost.overrides'), undefined);
    assert.strictEqual(p.last().data.pricing.source, 'settings');
    state.values.set('otel.cost.overrides', { perGbIngested: 'lots', __proto__: { polluted: true } });
    p.send({ type: 'setTab', tab: 'overview' });
    p.send({ type: 'setTab', tab: 'pricing' });
    assert.deepStrictEqual([p.last().data.pricing.source, p.last().data.pricing.overrides], ['settings', {}], 'corrupt state falls back to settings');
    p.send({ type: 'openSettings', section: 'cost' });
    await tick();
    assert.deepStrictEqual(commands, [['workbench.action.openSettings', 'otel.cost']]);
  });

  it('falls back to live data when its session is unloaded', async () => {
    const store = liveStore();
    const { sessionId } = store.importSession({
      sourceLabel: 'old.json',
      traces: [{ resource: { serviceName: 'legacy', attrs: {} }, spans: [span({ ...ids(700), name: 'x' })] }],
      logs: [],
      metrics: [],
    });
    const p = open(store, {}, { realm: sessionId });
    p.send({ type: 'ready', tab: 'overview' });
    assert.deepStrictEqual([p.last().scope, p.last().options.services], [{ realm: sessionId }, ['legacy']]);
    assert.deepStrictEqual(
      p.last().options.realms.map((r: any) => r.label),
      ['Live', 'old.json']
    );
    store.removeSession(sessionId);
    await sleep(1300);
    assert.deepStrictEqual(p.last().scope, { realm: LIVE_REALM });
  });

  it('is a singleton that switches scope when shown again', () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', tab: 'overview' });
    const again = open(store, {}, { realm: LIVE_REALM, service: 'worker' });
    assert.strictEqual(again, p);
    assert.strictEqual(panels.length, 1);
    assert.strictEqual(p.revealed, 1);
    assert.deepStrictEqual(p.last().scope, { realm: LIVE_REALM, service: 'worker' });
  });

  it('reports build errors without breaking later refreshes', () => {
    const p = open(liveStore());
    calls.throwNext = true;
    p.send({ type: 'ready', tab: 'overview' });
    assert.deepStrictEqual(p.posted[0], { type: 'error', message: 'boom' });
    p.send({ type: 'setTab', tab: 'logs' });
    assert.strictEqual(p.last().type, 'update');
  });

  it('stops refreshing after dispose and opens a new panel afterwards', async () => {
    const store = liveStore();
    const p = open(store);
    p.send({ type: 'ready', tab: 'overview' });
    p.dispose();
    addSpans(store, 'batch', [span({ ...ids(500), name: 'run' })]);
    await sleep(1300);
    assert.strictEqual(p.posted.length, 1);
    const q = open(store);
    assert.notStrictEqual(q, p);
  });

  describe('baseline tab', () => {
    let registry: BaselineRegistry;

    beforeEach(() => {
      const files = new Map<string, string>();
      registry = new BaselineRegistry(memento(), {
        read: async (id) => files.get(id) ?? Promise.reject(new Error('ENOENT')),
        write: async (id, t) => void files.set(id, t),
        remove: async (id) => void files.delete(id),
      });
    });

    async function activate(store: TelemetryStore, withSummary: boolean): Promise<void> {
      const snapshot = captureSnapshot(store.getAllTaggedSpans(), { kind: 'mark', label: 'live', realm: LIVE_REALM });
      if (withSummary) snapshot.cardinality = captureCardinality(store.getAllInstances(), { realm: LIVE_REALM });
      const { meta } = registry.add('main', snapshot);
      await registry.setActive(meta.id);
    }

    it('shows none, then follows the active baseline', async () => {
      const store = liveStore();
      const p = open(store, { registry });
      p.send({ type: 'ready', tab: 'baseline' });
      assert.deepStrictEqual(p.last().data.baseline, { state: 'none' });
      await activate(liveStore(), false);
      await tick();
      assert.deepStrictEqual(p.last().data.baseline, { state: 'noSummary', name: 'main' });
      await activate(liveStore(), true);
      await tick();
      const b = p.last().data.baseline;
      assert.deepStrictEqual([b.state, b.name, b.changes.length], ['ready', 'main', 0]);
    });

    it('reports new high-cardinality keys against the baseline', async () => {
      await activate(liveStore(), true);
      const store = liveStore();
      addSpans(store, 'api', Array.from({ length: 200 }, (_, i) => span({ ...ids(1000 + i), name: 'GET /', attrs: { cart: `c${i}` } })));
      const p = open(store, { registry });
      p.send({ type: 'ready', tab: 'baseline' });
      await tick();
      const b = p.last().data.baseline;
      assert.deepStrictEqual(
        b.changes.map((c: any) => [c.verdict, c.service, c.key]),
        [['new', 'api', 'cart']]
      );
    });
  });
});
