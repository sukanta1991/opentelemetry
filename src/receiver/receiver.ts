// Receiver facade: owns the gRPC + HTTP OTLP servers, binds them, and routes decoded
// payloads into the telemetry store.
import * as grpc from '@grpc/grpc-js';
import * as http from 'http';
import { decodeLogs, decodeMetrics, decodeTraces } from '../store/decode';
import { TelemetryStore } from '../store/store';
import { createGrpcServer, OtlpHandlers } from './grpcServer';
import { createHttpServer, loadRequestTypes } from './httpServer';

export interface ReceiverConfig {
  host: string;
  portMode: 'fixed' | 'random';
  grpcPort: number;
  httpPort: number;
}

export interface ReceiverEndpoints {
  host: string;
  grpcPort: number;
  httpPort: number;
  grpcEndpoint: string;
  httpEndpoint: string;
}

export class Receiver {
  private grpcServer: grpc.Server | undefined;
  private httpServer: http.Server | undefined;
  private endpoints: ReceiverEndpoints | undefined;
  private running = false;

  constructor(
    private readonly protoRoot: string,
    private readonly store: TelemetryStore
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  getEndpoints(): ReceiverEndpoints | undefined {
    return this.endpoints;
  }

  private handlers(): OtlpHandlers {
    return {
      onTraces: (req, peer) => this.store.ingestSpans(decodeTraces(req), peer),
      onLogs: (req, peer) => this.store.ingestLogs(decodeLogs(req), peer),
      onMetrics: (req, peer) => this.store.ingestMetrics(decodeMetrics(req), peer),
    };
  }

  async start(config: ReceiverConfig): Promise<ReceiverEndpoints> {
    if (this.running) return this.endpoints!;
    const handlers = this.handlers();
    const grpcWanted = config.portMode === 'fixed' ? config.grpcPort : 0;
    const httpWanted = config.portMode === 'fixed' ? config.httpPort : 0;

    const grpcServer = createGrpcServer(this.protoRoot, handlers);
    const grpcPort = await this.bindGrpc(grpcServer, config.host, grpcWanted);

    const types = await loadRequestTypes(this.protoRoot);
    const httpServer = createHttpServer(types, handlers);
    const httpPort = await this.bindHttp(httpServer, config.host, httpWanted);

    this.grpcServer = grpcServer;
    this.httpServer = httpServer;
    this.running = true;
    this.endpoints = {
      host: config.host,
      grpcPort,
      httpPort,
      grpcEndpoint: `http://${config.host}:${grpcPort}`,
      httpEndpoint: `http://${config.host}:${httpPort}`,
    };
    return this.endpoints;
  }

  private bindGrpc(server: grpc.Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.bindAsync(
        `${host}:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(boundPort);
        }
      );
    });
  }

  private bindHttp(server: http.Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        resolve(bound);
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.endpoints = undefined;
    const tasks: Promise<void>[] = [];
    if (this.grpcServer) {
      const g = this.grpcServer;
      this.grpcServer = undefined;
      tasks.push(
        new Promise<void>((resolve) => {
          g.tryShutdown(() => resolve());
          setTimeout(() => {
            try {
              g.forceShutdown();
            } catch {
              /* ignore */
            }
            resolve();
          }, 1500);
        })
      );
    }
    if (this.httpServer) {
      const h = this.httpServer;
      this.httpServer = undefined;
      tasks.push(
        new Promise<void>((resolve) => {
          h.close(() => resolve());
          h.closeAllConnections?.();
        })
      );
    }
    await Promise.all(tasks);
  }
}
