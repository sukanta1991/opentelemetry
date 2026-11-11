// SPDX-License-Identifier: Apache-2.0
// InstancesTreeProvider against a minimal `vscode` fake: Service Map rows, signal rows and node identity.
import * as assert from 'assert';
import Module = require('module');
import { LogRecord, Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';

class EventEmitter<T> {
  fired: (T | undefined)[] = [];
  event = () => ({ dispose() {} });
  fire(e?: T) {
    this.fired.push(e);
  }
  dispose() {}
}

const fakeVscode = {
  EventEmitter,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    id?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: any;
    command?: any;
    contextValue?: string;
    constructor(
      public label: string,
      public collapsibleState: number
    ) {}
  },
  ThemeIcon: class {
    constructor(
      public id: string,
      public color?: { id: string }
    ) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  MarkdownString: class {
    constructor(public value = '') {}
  },
};

const log = (body: string): LogRecord => ({ timeMs: 1000, severityNumber: 9, severityText: 'INFO', body, attrs: {} });
const span = (spanId: string): Span => ({
  traceId: spanId.repeat(2),
  spanId,
  name: 'GET /',
  kind: 'SERVER',
  startMs: 0,
  endMs: 1,
  durationMs: 1,
  statusCode: 'UNSET',
  attrs: {},
  events: [],
  links: [],
});
const resource = (serviceName: string, serviceInstanceId: string) => ({ serviceName, serviceInstanceId, attrs: {} });

describe('InstancesTreeProvider', () => {
  const origLoad = (Module as any)._load;
  let loaded: string[] = [];
  let tree: any;
  let mod: any;
  let store: TelemetryStore;
  let sessionId: string;

  /* eslint-disable @typescript-eslint/no-require-imports */
  before(() => {
    const before = new Set(Object.keys(require.cache));
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    mod = require('../../src/views/instancesTree');
    loaded = Object.keys(require.cache).filter((k) => !before.has(k));
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(() => {
    (Module as any)._load = origLoad;
    for (const k of loaded) delete require.cache[k];
  });

  beforeEach(() => {
    store = new TelemetryStore();
    store.ingestSpans([{ resource: resource('api', 'a1'), spans: [span('1111111111111111')] }]);
    store.ingestLogs([{ resource: resource('api', 'a1'), logs: [log('x'), log('y')] }]);
    store.ingestLogs([{ resource: resource('worker', 'w1'), logs: [log('x')] }]);
    store.ingestLogs([{ resource: resource('worker', 'w2'), logs: [log('x')] }]);
    sessionId = store.importSession({
      sourceLabel: 'run.otel.json',
      traces: [],
      logs: [
        { resource: resource('svc-a', 'p1'), logs: [log('a')] },
        { resource: resource('svc-b', 'p2'), logs: [log('b')] },
      ],
      metrics: [],
    }).sessionId;
    const controller = { store, onDidChangeState: () => ({ dispose() {} }) };
    tree = new mod.InstancesTreeProvider(controller);
  });

  afterEach(() => tree.dispose());

  const live = () => tree.getChildren().filter((n: any) => n.kind === 'app');
  const instancesOf = (app: any) => tree.getChildren(app);

  it('puts a live Service Map row first', () => {
    const root = tree.getChildren();
    assert.deepStrictEqual(
      root.map((n: any) => n.kind),
      ['serviceMap', 'app', 'app', 'imported']
    );
    const item = tree.getTreeItem(root[0]);
    assert.strictEqual(item.label, 'Service Map');
    assert.strictEqual(item.description, '2 services');
    assert.strictEqual(item.command.command, 'otel.openServiceMap');
    assert.strictEqual(item.command.arguments[0], root[0]);
    assert.strictEqual(root[0].realm, 'live');
  });

  it('has no Service Map row without live apps', () => {
    const empty = new mod.InstancesTreeProvider({ store: new TelemetryStore(), onDidChangeState: () => ({ dispose() {} }) });
    assert.deepStrictEqual(empty.getChildren(), []);
    empty.dispose();
  });

  it('starts every instance collapsed and drops the click action', () => {
    const [api, worker] = live();
    for (const inst of [...instancesOf(api), ...instancesOf(worker)]) {
      const item = tree.getTreeItem(inst);
      assert.strictEqual(item.collapsibleState, fakeVscode.TreeItemCollapsibleState.Collapsed);
      assert.strictEqual(item.command, undefined);
    }
  });

  it('lists Traces, Logs and Metrics under an instance', () => {
    const [a1] = instancesOf(live()[0]);
    const rows = tree.getChildren(a1);
    const items = rows.map((r: any) => tree.getTreeItem(r));
    assert.deepStrictEqual(
      items.map((i: any) => [i.label, i.description, i.command.command, i.id]),
      [
        ['Traces', '1', 'otel.openTraces', 'api::a1::signal::traces'],
        ['Logs', '2', 'otel.openLogs', 'api::a1::signal::logs'],
        ['Metrics', 'none yet', 'otel.openMetrics', 'api::a1::signal::metrics'],
      ]
    );
    for (const i of items) assert.strictEqual(i.command.arguments[0], a1, 'opens with the instance node');
    assert.strictEqual(items[0].iconPath.color, undefined);
    assert.strictEqual(items[2].iconPath.color.id, 'disabledForeground');
    assert.deepStrictEqual(tree.getChildren(rows[0]), []);
  });

  it('reuses signal nodes across refreshes and shows new counts', () => {
    const [a1] = instancesOf(live()[0]);
    const first = tree.getChildren(a1);
    store.ingestLogs([{ resource: resource('api', 'a1'), logs: [log('z')] }]);
    tree.refresh();
    const [api] = live();
    const [again] = instancesOf(api);
    assert.strictEqual(again, a1);
    const second = tree.getChildren(again);
    assert.deepStrictEqual(second, first);
    second.forEach((n: any, i: number) => assert.strictEqual(n, first[i]));
    assert.strictEqual(tree.getTreeItem(second[1]).description, '3');
  });

  it('drops cached nodes of removed instances', () => {
    const [a1] = instancesOf(live()[0]);
    const [traces] = tree.getChildren(a1);
    store.removeInstance('api::a1');
    store.ingestLogs([{ resource: resource('api', 'a1'), logs: [log('again')] }]);
    tree.refresh();
    const [fresh] = instancesOf(live()[0]);
    assert.notStrictEqual(fresh, a1);
    assert.notStrictEqual(tree.getChildren(fresh)[0], traces);
  });

  it('adds a Service Map row to loaded files with several services', () => {
    const [imported] = tree.getChildren().filter((n: any) => n.kind === 'imported');
    const [session] = tree.getChildren(imported);
    const children = tree.getChildren(session);
    assert.deepStrictEqual(
      children.map((n: any) => n.kind),
      ['serviceMap', 'importedService', 'importedService']
    );
    assert.strictEqual(children[0].realm, sessionId);
    const item = tree.getTreeItem(children[0]);
    assert.strictEqual(item.description, '2 services');
    assert.strictEqual(item.id, `serviceMap::${sessionId}`);
    const [inst] = tree.getChildren(children[1]);
    assert.strictEqual(tree.getTreeItem(inst).collapsibleState, fakeVscode.TreeItemCollapsibleState.Collapsed);
    const signals = tree.getChildren(inst).map((n: any) => tree.getTreeItem(n).description);
    assert.deepStrictEqual(signals, ['none', '1', 'none']);
  });
});
