// Sends correlated traces and logs over OTLP/HTTP JSON for manually exercising trace ↔ log
// navigation. Usage: npx ts-node test/scripts/push-correlated.ts [baseUrl] [--bulk]
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { URL } from 'url';

const args = process.argv.slice(2);
const bulk = args.includes('--bulk');
const base = normalizeBase(args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4318');

type Attr = { key: string; value: Record<string, unknown> };

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nowNs = BigInt(Date.now()) * 1_000_000n;
const ns = (offsetMs: number) => (nowNs + BigInt(Math.round(offsetMs * 1_000_000))).toString();

function attrs(o: Record<string, string | number | boolean>): Attr[] {
  return Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));
}

function resource(service: string) {
  return { attributes: attrs({ 'service.name': service, 'service.instance.id': `${service}-1`, 'host.name': 'demo-host' }) };
}

interface SpanSpec {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  durMs: number;
  error?: string;
  attributes?: Record<string, string | number | boolean>;
  events?: { name: string; atMs: number; attributes: Record<string, string | number | boolean> }[];
  links?: { traceId: string; spanId: string; attributes?: Record<string, string | number | boolean> }[];
}

function span(s: SpanSpec) {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: ns(s.startMs),
    endTimeUnixNano: ns(s.startMs + s.durMs),
    status: s.error ? { code: 2, message: s.error } : { code: 0 },
    attributes: attrs(s.attributes ?? {}),
    events: (s.events ?? []).map((e) => ({ name: e.name, timeUnixNano: ns(e.atMs), attributes: attrs(e.attributes) })),
    links: (s.links ?? []).map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: attrs(l.attributes ?? {}) })),
  };
}

function logRecord(atMs: number, severity: number, text: string, traceId?: string, spanId?: string) {
  const sevText = severity >= 17 ? 'ERROR' : severity >= 13 ? 'WARN' : severity >= 9 ? 'INFO' : 'DEBUG';
  return { timeUnixNano: ns(atMs), severityNumber: severity, severityText: sevText, body: { stringValue: text }, traceId, spanId };
}

function traces(byService: Record<string, ReturnType<typeof span>[]>) {
  return {
    resourceSpans: Object.entries(byService).map(([svc, spans]) => ({
      resource: resource(svc),
      scopeSpans: [{ scope: { name: 'push-correlated' }, spans }],
    })),
  };
}

function logs(byService: Record<string, ReturnType<typeof logRecord>[]>) {
  return {
    resourceLogs: Object.entries(byService).map(([svc, logRecords]) => ({
      resource: resource(svc),
      scopeLogs: [{ scope: { name: 'push-correlated' }, logRecords }],
    })),
  };
}

function scenario(): { traces: unknown; logs: unknown } {
  const repoFile = path.resolve(__dirname, '../../src/extension.ts');
  const earlier = { traceId: hex(16), root: hex(8) };
  const t = { traceId: hex(16), root: hex(8), client: hex(8), server: hex(8), charge: hex(8), db: hex(8) };
  const cycle = { traceId: hex(16), a: hex(8), b: hex(8) };
  const zeroTrace = '0'.repeat(32);
  const zeroSpan = '0'.repeat(16);

  const spans = traces({
    frontend: [
      span({ traceId: earlier.traceId, spanId: earlier.root, name: 'GET /cart', kind: 2, startMs: -5000, durMs: 40, attributes: { 'http.route': '/cart', 'http.status_code': 200 } }),
      span({
        traceId: t.traceId, spanId: t.root, name: 'GET /checkout', kind: 2, startMs: 0, durMs: 250,
        attributes: { 'http.route': '/checkout', 'http.status_code': 500, 'code.filepath': repoFile, 'code.lineno': 20, 'code.function': 'activate' },
      }),
      span({
        traceId: t.traceId, spanId: t.client, parentSpanId: t.root, name: 'POST /api/pay', kind: 3, startMs: 10, durMs: 200,
        attributes: { 'http.method': 'POST', 'peer.service': 'checkout', 'code.filepath': '/etc/hosts', 'code.lineno': 1 },
      }),
      span({ traceId: cycle.traceId, spanId: cycle.a, parentSpanId: cycle.b, name: 'cycle A', kind: 1, startMs: 300, durMs: 5 }),
      span({ traceId: cycle.traceId, spanId: cycle.b, parentSpanId: cycle.a, name: 'cycle B', kind: 1, startMs: 302, durMs: 5 }),
    ],
    checkout: [
      span({
        traceId: t.traceId, spanId: t.server, parentSpanId: t.client, name: 'POST /api/pay', kind: 2, startMs: 20, durMs: 180,
        attributes: { 'http.route': '/api/pay' },
        links: [{ traceId: earlier.traceId, spanId: earlier.root, attributes: { reason: 'cart session' } }],
      }),
      span({
        traceId: t.traceId, spanId: t.charge, parentSpanId: t.server, name: 'charge card', kind: 1, startMs: 40, durMs: 60, error: 'card declined',
        attributes: { 'payment.provider': 'stripe', 'code.file.path': 'src/extension.ts', 'code.line.number': 1 },
        events: [{
          name: 'exception', atMs: 95,
          attributes: { 'exception.type': 'CardError', 'exception.message': 'card declined', 'exception.stacktrace': 'CardError: card declined\n    at charge (pay.ts:42:11)\n    at handler (server.ts:10:5)' },
        }],
      }),
      span({ traceId: t.traceId, spanId: t.db, parentSpanId: t.server, name: 'SELECT orders', kind: 3, startMs: 110, durMs: 30, attributes: { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM orders WHERE id = $1' } }),
    ],
  });

  const records = logs({
    frontend: [
      logRecord(1, 9, 'checkout requested', t.traceId, t.root),
      logRecord(12, 9, 'calling payment service', t.traceId, t.client),
      logRecord(245, 17, 'checkout failed: payment error', t.traceId, t.root),
      logRecord(-4990, 9, 'cart viewed', earlier.traceId, earlier.root),
      logRecord(260, 13, 'trace-level log without a span id', t.traceId),
      logRecord(261, 9, 'log with all-zero ids (no trace context)', zeroTrace, zeroSpan),
    ],
    checkout: [
      logRecord(25, 9, 'payment request received', t.traceId, t.server),
      logRecord(50, 5, 'contacting provider', t.traceId, t.charge),
      logRecord(96, 17, 'card declined by provider', t.traceId, t.charge),
      logRecord(150, 13, 'late retry log (skewed 50ms after its span)', t.traceId, t.charge),
      logRecord(120, 9, 'orders loaded', t.traceId, t.db),
    ],
  });

  console.log(`Trace with logs: ${t.traceId}\nLinked earlier trace: ${earlier.traceId}\nCycle trace: ${cycle.traceId}`);
  return { traces: spans, logs: records };
}

function bulkTraces(count: number, spansPer: number): unknown[] {
  const batches: unknown[] = [];
  for (let b = 0; b < count; b += 100) {
    const spans: ReturnType<typeof span>[] = [];
    for (let i = b; i < Math.min(count, b + 100); i++) {
      const traceId = hex(16);
      const root = hex(8);
      const start = -i * 20;
      spans.push(span({ traceId, spanId: root, name: `GET /item/${i % 25}`, kind: 2, startMs: start, durMs: 5 + (i % 400), attributes: { 'http.status_code': i % 17 ? 200 : 500 } }));
      for (let s = 1; s < spansPer; s++) {
        spans.push(span({
          traceId, spanId: hex(8), parentSpanId: root, name: `step ${s}`, kind: 1, startMs: start + s * 0.1, durMs: 1,
          error: s === 7 && i % 17 === 0 ? 'boom' : undefined, attributes: { step: s, 'db.system': s % 5 ? 'redis' : 'postgresql' },
        }));
      }
    }
    batches.push(traces({ [`bulk-${b % 2 ? 'b' : 'a'}`]: spans }));
  }
  return batches;
}

async function main(): Promise<void> {
  if (bulk) {
    const batches = bulkTraces(2000, 50);
    for (const [i, body] of batches.entries()) {
      await post('/v1/traces', body);
      process.stdout.write(`\rsent batch ${i + 1}/${batches.length}`);
    }
    process.stdout.write('\n');
    return;
  }
  const { traces: t, logs: l } = scenario();
  await post('/v1/traces', t);
  await post('/v1/logs', l);
}

function post(pathname: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const url = new URL(pathname, base);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 300) reject(new Error(`${pathname}: HTTP ${res.statusCode}`));
          else resolve();
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function normalizeBase(raw: string): URL {
  const value = /^https?:\/\//.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  const url = new URL(value);
  url.pathname = '/';
  return url;
}

main().catch((e: Error) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
