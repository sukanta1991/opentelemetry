// End-to-end smoke test for the OTLP receiver: sends OTLP over HTTP (protobuf + JSON)
// and gRPC, then asserts the telemetry store is populated. Run with: npx ts-node
import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Receiver } from '../../src/receiver/receiver';
import { loadRequestTypes } from '../../src/receiver/httpServer';
import { TelemetryStore } from '../../src/store/store';

const PROTO_ROOT = path.join(__dirname, '..', '..', 'proto');

function kv(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function post(url: string, body: Buffer, contentType: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': body.length },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode || 0));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const store = new TelemetryStore();
  const receiver = new Receiver(PROTO_ROOT, store);
  const ep = await receiver.start({
    host: '127.0.0.1',
    portMode: 'random',
    grpcPort: 0,
    httpPort: 0,
  });
  console.log('receiver up:', ep.grpcEndpoint, ep.httpEndpoint);

  const types = await loadRequestTypes(PROTO_ROOT);

  // 1) HTTP protobuf: traces
  const traceReq = {
    resourceSpans: [
      {
        resource: {
          attributes: [kv('service.name', 'svc-http'), kv('service.instance.id', 'inst-http')],
        },
        scopeSpans: [
          {
            scope: { name: 'test' },
            spans: [
              {
                traceId: Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex'),
                spanId: Buffer.from('b7ad6b7169203331', 'hex'),
                name: 'GET /',
                kind: 2,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000005000000',
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
  const traceBuf = Buffer.from(types.traces.encode(types.traces.create(traceReq)).finish());
  const s1 = await post(`${ep.httpEndpoint}/v1/traces`, traceBuf, 'application/x-protobuf');
  assert.strictEqual(s1, 200, 'HTTP traces status');

  // 2) HTTP JSON: logs (OTLP/JSON style)
  const logsJson = {
    resourceLogs: [
      {
        resource: { attributes: [kv('service.name', 'svc-json')] },
        scopeLogs: [
          {
            scope: { name: 'test' },
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                severityNumber: 9,
                severityText: 'INFO',
                body: { stringValue: 'hello from json' },
                attributes: [kv('code.filepath', '/app/main.ts')],
              },
            ],
          },
        ],
      },
    ],
  };
  const s2 = await post(
    `${ep.httpEndpoint}/v1/logs`,
    Buffer.from(JSON.stringify(logsJson)),
    'application/json'
  );
  assert.strictEqual(s2, 200, 'HTTP logs status');

  // 3) gRPC: logs
  const pkgDef = protoLoader.loadSync(
    'opentelemetry/proto/collector/logs/v1/logs_service.proto',
    { includeDirs: [PROTO_ROOT], keepCase: false, longs: String, enums: Number, bytes: String }
  );
  const grpcObj = grpc.loadPackageDefinition(pkgDef) as any;
  const client = new grpcObj.opentelemetry.proto.collector.logs.v1.LogsService(
    `127.0.0.1:${ep.grpcPort}`,
    grpc.credentials.createInsecure()
  );
  const grpcLogs = {
    resourceLogs: [
      {
        resource: { attributes: [kv('service.name', 'svc-grpc')] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                severityNumber: 17,
                severityText: 'ERROR',
                body: { stringValue: 'grpc error log' },
              },
            ],
          },
        ],
      },
    ],
  };
  await new Promise<void>((resolve, reject) => {
    client.Export(grpcLogs, (err: any) => (err ? reject(err) : resolve()));
  });

  await delay(400);

  const apps = store.getApplications().map((a) => a.name);
  console.log('applications:', apps);
  assert.ok(apps.includes('svc-http'), 'svc-http present');
  assert.ok(apps.includes('svc-json'), 'svc-json present');
  assert.ok(apps.includes('svc-grpc'), 'svc-grpc present');

  const httpInst = store.getAllInstances().find((i) => i.serviceName === 'svc-http')!;
  assert.strictEqual(httpInst.traces.size, 1, 'one trace');
  const trace = [...httpInst.traces.values()][0];
  assert.strictEqual(trace.traceId, '0af7651916cd43dd8448eb211c80319c', 'trace id hex');
  assert.strictEqual([...trace.spans.values()][0].durationMs, 5, 'span duration ms');

  const jsonInst = store.getAllInstances().find((i) => i.serviceName === 'svc-json')!;
  const log = jsonInst.logs.toArray()[0];
  assert.strictEqual(log.body, 'hello from json', 'log body');
  assert.ok(log.codeLocation?.filepath === '/app/main.ts', 'code location parsed');

  const grpcInst = store.getAllInstances().find((i) => i.serviceName === 'svc-grpc')!;
  assert.strictEqual(grpcInst.logs.toArray()[0].severityText, 'ERROR', 'grpc log severity');

  await receiver.stop();
  console.log('SMOKE OK');
}

main().catch((e) => {
  console.error('SMOKE FAILED', e);
  process.exit(1);
});
