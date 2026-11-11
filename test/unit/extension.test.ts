// SPDX-License-Identifier: Apache-2.0
// The extension's command wiring (connect flow, status menu, receiver start errors) against a minimal
// `vscode` fake. Starts the real receiver on random ports.
import * as assert from 'assert';
import Module = require('module');
import * as net from 'net';
import * as path from 'path';

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e?: T) {
    for (const l of [...this.listeners]) l(e as T);
  }
  dispose() {
    this.listeners = [];
  }
}

interface StatusItem {
  priority: number;
  text: string;
  tooltip: unknown;
  command: string;
}

const commands = new Map<string, (...args: any[]) => any>();
const executed: unknown[][] = [];
const statusItems: StatusItem[] = [];
const clipboard: string[] = [];
const terminals: { name: string; env: Record<string, string> }[] = [];
const documents: { content: string; language: string }[] = [];
const config: Record<string, unknown> = { 'otel.port.mode': 'random' };
let treeProvider: any;
let quickPick: (items: any[], options?: any) => any = () => undefined;
let warningPick: string | undefined;
let errorPick: string | undefined;
const errors: string[] = [];

const fakeVscode = {
  EventEmitter,
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
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
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const p = path.join(base.fsPath, ...parts);
      return { fsPath: p, path: p };
    },
    from: (c: { scheme: string; path: string }) => c,
  },
  window: {
    createOutputChannel: () => ({ info() {}, debug() {}, warn() {}, error() {}, trace() {}, appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: (_align: number, priority: number) => {
      const item = { priority, text: '', tooltip: '' as unknown, command: '', show() {}, hide() {}, dispose() {} };
      statusItems.push(item);
      return item;
    },
    createTreeView: (_id: string, options: { treeDataProvider: unknown }) => {
      treeProvider = options.treeDataProvider;
      return { dispose() {} };
    },
    registerFileDecorationProvider: () => ({ dispose() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(warningPick),
    showErrorMessage: (message: string) => {
      errors.push(message);
      return Promise.resolve(errorPick);
    },
    showQuickPick: (items: any[], options?: any) => Promise.resolve(quickPick(items, options)),
    createTerminal: (options: { name: string; env: Record<string, string> }) => {
      terminals.push(options);
      return { show() {} };
    },
    showTextDocument: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: (id: string, cb: (...args: any[]) => any) => {
      commands.set(id, cb);
      return { dispose() {} };
    },
    executeCommand: (...args: unknown[]) => {
      executed.push(args);
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        const full = section ? `${section}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : def;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: (doc: { content: string; language: string }) => {
      documents.push(doc);
      return Promise.resolve(doc);
    },
  },
  debug: { registerDebugConfigurationProvider: () => ({ dispose() {} }) },
  env: {
    clipboard: {
      writeText: (t: string) => {
        clipboard.push(t);
        return Promise.resolve();
      },
    },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (id: string, ...args: unknown[]) => commands.get(id)!(...args);
const ran = (...args: unknown[]) => executed.some((e) => JSON.stringify(e) === JSON.stringify(args));
const statusBar = () => statusItems.find((i) => i.priority === 100)!;
const tooltipText = (t: unknown) => (typeof t === 'string' ? t : (t as { value: string }).value);
const log = (body: string) => ({ timeMs: Date.now(), severityNumber: 9, severityText: 'INFO', body, attrs: {} });

describe('extension commands', function () {
  this.timeout(15_000);
  const origLoad = (Module as any)._load;
  let preloaded: Set<string>;
  let ext: any;
  let tree: any;
  let serviceMapPanel: any;
  let originalShow: unknown;
  const mapsShown: string[] = [];
  let context: { subscriptions: { dispose(): void }[] };

  /* eslint-disable @typescript-eslint/no-require-imports */
  before(async () => {
    preloaded = new Set(Object.keys(require.cache));
    (Module as any)._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return fakeVscode;
      return origLoad.apply(this, [request, ...rest]);
    };
    ext = require('../../src/extension');
    tree = require('../../src/views/instancesTree');
    serviceMapPanel = require('../../src/views/serviceMapPanel');
    originalShow = serviceMapPanel.ServiceMapPanel.show;
    serviceMapPanel.ServiceMapPanel.show = (_c: unknown, realm: string) => mapsShown.push(realm);
    const values = new Map<string, unknown>();
    context = {
      subscriptions: [],
      ...{
        extensionPath: path.resolve(__dirname, '../..'),
        extension: { id: 'SukantaSaha.opentelemetry' },
        workspaceState: { get: (k: string) => values.get(k), update: (k: string, v: unknown) => (values.set(k, v), Promise.resolve()) },
        storageUri: { fsPath: '/tmp/otel-ext-test/ws', path: '/tmp/otel-ext-test/ws' },
        globalStorageUri: { fsPath: '/tmp/otel-ext-test/global', path: '/tmp/otel-ext-test/global' },
      },
    };
    await ext.activate(context);
  });
  /* eslint-enable @typescript-eslint/no-require-imports */

  after(async () => {
    serviceMapPanel.ServiceMapPanel.show = originalShow;
    ext.deactivate();
    for (const d of context.subscriptions) d.dispose();
    await sleep(50);
    (Module as any)._load = origLoad;
    // Modules first loaded here hold this file's vscode fake; later tests must load their own.
    for (const id of Object.keys(require.cache)) if (!preloaded.has(id)) delete require.cache[id];
  });

  beforeEach(() => {
    quickPick = () => undefined;
    warningPick = undefined;
    errorPick = undefined;
  });

  const store = () => treeProvider.controller.store;
  const hasDataValues = () => executed.filter((e) => e[0] === 'setContext' && e[1] === 'otel.hasData').map((e) => e[2]);

  it('sets otel.hasData at activation and only when it flips', async () => {
    assert.deepStrictEqual(hasDataValues(), [false]);
    store().ingestLogs([{ resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} }, logs: [log('a')] }]);
    store().ingestLogs([{ resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} }, logs: [log('b')] }]);
    await sleep(250);
    assert.deepStrictEqual(hasDataValues(), [false, true]);
    store().clear();
    await sleep(250);
    assert.deepStrictEqual(hasDataValues(), [false, true, false]);
  });

  it('opens the quick actions menu from the status bar and runs the picked command', async () => {
    assert.strictEqual(statusBar().command, 'otel.showStatusMenu');
    assert.match(statusBar().text, /off/);
    assert.match(tooltipText(statusBar().tooltip), /Click for actions/);
    let shown: any[] = [];
    quickPick = (items) => {
      shown = items;
      return items.find((i) => i.action === 'otel.start');
    };
    await run('otel.showStatusMenu');
    assert.ok(ran('otel.start'));
    assert.ok(!shown.some((i) => i.action === 'otel.stop'));
    assert.ok(shown.some((i) => i.kind === -1 && i.label === 'Help'), 'separators become QuickPick separators');
    executed.length = 0;
    quickPick = () => undefined;
    await run('otel.showStatusMenu');
    assert.ok(!executed.some((e) => String(e[0]).startsWith('otel.')), 'a dismissed menu runs nothing');
  });

  it('offers to start the receiver before copying environment variables', async () => {
    await run('otel.copyEnvVar');
    assert.strictEqual(clipboard.length, 0, 'nothing copied while stopped');
    warningPick = 'Start Receiver';
    await run('otel.copyEnvVar');
    const copied = clipboard.pop()!;
    assert.match(copied, /OTEL_EXPORTER_OTLP_ENDPOINT/);
    assert.match(copied, /OTEL_LOGS_EXPORTER/);
    assert.match(statusBar().text, /OTel: \d+\/\d+/);
    assert.match(tooltipText(statusBar().tooltip), /Click for actions/);
  });

  it('runs every Connect Your App action', async () => {
    let shown: any[] = [];
    const choose = (action: string) => (quickPick = (items) => ((shown = items), items.find((i: any) => i.action === action)));

    choose('debug');
    await run('otel.connectApp');
    assert.ok(ran('workbench.action.debug.selectandstart'));
    assert.ok(shown.some((i) => i.kind === -1 && i.label === 'Launch from VS Code'));

    choose('terminal');
    await run('otel.connectApp');
    assert.strictEqual(terminals.at(-1)!.env.OTEL_TRACES_EXPORTER, 'otlp');

    choose('copyEnvPosix');
    await run('otel.connectApp');
    assert.match(clipboard.at(-1)!, /^export OTEL_EXPORTER_OTLP_ENDPOINT='http:\/\/127\.0\.0\.1:\d+'/);

    choose('copyEnvPowerShell');
    await run('otel.connectApp');
    assert.match(clipboard.at(-1)!, /^\$env:OTEL_EXPORTER_OTLP_ENDPOINT = /);

    const grpc = shown.find((i) => i.action === 'copyGrpc').description;
    const http = shown.find((i) => i.action === 'copyHttp').description;
    choose('copyGrpc');
    await run('otel.connectApp');
    assert.strictEqual(clipboard.at(-1), grpc);
    choose('copyHttp');
    await run('otel.connectApp');
    assert.strictEqual(clipboard.at(-1), http);

    quickPick = (items) => items.find((i: any) => i.action === 'snippet') ?? items.find((i: any) => i.snippet?.languageId === 'python');
    await run('otel.connectApp');
    assert.strictEqual(documents.at(-1)!.language, 'python');
    assert.ok(documents.at(-1)!.content.includes(grpc));

    const before = clipboard.length;
    quickPick = () => undefined;
    await run('otel.connectApp');
    assert.strictEqual(clipboard.length, before, 'cancelling does nothing');
  });

  it('copies the picked endpoint', async () => {
    quickPick = (items) => items[1];
    await run('otel.copyEndpoint');
    assert.match(clipboard.at(-1)!, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('lists explore and receiver actions while running with data', async () => {
    store().ingestLogs([{ resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} }, logs: [log('c')] }]);
    await sleep(250);
    let shown: any[] = [];
    quickPick = (items) => ((shown = items), undefined);
    await run('otel.showStatusMenu');
    const actions = shown.map((i) => i.action);
    for (const a of ['otel.connectApp', 'otel.openServiceMap', 'otel.openTraces', 'otel.stop', 'otel.restart']) {
      assert.ok(actions.includes(a), a);
    }
    assert.ok(!actions.includes('otel.start'));
  });

  it('opens the walkthrough and the service map for the right realm', async () => {
    await run('otel.openWalkthrough');
    assert.ok(ran('workbench.action.openWalkthrough', 'SukantaSaha.opentelemetry#otel.gettingStarted', false));
    mapsShown.length = 0;
    await run('otel.openServiceMap');
    await run('otel.openServiceMap', new tree.ServiceMapNode('session-1'));
    await run('otel.openServiceMap', new tree.ImportedSessionNode({ session: { id: 'session-2' }, instances: [] }));
    assert.deepStrictEqual(mapsShown, ['live', 'session-1', 'session-2']);
  });

  describe('receiver start errors', () => {
    let blocker: net.Server;
    let port: number;

    before(async () => {
      await run('otel.stop');
      blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
      port = (blocker.address() as net.AddressInfo).port;
      Object.assign(config, { 'otel.port.mode': 'fixed', 'otel.port.grpc': port, 'otel.port.http': port });
    });

    after(async () => {
      Object.assign(config, { 'otel.port.mode': 'random' });
      delete config['otel.port.grpc'];
      delete config['otel.port.http'];
      delete config['otel.host'];
      await run('otel.stop');
      await new Promise((r) => blocker.close(r));
    });

    it('opens the port settings from the port-in-use error', async () => {
      errorPick = 'Open Settings';
      await run('otel.start');
      assert.match(errors.at(-1)!, /is in use/);
      assert.ok(ran('workbench.action.openSettings', 'otel.port'));
      assert.match(statusBar().text, /error/);
      assert.match(tooltipText(statusBar().tooltip), /failed to start.*Click for actions/s);
    });

    it('shows the last start error in the status menu until a start succeeds', async () => {
      await run('otel.start');
      let shown: any[] = [];
      quickPick = (items) => ((shown = items), undefined);
      await run('otel.showStatusMenu');
      assert.match(shown[0].detail, /^Last attempt failed: /);

      errorPick = 'Retry on random ports';
      await run('otel.start');
      assert.match(statusBar().text, /OTel: \d+\/\d+/);
      await run('otel.stop');
      await run('otel.showStatusMenu');
      assert.strictEqual(shown[0].detail, 'Listen for OTLP from your apps.');
    });

    it('offers the settings for any other start failure', async () => {
      Object.assign(config, { 'otel.port.mode': 'random', 'otel.host': '203.0.113.1' });
      errorPick = 'Open Settings';
      await run('otel.start');
      await sleep(20);
      assert.match(errors.at(-1)!, /failed to start receiver/);
      assert.ok(ran('otel.openSettings'));
    });
  });
});
