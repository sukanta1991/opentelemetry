// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { connectItems, envBlock, envLine, otlpEnv, statusMenuItems } from '../../src/integration/connectApp';
import { SNIPPETS } from '../../src/integration/snippets';

const endpoints = {
  host: '127.0.0.1',
  grpcPort: 4317,
  httpPort: 4318,
  grpcEndpoint: 'http://127.0.0.1:4317',
  httpEndpoint: 'http://127.0.0.1:4318',
};

describe('connectApp', () => {
  it('otlpEnv sets endpoint, protocol and all three exporters', () => {
    assert.deepStrictEqual(otlpEnv('http://h:1'), {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://h:1',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
    });
  });

  it('envBlock renders one line per variable for each shell', () => {
    const env = { A: 'x', B: 'y' };
    assert.strictEqual(envBlock(env, 'posix'), "export A='x'\nexport B='y'");
    assert.strictEqual(envBlock(env, 'powershell'), "$env:A = 'x'\n$env:B = 'y'");
  });

  it('envLine keeps quotes and shell syntax in values literal', () => {
    assert.strictEqual(envLine('A', "a'b $(rm) `x`", 'posix'), "export A='a'\\''b $(rm) `x`'");
    assert.strictEqual(envLine('A', "a'b $(rm) `x`", 'powershell'), "$env:A = 'a''b $(rm) `x`'");
  });

  it('lists launch options before manual ones, with separators', () => {
    const items = connectItems({ endpoints, overwriteEnvVars: true, windows: false });
    assert.deepStrictEqual(
      items.map((i) => (i.separator ? `-- ${i.label}` : i.action)),
      ['-- Launch from VS Code', 'debug', 'terminal', '-- Configure manually', 'copyEnvPosix', 'copyEnvPowerShell', 'copyGrpc', 'copyHttp', 'snippet']
    );
    for (const i of items) if (i.separator) assert.strictEqual(i.action, undefined);
  });

  it('shows the endpoints next to the copy items', () => {
    const items = connectItems({ endpoints, overwriteEnvVars: true, windows: false });
    assert.strictEqual(items.find((i) => i.action === 'copyGrpc')?.description, endpoints.grpcEndpoint);
    assert.strictEqual(items.find((i) => i.action === 'copyHttp')?.description, endpoints.httpEndpoint);
  });

  it('lists PowerShell first on Windows', () => {
    const actions = connectItems({ endpoints, overwriteEnvVars: true, windows: true }).map((i) => i.action);
    assert.ok(actions.indexOf('copyEnvPowerShell') < actions.indexOf('copyEnvPosix'));
  });

  it('explains when automatic injection for F5 is off', () => {
    const on = connectItems({ endpoints, overwriteEnvVars: true, windows: false }).find((i) => i.action === 'debug');
    const off = connectItems({ endpoints, overwriteEnvVars: false, windows: false }).find((i) => i.action === 'debug');
    assert.match(on!.detail!, /automatically/);
    assert.match(off!.detail!, /otel\.overwriteEnvVars/);
  });
});

describe('statusMenuItems', () => {
  const actions = (o: Parameters<typeof statusMenuItems>[0]) =>
    statusMenuItems(o).map((i) => (i.separator ? `-- ${i.label}` : i.action));

  it('offers start, connect and load when stopped without data', () => {
    assert.deepStrictEqual(actions({ running: false, hasData: false }), [
      'otel.start',
      'otel.connectApp',
      'otel.loadSession',
      '-- Help',
      'otel.openWalkthrough',
      'otel.openSettings',
    ]);
  });

  it('never offers stop unless running, and puts it under Receiver', () => {
    assert.ok(!actions({ running: false, hasData: true }).includes('otel.stop'));
    assert.deepStrictEqual(actions({ running: true, hasData: false }), [
      'otel.connectApp',
      '-- Receiver',
      'otel.copyEndpoint',
      'otel.restart',
      'otel.stop',
      '-- Help',
      'otel.openWalkthrough',
      'otel.openSettings',
    ]);
  });

  it('adds explore actions once data exists, also when stopped', () => {
    for (const running of [true, false]) {
      const list = actions({ running, hasData: true });
      const start = list.indexOf('-- Explore');
      assert.deepStrictEqual(list.slice(start + 1, start + 6), [
        'otel.openServiceMap',
        'otel.openTraces',
        'otel.openLogs',
        'otel.openMetrics',
        'otel.findTrace',
      ]);
    }
  });

  it('shows the last start error on the start item', () => {
    const [start] = statusMenuItems({ running: false, hasData: false, startError: 'EADDRINUSE 4317' });
    assert.strictEqual(start.action, 'otel.start');
    assert.match(start.detail!, /Last attempt failed: EADDRINUSE 4317/);
  });

  it('has no duplicate actions', () => {
    for (const running of [true, false]) {
      for (const hasData of [true, false]) {
        const list = actions({ running, hasData, startError: running ? undefined : 'x' }).filter((a) => !a!.startsWith('--'));
        assert.strictEqual(new Set(list).size, list.length);
      }
    }
  });
});

describe('snippets', () => {
  it('every snippet has a language id and uses the endpoint', () => {
    const ep = 'http://example.test:4317';
    for (const s of SNIPPETS) {
      assert.ok(s.languageId, `${s.title} has a languageId`);
      assert.ok(s.code(ep).includes(ep), `${s.title} uses the endpoint`);
    }
  });

  it('environment snippets enable all three exporters in both shells', () => {
    const env = SNIPPETS.filter((s) => s.language === 'Environment variables');
    assert.deepStrictEqual(env.map((s) => s.languageId), ['shellscript', 'powershell']);
    for (const s of env) {
      const code = s.code('http://h:1');
      for (const name of ['OTEL_TRACES_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_SERVICE_NAME']) {
        assert.ok(code.includes(name), `${s.title} sets ${name}`);
      }
    }
  });
});
