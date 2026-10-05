// SPDX-License-Identifier: Apache-2.0
// Store builders for AI tests. Not a *.test.ts file, so Mocha doesn't run it directly.

import { LogRecord, Metric, Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

export function span(p: Partial<Span> & { traceId: string; spanId: string }): Span {
  const startMs = p.startMs ?? T0;
  const durationMs = p.durationMs ?? 10;
  return {
    name: p.spanId,
    kind: 'INTERNAL',
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
    ...p,
    startMs,
    durationMs,
    endMs: p.endMs ?? startMs + durationMs,
  };
}

export function addSpans(store: TelemetryStore, service: string, spans: Span[], instance = 'i1'): string {
  store.ingestSpans([{ resource: { serviceName: service, serviceInstanceId: instance, attrs: {} }, spans }]);
  return `${service}::${instance}`;
}

export function log(p: Partial<LogRecord> & { timeMs: number; body: LogRecord['body'] }): LogRecord {
  return { severityNumber: 9, severityText: 'INFO', attrs: {}, ...p };
}

export function addLogs(store: TelemetryStore, service: string, logs: LogRecord[], instance = 'i1'): string {
  store.ingestLogs([{ resource: { serviceName: service, serviceInstanceId: instance, attrs: {} }, logs }]);
  return `${service}::${instance}`;
}

export const DIST_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
export const DB_SPAN = 'b000000000000002';

// frontend GET /checkout -> CLIENT -> checkout POST /pay -> postgres SELECT (dbMs, the slow part).
// With dbMs=800: 1000 / 950 / 930 / 800 ms; self-times 50 / 20 / 130 / 800.
export function addDistributedTrace(store: TelemetryStore, traceId = DIST_TRACE, startMs = T0, dbMs = 800): void {
  addSpans(store, 'frontend', [
    span({
      traceId,
      spanId: 'a000000000000001',
      name: 'GET /checkout',
      kind: 'SERVER',
      startMs,
      durationMs: dbMs + 200,
      attrs: { 'http.route': '/checkout', 'http.request.method': 'GET' },
    }),
    span({
      traceId,
      spanId: 'a000000000000002',
      parentSpanId: 'a000000000000001',
      name: 'POST checkout',
      kind: 'CLIENT',
      startMs: startMs + 10,
      durationMs: dbMs + 150,
      attrs: { 'peer.service': 'checkout' },
    }),
  ]);
  addSpans(store, 'checkout', [
    span({
      traceId,
      spanId: 'b000000000000001',
      parentSpanId: 'a000000000000002',
      name: 'POST /pay',
      kind: 'SERVER',
      startMs: startMs + 20,
      durationMs: dbMs + 130,
    }),
    span({
      traceId,
      spanId: DB_SPAN,
      parentSpanId: 'b000000000000001',
      name: 'SELECT orders',
      kind: 'CLIENT',
      startMs: startMs + 30,
      durationMs: dbMs,
      attrs: { 'db.system': 'postgresql', 'db.namespace': 'shop', 'db.statement': 'SELECT * FROM orders' },
      codeLocation: { filepath: '/srv/checkout/orders.py', line: 17, function: 'load_orders' },
    }),
  ]);
}

export const SECRET_BEARER = 'Bearer abcdefghijklmnop';
export const SECRET_KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz';
export const FAIL_TRACE = 'f00dfeedf00dfeedf00dfeedf00dfeed';
export const FAIL_ROOT = 'f000000000000001';
export const FAIL_CHILD = 'f000000000000002';

export function addFailingTrace(store: TelemetryStore, traceId = FAIL_TRACE, startMs = T0 + 5000): void {
  addSpans(store, 'checkout', [
    span({
      traceId,
      spanId: FAIL_ROOT,
      name: 'POST /pay',
      kind: 'SERVER',
      statusCode: 'ERROR',
      statusMessage: `payment failed (${SECRET_BEARER})`,
      startMs,
      durationMs: 300,
      attrs: { 'http.route': '/pay', 'http.request.method': 'POST' },
    }),
    span({
      traceId,
      spanId: FAIL_CHILD,
      parentSpanId: FAIL_ROOT,
      name: 'charge card',
      kind: 'CLIENT',
      statusCode: 'ERROR',
      startMs: startMs + 10,
      durationMs: 250,
      attrs: {
        'http.request.header.authorization': SECRET_BEARER,
        'server.address': 'api.payments.local',
        'error.type': 'CardError',
        'gen_ai.prompt': 'must never be sent',
      },
      events: [
        {
          name: 'exception',
          timeMs: startMs + 200,
          attrs: {
            'exception.type': 'CardError',
            'exception.message': `card declined, api_key=${SECRET_KEY}`,
            'exception.stacktrace': 'at charge (pay.py:42)',
          },
        },
      ],
      codeLocation: { filepath: '/srv/checkout/pay.py', line: 42, column: 5, function: 'charge' },
    }),
  ]);
}

export function baselineTraceId(i: number): string {
  return `ba5e${i.toString(16).padStart(28, '0')}`;
}

// Successful traces with the same root as DIST_TRACE and a fast DB span (50–58 ms), 1 s apart.
export function addBaselineTraces(store: TelemetryStore, count = 30, startMs = T0 + 60_000): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = baselineTraceId(i);
    addDistributedTrace(store, id, startMs + i * 1000, 50 + (i % 5) * 2);
    ids.push(id);
  }
  return ids;
}

export const ODD_TRACE = 'dddddddddddddddddddddddddddddddd';

// Root "job" 0–100 ms; a child that starts 20 ms early and ends 30 ms late; an orphan span.
export function addOrphanAndSkewTrace(store: TelemetryStore, traceId = ODD_TRACE, startMs = T0 + 8000): void {
  addSpans(store, 'worker', [
    span({ traceId, spanId: 'd000000000000001', name: 'job', startMs, durationMs: 100 }),
    span({
      traceId,
      spanId: 'd000000000000002',
      parentSpanId: 'd000000000000001',
      name: 'skewed',
      startMs: startMs - 20,
      durationMs: 150,
    }),
    span({
      traceId,
      spanId: 'd000000000000003',
      parentSpanId: 'ffffffffffffffff',
      name: 'lost',
      startMs: startMs + 20,
      durationMs: 30,
    }),
  ]);
}

export const AGENT_TRACE = 'a9e17a9e17a9e17a9e17a9e17a9e17a9';
export const AGENT_CONTENT = ['secret travel plan', 'old style prompt text', 'the final answer'];

// invoke_agent 0–1000 ms; LLM calls at 0–200, 500–650 (old attribute names, string tokens), 700–950;
// tools "search" 200–500 and "book" 250–450 (parallel, failing). LLM 600, tools 300, other 100.
export function addAgentTrace(store: TelemetryStore, traceId = AGENT_TRACE, startMs = T0 + 20_000): void {
  const at = (ms: number) => startMs + ms;
  addSpans(store, 'agent-app', [
    span({
      traceId,
      spanId: '9000000000000001',
      name: 'invoke_agent travel',
      startMs: at(0),
      durationMs: 1000,
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'travel', 'gen_ai.provider.name': 'openai' },
    }),
    span({
      traceId,
      spanId: '9000000000000002',
      parentSpanId: '9000000000000001',
      name: 'chat gpt-4o',
      kind: 'CLIENT',
      startMs: at(0),
      durationMs: 200,
      attrs: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.response.model': 'gpt-4o-2024-08-06',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20,
        'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: AGENT_CONTENT[0] }]),
      },
    }),
    span({
      traceId,
      spanId: '9000000000000003',
      parentSpanId: '9000000000000001',
      name: 'execute_tool search',
      startMs: at(200),
      durationMs: 300,
      attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search', 'gen_ai.tool.call.id': 'call_1' },
    }),
    span({
      traceId,
      spanId: '9000000000000004',
      parentSpanId: '9000000000000001',
      name: 'book flight',
      statusCode: 'ERROR',
      statusMessage: 'booking failed',
      startMs: at(250),
      durationMs: 200,
      attrs: { 'gen_ai.tool.name': 'book', 'gen_ai.tool.call.id': 'call_2', 'error.type': 'BookingError' },
    }),
    span({
      traceId,
      spanId: '9000000000000005',
      parentSpanId: '9000000000000001',
      name: 'chat',
      kind: 'CLIENT',
      startMs: at(500),
      durationMs: 150,
      attrs: {
        'gen_ai.system': 'openai',
        'gen_ai.request.model': 'gpt-4o-mini',
        'gen_ai.usage.prompt_tokens': '80',
        'gen_ai.usage.completion_tokens': '10',
        'gen_ai.prompt': AGENT_CONTENT[1],
      },
    }),
    span({
      traceId,
      spanId: '9000000000000006',
      parentSpanId: '9000000000000001',
      name: 'chat gpt-4o',
      kind: 'CLIENT',
      startMs: at(700),
      durationMs: 250,
      attrs: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.usage.input_tokens': 50,
        'gen_ai.usage.output_tokens': 30,
        'gen_ai.output.messages': AGENT_CONTENT[2],
      },
    }),
  ]);
}

function sum(name: string, timeMs: number, value: number, attrs = {}): Metric {
  return { name, type: 'sum', monotonic: true, unit: '{request}', dataPoints: [{ attrs, timeMs, value }] };
}

function gauge(name: string, timeMs: number, value: number): Metric {
  return { name, type: 'gauge', unit: 'By', description: 'Resident memory', dataPoints: [{ attrs: {}, timeMs, value }] };
}

// checkout::i1: counter http.server.requests {route=/pay} 10 → 30 → 70 over 20 s, plus a
// single-point {route=/health} series; gauge process.memory 100 → 300 → 200.
export function addMetrics(store: TelemetryStore, startMs = T0): void {
  const ingest = (metrics: Metric[]) =>
    store.ingestMetrics([{ resource: { serviceName: 'checkout', serviceInstanceId: 'i1', attrs: {} }, metrics }]);
  ingest([sum('http.server.requests', startMs, 10, { route: '/pay' }), gauge('process.memory', startMs, 100)]);
  ingest([sum('http.server.requests', startMs + 10_000, 30, { route: '/pay' }), gauge('process.memory', startMs + 10_000, 300)]);
  ingest([sum('http.server.requests', startMs + 20_000, 70, { route: '/pay' }), gauge('process.memory', startMs + 20_000, 200)]);
  ingest([sum('http.server.requests', startMs + 20_000, 5, { route: '/health', 'api.token': 'tok_secret' })]);
}

// Logs for DIST_TRACE in two services, plus one uncorrelated log.
export function addTraceLogs(store: TelemetryStore, traceId = DIST_TRACE, startMs = T0): void {
  addLogs(store, 'frontend', [log({ timeMs: startMs + 5, body: 'request received', traceId, spanId: 'a000000000000001' })]);
  addLogs(store, 'checkout', [
    log({ timeMs: startMs - 1000, body: 'service ready' }),
    log({ timeMs: startMs + 25, body: 'checkout started', traceId, spanId: 'b000000000000001' }),
    log({ timeMs: startMs + 40, body: 'querying orders', traceId, spanId: DB_SPAN }),
    log({
      timeMs: startMs + 820,
      severityNumber: 13,
      severityText: 'WARN',
      body: 'slow query, dsn postgres://app:hunter2@db:5432/shop',
      traceId,
      spanId: DB_SPAN,
    }),
  ]);
}
