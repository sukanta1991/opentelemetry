// OTLP/HTTP server. Accepts POST /v1/{traces,logs,metrics} as protobuf or JSON.
import * as http from 'http';
import * as path from 'path';
import * as zlib from 'zlib';
import * as protobuf from 'protobufjs';
import { OtlpHandlers } from './grpcServer';

interface RequestTypes {
  traces: protobuf.Type;
  logs: protobuf.Type;
  metrics: protobuf.Type;
  tracesResp: protobuf.Type;
  logsResp: protobuf.Type;
  metricsResp: protobuf.Type;
}

const TO_OBJECT_OPTS: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String,
  defaults: false,
  arrays: true,
  objects: true,
  oneofs: true,
};

export async function loadRequestTypes(protoRoot: string): Promise<RequestTypes> {
  const root = new protobuf.Root();
  root.resolvePath = (_origin: string, target: string) => {
    if (path.isAbsolute(target)) return target;
    return path.join(protoRoot, target);
  };
  await root.load(
    [
      path.join(protoRoot, 'opentelemetry/proto/collector/trace/v1/trace_service.proto'),
      path.join(protoRoot, 'opentelemetry/proto/collector/logs/v1/logs_service.proto'),
      path.join(protoRoot, 'opentelemetry/proto/collector/metrics/v1/metrics_service.proto'),
    ],
    { keepCase: false }
  );
  return {
    traces: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'),
    logs: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest'),
    metrics: root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest'),
    tracesResp: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse'),
    logsResp: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse'),
    metricsResp: root.lookupType(
      'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse'
    ),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = 16 * 1024 * 1024;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decompress(buf: Buffer, encoding?: string): Buffer {
  if (encoding === 'gzip') return zlib.gunzipSync(buf);
  if (encoding === 'deflate') return zlib.inflateSync(buf);
  return buf;
}

export function createHttpServer(
  types: RequestTypes,
  handlers: OtlpHandlers
): http.Server {
  return http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const peer = req.socket.remoteAddress || undefined;

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const route = matchRoute(url);
    if (!route) {
      res.writeHead(404).end();
      return;
    }

    try {
      const raw = await readBody(req);
      const body = decompress(raw, req.headers['content-encoding'] as string | undefined);
      const contentType = (req.headers['content-type'] || '').toString();
      const isJson = contentType.includes('json');

      const reqType = types[route];
      let decoded: any;
      if (isJson) {
        decoded = body.length ? JSON.parse(body.toString('utf8')) : {};
      } else {
        const msg = reqType.decode(body);
        decoded = reqType.toObject(msg, TO_OBJECT_OPTS);
      }

      dispatch(route, decoded, peer, handlers);

      respond(res, route, types, isJson);
    } catch (e) {
      console.error('[otel] HTTP handler error', e);
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    }
  });
}

type Route = 'traces' | 'logs' | 'metrics';

function matchRoute(url: string): Route | undefined {
  if (url === '/v1/traces') return 'traces';
  if (url === '/v1/logs') return 'logs';
  if (url === '/v1/metrics') return 'metrics';
  return undefined;
}

function dispatch(route: Route, decoded: any, peer: string | undefined, h: OtlpHandlers): void {
  if (route === 'traces') h.onTraces(decoded, peer);
  else if (route === 'logs') h.onLogs(decoded, peer);
  else h.onMetrics(decoded, peer);
}

function respond(
  res: http.ServerResponse,
  route: Route,
  types: RequestTypes,
  isJson: boolean
): void {
  if (isJson) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const respType =
    route === 'traces' ? types.tracesResp : route === 'logs' ? types.logsResp : types.metricsResp;
  const buf = respType.encode(respType.create({})).finish();
  res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end(Buffer.from(buf));
}
