// SPDX-License-Identifier: Apache-2.0
// Tree badges, item tooltips, the view's scope mapping and the status bar item against a minimal `vscode` fake.
import * as assert from 'assert';
import Module = require('module');
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { CardinalityEvaluator, instanceKey, serviceKey } from '../../src/views/cardinalityEvaluator';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { T0, addSpans, span } from './aiFixtures';

class EventEmitter<T> {
  listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of [...this.listeners]) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

class Uri {
  constructor(
    readonly scheme: string,
    readonly path: string
  ) {}
  static from(c: { scheme: string; path: string }) {
    return new Uri(c.scheme, c.path);
  }
}

const statusItems: any[] = [];
const fakeVscode = {
  EventEmitter,
  Uri,
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  FileDecoration: class {
    constructor(
      public badge?: string,
      public tooltip?: string,
      public color?: { id: string }
    ) {}
  },
  MarkdownString: class {
    constructor(public value = '') {}
  },
  TreeItem: class {
    constructor(
      public label: string,
      public collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: (_align: number, priority: number) => {
      const item = { priority, text: '', tooltip: '', command: '', visible: false, show() {
        this.visible = true;
      }, hide() {
        this.visible = false;
      }, dispose() {} };
      statusItems.push(item);
      return item;
    },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

describe('cardinality surfaces', function () {
  this.timeout(10_000);
  const origLoad = (Module as any)._load;
  let preloaded: Set<string>;
  let deco: any;
  let tree: any;
  let status: any;

  /* eslint-disable @typescript-eslint/no-require-imports */
  before(() => {
    preloaded = new Set(Object.keys(require.cache));
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    deco = require('../../src/views/cardinalityDecorations');
    tree = require('../../src/views/instancesTree');
    status = require('../../src/status');
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(() => {
    (Module as any)._load = origLoad;
    // Modules first loaded here hold this file's vscode fake; later tests must load their own.
    for (const id of Object.keys(require.cache)) if (!preloaded.has(id)) delete require.cache[id];
  });

  function setup() {
    const store = new TelemetryStore();
    const name = 'api [x](command:otel.clear)';
    addSpans(store, name, Array.from({ length: 30 }, (_, i) => span({ ...ids(i), name: 'GET', startMs: T0 + i, attrs: { 'user.id': uuid(i) } })));
    addSpans(store, 'quiet', [span({ ...ids(500), name: 'GET' })]);
    const evaluator = new CardinalityEvaluator(store, () => DEFAULT_CARDINALITY_SETTINGS, { intervalMs: 10 });
    const controller = { store, onDidChangeState: () => ({ dispose() {} }) };
    const provider = new tree.InstancesTreeProvider(controller, evaluator);
    return { store, name, evaluator, provider };
  }

  it('decorates noisy services and instances once evaluated, and only those', async () => {
    const { name, evaluator, provider } = setup();
    const decorations = new deco.CardinalityDecorations(evaluator);
    const fired: any[][] = [];
    decorations.onDidChangeFileDecorations((uris: any[]) => fired.push(uris));
    const key = serviceKey(LIVE_REALM, name);
    assert.strictEqual(decorations.provideFileDecoration(deco.cardinalityUri(key)), undefined, 'nothing before evaluation');
    await sleep(200);
    assert.strictEqual(fired.length, 1);
    assert.deepStrictEqual(
      fired[0].map((u) => decodeURIComponent(u.path.slice(1))).sort(),
      [key, instanceKey(`${name}::i1`)].sort()
    );
    const d = decorations.provideFileDecoration(deco.cardinalityUri(key));
    assert.deepStrictEqual([d.badge, d.tooltip, d.color.id], ['1', 'Cardinality: 1 warning finding', 'list.warningForeground']);
    assert.strictEqual(decorations.provideFileDecoration(deco.cardinalityUri(serviceKey(LIVE_REALM, 'quiet'))), undefined);
    assert.strictEqual(decorations.provideFileDecoration(new Uri('file', `/${encodeURIComponent(key)}`)), undefined, 'other schemes');
    assert.strictEqual(decorations.provideFileDecoration(new Uri('otel-card', '/%E0%A4%A')), undefined, 'malformed path');

    const [app] = provider.getChildren();
    const item = provider.getTreeItem(app);
    assert.strictEqual(item.resourceUri.scheme, 'otel-card');
    assert.ok(item.tooltip.value.includes('**Cardinality:** 0 critical, 1 warning'), item.tooltip.value);
    assert.ok(!item.tooltip.value.includes('](command:'), 'names in tooltips are escaped');
    const quietItem = provider.getTreeItem(provider.getChildren()[1]);
    assert.strictEqual(quietItem.tooltip, undefined);
    const inst = provider.getTreeItem(provider.getChildren(app)[0]);
    assert.ok(inst.tooltip.value.startsWith('**api'), 'instance tooltips keep their own text first');
    assert.ok(inst.tooltip.value.includes('**Cardinality:**'));
    decorations.dispose();
    evaluator.dispose();
    provider.dispose();
  });

  it('refreshes only the tree items whose findings changed', async () => {
    const { store, name, evaluator, provider } = setup();
    const [app] = provider.getChildren();
    provider.getChildren(app);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((e: unknown) => fired.push(e));
    await sleep(200);
    const refreshed = fired.find(Array.isArray) as any[];
    assert.ok(refreshed, 'a targeted refresh');
    assert.deepStrictEqual(refreshed.map((n) => (n.kind === 'app' ? n.app.name : n.instance.id)).sort(), [name, `${name}::i1`].sort());
    store.setCardinality(false);
    await sleep(200);
    assert.strictEqual(evaluator.current.nodes.size, 0);
    assert.strictEqual(provider.getTreeItem(app).tooltip, undefined, 'tooltips drop findings when the analyzer is off');
    evaluator.dispose();
    provider.dispose();
  });

  it('maps tree nodes to panel scopes', () => {
    const store = new TelemetryStore();
    addSpans(store, 'api', [span({ ...ids(1), name: 'GET' })]);
    const { sessionId } = store.importSession({
      sourceLabel: 'old.json',
      traces: [
        { resource: { serviceName: 'a', attrs: {} }, spans: [span({ ...ids(2), name: 'x' })] },
        { resource: { serviceName: 'b', attrs: {} }, spans: [span({ ...ids(3), name: 'y' })] },
      ],
      logs: [],
      metrics: [],
    });
    const provider = new tree.InstancesTreeProvider({ store, onDidChangeState: () => ({ dispose() {} }) });
    const [app, imported] = provider.getChildren();
    const [session] = provider.getChildren(imported);
    const [service] = provider.getChildren(session);
    const [inst] = provider.getChildren(service);
    assert.deepStrictEqual(tree.cardinalityScopeOf(app), { realm: LIVE_REALM, service: 'api' });
    assert.deepStrictEqual(tree.cardinalityScopeOf(provider.getChildren(app)[0]), { realm: LIVE_REALM, service: 'api', instanceId: 'api::i1' });
    assert.deepStrictEqual(tree.cardinalityScopeOf(session), { realm: sessionId });
    assert.deepStrictEqual(tree.cardinalityScopeOf(service), { realm: sessionId, service: 'a' });
    assert.deepStrictEqual(tree.cardinalityScopeOf(inst), { realm: sessionId, service: 'a', instanceId: inst.instance.id });
    for (const other of [imported, undefined, { app: { name: 'x' } }]) assert.strictEqual(tree.cardinalityScopeOf(other), undefined);
    assert.strictEqual(provider.getTreeItem(app).resourceUri, undefined, 'no decoration hook without an evaluator');
    provider.dispose();
  });

  it('shows the status bar item only for noisy live services', () => {
    const s = new status.CardinalityStatus();
    const item = statusItems[statusItems.length - 1];
    assert.deepStrictEqual([item.priority, item.command, item.visible], [98, 'otel.openCardinality', false]);
    s.update({ noisyServices: 2, findings: { critical: 1, warning: 3, info: 0 }, services: ['api', 'web'] });
    assert.deepStrictEqual([item.text, item.visible], ['$(flame) 2', true]);
    assert.strictEqual(item.tooltip, '2 live services may drive up telemetry cost (1 critical, 3 warning findings): api, web. Click to open the cardinality analyzer.');
    s.update({ noisyServices: 7, findings: { critical: 0, warning: 7, info: 0 }, services: ['a', 'b', 'c', 'd', 'e'] });
    assert.ok(item.tooltip.includes(': a, b, c, d, e, ….'), item.tooltip);
    s.update({ noisyServices: 0, findings: { critical: 0, warning: 0, info: 2 }, services: [] });
    assert.strictEqual(item.visible, false);
    s.update(undefined);
    assert.strictEqual(item.visible, false);
  });
});
