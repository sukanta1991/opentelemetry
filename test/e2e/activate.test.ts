// Activation integration test: loads the real bundled dist/extension.js against a
// lightweight `vscode` API shim and asserts the extension wires up and starts the
// receiver. Run with: npx ts-node test/e2e/activate.test.ts
import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

const registeredCommands = new Map<string, (...args: any[]) => any>();
const executeLog: any[][] = [];
let statusText = '';
let treeViewId = '';
let debugProviderType = '';

class EventEmitter<T> {
  private listeners: ((e: T) => any)[] = [];
  event = (l: (e: T) => any) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e?: T) {
    for (const l of this.listeners) l(e as T);
  }
  dispose() {}
}

const fakeVscode: any = {
  EventEmitter,
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  MarkdownString: class {
    value = '';
    constructor(v?: string) {
      this.value = v ?? '';
    }
  },
  TreeItem: class {
    constructor(public label: any, public collapsibleState?: any) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
  window: {
    createStatusBarItem: () => ({
      show() {},
      dispose() {},
      set text(v: string) {
        statusText = v;
      },
      get text() {
        return statusText;
      },
      tooltip: '',
      command: '',
      backgroundColor: undefined,
    }),
    createTreeView: (id: string) => {
      treeViewId = id;
      return { dispose() {} };
    },
    createWebviewPanel: () => ({
      webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }), postMessage: () => {}, cspSource: '' },
      onDidDispose: () => ({ dispose() {} }),
      reveal() {},
      dispose() {},
    }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    createTerminal: () => ({ show() {} }),
  },
  commands: {
    registerCommand: (id: string, cb: any) => {
      registeredCommands.set(id, cb);
      return { dispose() {} };
    },
    executeCommand: (...args: any[]) => {
      executeLog.push(args);
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: any) => {
        // Use random ports to avoid conflicts during the test.
        if (key === 'port.mode') return 'random';
        if (key === 'launchOnStartup') return true;
        return def;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: () => Promise.resolve({}),
    findFiles: () => Promise.resolve([]),
    fs: { stat: () => Promise.resolve({}) },
  },
  debug: {
    registerDebugConfigurationProvider: (type: string) => {
      debugProviderType = type;
      return { dispose() {} };
    },
  },
  env: { clipboard: { writeText: () => Promise.resolve() } },
};

// Intercept require('vscode').
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.apply(this, [request, ...rest]);
};

async function main() {
  const extPath = path.resolve(__dirname, '../..');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ext = require(path.join(extPath, 'dist', 'extension.js'));

  const context = { extensionPath: extPath, subscriptions: [] as any[] };
  await ext.activate(context);

  // Commands registered
  for (const cmd of [
    'otel.start',
    'otel.stop',
    'otel.restart',
    'otel.clear',
    'otel.copyEndpoint',
    'otel.copyEnvVar',
    'otel.openLogs',
    'otel.openTraces',
    'otel.openMetrics',
    'otel.openServiceMap',
    'otel.removeInstance',
    'otel.showSnippets',
    'otel.openTerminalWithEnv',
  ]) {
    assert.ok(registeredCommands.has(cmd), `command registered: ${cmd}`);
  }

  assert.strictEqual(treeViewId, 'otel.instances', 'tree view created');
  assert.strictEqual(debugProviderType, '*', 'debug provider registered');

  // launchOnStartup => receiver started => setContext otel.running true
  const runningSet = executeLog.find(
    (a) => a[0] === 'setContext' && a[1] === 'otel.running' && a[2] === true
  );
  assert.ok(runningSet, 'receiver started and set otel.running context');

  // subscriptions collected
  assert.ok(context.subscriptions.length > 5, 'disposables registered');

  ext.deactivate();
  console.log('ACTIVATION OK');
  // Give the receiver a moment to shut down, then exit.
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error('ACTIVATION FAILED', e);
  process.exit(1);
});
