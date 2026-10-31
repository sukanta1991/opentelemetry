// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import * as path from 'path';
import { AttrScope, Size, logSize, metricSize, pointSize, requestSize, spanSize } from '../../src/store/cardinality/sizes';
import { byScope, encodeLog, encodeMetric, encodeResource, encodeSpan } from '../../src/store/encode';
import { AttributeValue, KeyValueMap, LogRecord, Metric, MetricDataPoint, ResourceInfo, Span } from '../../src/store/model';
import { loadRequestTypes } from '../../src/receiver/httpServer';
import { T0 } from './aiFixtures';
import { buildLogBatches, buildMetricBatches, buildSpanBatches } from './ingestFixtures';

type RequestTypes = Awaited<ReturnType<typeof loadRequestTypes>>;
type Json = Record<string, unknown>;

// Oneof members keep their default values on the wire; every other default-valued field is omitted.
const ONEOF = new Set([
  'stringValue',
  'boolValue',
  'intValue',
  'doubleValue',
  'arrayValue',
  'kvlistValue',
  'asDouble',
  'asInt',
  'gauge',
  'histogram',
  'exponentialHistogram',
  'summary',
]);
const ID_FIELDS = new Set(['traceId', 'spanId', 'parentSpanId']);

const isDefault = (v: unknown) =>
  v === '' ||
  v === 0 ||
  v === '0' ||
  v === false ||
  (Array.isArray(v) && !v.length) ||
  (!!v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

/** OTLP/JSON from encode.ts -> what a proto3 SDK would send (defaults omitted, hex ids as base64 bytes). */
function canonical(v: unknown, keepSum = false): unknown {
  if (Array.isArray(v)) return v.map((x) => canonical(x, keepSum));
  if (!v || typeof v !== 'object') return v;
  const out: Json = {};
  for (const [k, x] of Object.entries(v)) {
    if (ID_FIELDS.has(k) && typeof x === 'string') {
      if (x) out[k] = Buffer.from(x, 'hex').toString('base64');
      continue;
    }
    const container = k === 'sum' && typeof x === 'object';
    // Histogram `sum` is `optional double` (has presence); summary `sum` is a plain double.
    const childKeepSum =
      k === 'histogram' || k === 'exponentialHistogram' ? true : k === 'summary' || k === 'gauge' || container ? false : keepSum;
    const c = canonical(x, childKeepSum);
    if (ONEOF.has(k) || container || (k === 'sum' && keepSum) || !isDefault(c)) out[k] = c;
  }
  return out;
}

const resourceJson = (r: ResourceInfo) => encodeResource(r.serviceName, r.serviceInstanceId, r.attrs);
const scopeName = (scope: Json) => scope.name as string | undefined;

function sum(sizes: Size[]): Size {
  return sizes.reduce((a, b) => ({ proto: a.proto + b.proto, json: a.json + b.json }), { proto: 0, json: 0 });
}

function traceRequest(resource: ResourceInfo, spans: Span[]): { req: Json; estimate: Size } {
  const groups = byScope(spans);
  const req = {
    resourceSpans: [{ resource: resourceJson(resource), scopeSpans: groups.map((g) => ({ scope: g.scope, spans: g.items.map(encodeSpan) })) }],
  };
  const estimate = requestSize(
    'traces',
    resource,
    groups.map((g) => ({ scope: scopeName(g.scope), size: sum(g.items.map((s) => spanSize(s))), count: g.items.length }))
  );
  return { req, estimate };
}

function logRequest(resource: ResourceInfo, logs: LogRecord[]): { req: Json; estimate: Size } {
  const groups = byScope(logs);
  const req = {
    resourceLogs: [{ resource: resourceJson(resource), scopeLogs: groups.map((g) => ({ scope: g.scope, logRecords: g.items.map(encodeLog) })) }],
  };
  const estimate = requestSize(
    'logs',
    resource,
    groups.map((g) => ({ scope: scopeName(g.scope), size: sum(g.items.map((l) => logSize(l))), count: g.items.length }))
  );
  return { req, estimate };
}

function metricRequest(resource: ResourceInfo, metrics: Metric[]): { req: Json; estimate: Size } {
  const req = {
    resourceMetrics: [{ resource: resourceJson(resource), scopeMetrics: [{ scope: {}, metrics: metrics.map((m) => encodeMetric(m, m.dataPoints)) }] }],
  };
  const size = sum(metrics.map((m) => metricSize(m, sum(m.dataPoints.map((dp) => pointSize(m.type, dp))), m.dataPoints.length)));
  return { req, estimate: requestSize('metrics', resource, [{ size, count: metrics.length }]) };
}

// Park-Miller LCG for repeatable random records.
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

const STRINGS = [
  '',
  'plain',
  'quote " and backslash \\',
  'controls \u0000\u0001\b\t\n\f\r\u001f\u007f',
  'caf\u00e9 \u00fc\u00f1\u00ee',
  '\u4f60\u597d\u4e16\u754c',
  'emoji \u{1F600}\u{1F680}',
  'lone high \ud800 x',
  'lone low \udc00',
  'trailing high \ud83d',
  'line sep \u2028 para \u2029',
  'https://api.example.com/users/42?session=abc&x=%20',
];

function attrValue(r: () => number, depth: number): AttributeValue {
  const pick = Math.floor(r() * (depth < 2 ? 9 : 6));
  switch (pick) {
    case 0:
      return STRINGS[Math.floor(r() * STRINGS.length)];
    case 1:
      return [0, 1, -1, 127, 128, 16383, 16384, 2 ** 31, -(2 ** 40), Number.MAX_SAFE_INTEGER][Math.floor(r() * 10)];
    case 2:
      return [0.5, -2.25, 1e-7, 1.5e-300, NaN, Infinity, -Infinity, 3.14159][Math.floor(r() * 8)];
    case 3:
      return r() < 0.5;
    case 4:
      return null;
    case 5:
      return `v${Math.floor(r() * 1e6)}`;
    case 6:
      return Array.from({ length: Math.floor(r() * 4) }, () => attrValue(r, depth + 1));
    default: {
      const o: KeyValueMap = {};
      const n = Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const key = i === 0 && r() < 0.3 ? '__proto__' : `k${i}`;
        Object.defineProperty(o, key, { value: attrValue(r, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
  }
}

function attrs(r: () => number, n: number): KeyValueMap {
  const out: KeyValueMap = {};
  for (let i = 0; i < n; i++) {
    const key = i === 0 && r() < 0.2 ? STRINGS[Math.floor(r() * STRINGS.length)] : `attr.${i}`;
    Object.defineProperty(out, key, { value: attrValue(r, 0), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const hex = (r: () => number, len: number) =>
  Array.from({ length: len }, () => Math.floor(r() * 16).toString(16)).join('');

// Up to 4.1e12 ms (year 2099) so nanoseconds stay inside fixed64.
const TIMES = [0, -5, NaN, 0.0000004, 0.5, 1, T0, T0 + 0.123456, T0 + 999.9999999, 4.1e12];

function randomSpans(seed: number, n: number): Span[] {
  const r = rng(seed);
  const kinds: Span['kind'][] = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
  const codes: Span['statusCode'][] = ['UNSET', 'OK', 'ERROR'];
  return Array.from({ length: n }, (_, i) => ({
    traceId: hex(r, 32),
    spanId: hex(r, 16),
    parentSpanId: r() < 0.5 ? hex(r, 16) : undefined,
    name: r() < 0.1 ? '' : STRINGS[Math.floor(r() * STRINGS.length)] || `op${i}`,
    kind: kinds[Math.floor(r() * kinds.length)],
    startMs: TIMES[Math.floor(r() * TIMES.length)],
    endMs: TIMES[Math.floor(r() * TIMES.length)],
    durationMs: 1,
    statusCode: codes[Math.floor(r() * codes.length)],
    statusMessage: r() < 0.3 ? STRINGS[Math.floor(r() * STRINGS.length)] : undefined,
    attrs: attrs(r, Math.floor(r() * 6)),
    events: Array.from({ length: Math.floor(r() * 3) }, () => ({
      timeMs: TIMES[Math.floor(r() * TIMES.length)],
      name: r() < 0.2 ? '' : 'exception',
      attrs: attrs(r, Math.floor(r() * 3)),
    })),
    links: Array.from({ length: Math.floor(r() * 3) }, () => ({
      traceId: hex(r, 32),
      spanId: hex(r, 16),
      traceState: r() < 0.5 ? 'vendor=abc,other=1' : undefined,
      attrs: attrs(r, Math.floor(r() * 2)),
    })),
    scope: ['@app/http', '@app/db', undefined][Math.floor(r() * 3)],
  }));
}

function randomLogs(seed: number, n: number): LogRecord[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    timeMs: TIMES[Math.floor(r() * TIMES.length)],
    observedTimeMs: r() < 0.5 ? TIMES[Math.floor(r() * TIMES.length)] : undefined,
    severityNumber: [0, 1, 9, 17, 24][Math.floor(r() * 5)],
    severityText: ['', 'INFO', 'ERROR'][Math.floor(r() * 3)],
    body: attrValue(r, 0),
    attrs: attrs(r, Math.floor(r() * 5)),
    traceId: r() < 0.5 ? hex(r, 32) : undefined,
    spanId: r() < 0.5 ? hex(r, 16) : undefined,
    scope: r() < 0.5 ? '@app/logger' : undefined,
  }));
}

function randomMetrics(seed: number): Metric[] {
  const r = rng(seed);
  const point = (extra: Partial<MetricDataPoint>): MetricDataPoint => ({
    attrs: attrs(r, Math.floor(r() * 4)),
    timeMs: TIMES[Math.floor(r() * TIMES.length)],
    ...extra,
  });
  return [
    { name: 'g', type: 'gauge', dataPoints: [point({ value: 0 }), point({ value: -1.5 }), point({ value: 42 }), point({})] },
    { name: 's.mono', unit: '1', type: 'sum', monotonic: true, dataPoints: [point({ value: 7 })] },
    { name: 's.updown', type: 'sum', monotonic: false, dataPoints: [point({ value: -3 })] },
    { name: 's.unknown-mono', type: 'sum', dataPoints: [] },
    {
      name: 'h',
      description: 'request duration \u00b5s',
      unit: 'ms',
      type: 'histogram',
      dataPoints: [
        point({ count: 0, sum: 0, bucketBounds: [], bucketCounts: [] }),
        point({ count: 12, sum: 345.5, bucketBounds: [1, 2.5, 10], bucketCounts: [1, 0, 9, 2] }),
        point({ count: 3, bucketBounds: [5], bucketCounts: [3, 0] }),
      ],
    },
    {
      name: 'summary',
      type: 'summary',
      dataPoints: [
        point({ count: 5, sum: 0, quantiles: [{ quantile: 0, value: 0 }, { quantile: 0.5, value: 1.25 }, { quantile: 1, value: 9 }] }),
        point({ count: 0, sum: 4, quantiles: [] }),
      ],
    },
    { name: 'exp', type: 'exponentialHistogram', dataPoints: [point({ count: 4, sum: 0 }), point({})] },
    { name: 'mystery', type: 'unknown', dataPoints: [point({ value: 1 })] },
    { name: '', type: 'gauge', dataPoints: [] },
  ];
}

const RESOURCES: ResourceInfo[] = [
  { serviceName: 'checkout', serviceInstanceId: 'i-1', attrs: { 'host.name': 'box', 'process.pid': 4242 } },
  { serviceName: 'svc', attrs: { 'service.name': 'shadowed', 'service.instance.id': 'shadowed', 'deployment.environment': 'dev' } },
  { serviceName: '\u00fcber', attrs: {} },
];

describe('cardinality sizes', function () {
  this.timeout(60_000);
  let types: RequestTypes;

  before(async () => {
    types = await loadRequestTypes(path.join(__dirname, '..', '..', 'proto'));
  });

  const protoLength = (kind: 'traces' | 'logs' | 'metrics', req: Json) => {
    const t = types[kind];
    return t.encode(t.fromObject(canonical(req) as Json)).finish().length;
  };
  const jsonLength = (req: Json) => Buffer.byteLength(JSON.stringify(req), 'utf8');

  function check(kind: 'traces' | 'logs' | 'metrics', { req, estimate }: { req: Json; estimate: Size }, label: string): void {
    assert.strictEqual(estimate.proto, protoLength(kind, req), `${label}: protobuf`);
    assert.strictEqual(estimate.json, jsonLength(req), `${label}: json`);
  }

  it('matches encoded traces byte for byte (edge-case values)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      check('traces', traceRequest(RESOURCES[seed % RESOURCES.length], randomSpans(seed, 1 + (seed % 7))), `seed ${seed}`);
    }
  });

  it('matches encoded logs byte for byte (edge-case values)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      check('logs', logRequest(RESOURCES[seed % RESOURCES.length], randomLogs(seed, 1 + (seed % 7))), `seed ${seed}`);
    }
  });

  it('matches encoded metrics byte for byte (every type, zero values)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      check('metrics', metricRequest(RESOURCES[seed % RESOURCES.length], randomMetrics(seed)), `seed ${seed}`);
    }
  });

  it('matches the ingest fixture batches', () => {
    const spans = buildSpanBatches().slice(0, 4);
    const logs = buildLogBatches().slice(0, 4);
    const metrics = buildMetricBatches().slice(0, 4);
    for (const b of spans) check('traces', traceRequest(b.resource, b.spans), 'span batch');
    for (const b of logs) check('logs', logRequest(b.resource, b.logs), 'log batch');
    for (const b of metrics) check('metrics', metricRequest(b.resource, b.metrics), 'metric batch');
  });

  it('handles a request with no records', () => {
    check('traces', traceRequest(RESOURCES[0], []), 'empty traces');
    check('metrics', metricRequest(RESOURCES[1], []), 'empty metrics');
  });

  it('reports each attribute to the sink, adding up to the attribute share of the record', () => {
    const span = randomSpans(3, 1)[0];
    span.attrs = { 'http.route': '/users/{id}', 'user.id': 'u-1', n: 5, flags: [true, null], nested: { a: 'b' } };
    span.events = [{ timeMs: T0, name: 'e', attrs: { 'exception.type': 'Boom' } }];
    span.links = [{ traceId: hex(rng(9), 32), spanId: hex(rng(10), 16), attrs: { why: 'retry' } }];
    const calls: { key: string; proto: number; json: number; scope: AttrScope }[] = [];
    const full = spanSize(span, (key, _v, proto, json, scope) => calls.push({ key, proto, json, scope }));
    assert.deepStrictEqual(
      calls.map((c) => `${c.scope}:${c.key}`),
      ['record:http.route', 'record:user.id', 'record:n', 'record:flags', 'record:nested', 'event:exception.type', 'link:why']
    );
    const bare = spanSize({ ...span, attrs: {} });
    const record = calls.filter((c) => c.scope === 'record');
    assert.strictEqual(full.json - bare.json, record.reduce((n, c) => n + c.json, 0));
    // The span's own length prefix may grow by a byte.
    const protoDiff = full.proto - bare.proto - record.reduce((n, c) => n + c.proto, 0);
    assert.ok(protoDiff >= 0 && protoDiff <= 1, `prefix growth ${protoDiff}`);
  });
});
