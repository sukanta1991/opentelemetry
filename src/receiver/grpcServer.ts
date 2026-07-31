// OTLP/gRPC server. Uses @grpc/proto-loader against the vendored opentelemetry-proto files.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

export interface OtlpHandlers {
  onTraces(req: any, peer?: string): void;
  onLogs(req: any, peer?: string): void;
  onMetrics(req: any, peer?: string): void;
}

const LOADER_OPTS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: Number,
  bytes: String,
  defaults: false,
  oneofs: true,
};

export function createGrpcServer(protoRoot: string, handlers: OtlpHandlers): grpc.Server {
  const packageDef = protoLoader.loadSync(
    [
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      'opentelemetry/proto/collector/logs/v1/logs_service.proto',
      'opentelemetry/proto/collector/metrics/v1/metrics_service.proto',
    ],
    { ...LOADER_OPTS, includeDirs: [protoRoot] }
  );
  const proto = grpc.loadPackageDefinition(packageDef) as any;
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
  });

  const collector = proto.opentelemetry.proto.collector;

  server.addService(collector.trace.v1.TraceService.service, {
    Export: (call: any, callback: grpc.sendUnaryData<any>) => {
      try {
        handlers.onTraces(call.request, call.getPeer());
      } catch (e) {
        console.error('[otel] gRPC trace handler error', e);
      }
      callback(null, { partialSuccess: {} });
    },
  });

  server.addService(collector.logs.v1.LogsService.service, {
    Export: (call: any, callback: grpc.sendUnaryData<any>) => {
      try {
        handlers.onLogs(call.request, call.getPeer());
      } catch (e) {
        console.error('[otel] gRPC logs handler error', e);
      }
      callback(null, { partialSuccess: {} });
    },
  });

  server.addService(collector.metrics.v1.MetricsService.service, {
    Export: (call: any, callback: grpc.sendUnaryData<any>) => {
      try {
        handlers.onMetrics(call.request, call.getPeer());
      } catch (e) {
        console.error('[otel] gRPC metrics handler error', e);
      }
      callback(null, { partialSuccess: {} });
    },
  });

  return server;
}

export function protoRootForLoader(distDir: string): string {
  return path.join(distDir, 'proto');
}
