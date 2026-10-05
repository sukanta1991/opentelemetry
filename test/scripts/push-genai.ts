// SPDX-License-Identifier: Apache-2.0
// Sends a GenAI agent trace (OpenTelemetry gen_ai semantic conventions) plus correlated logs over
// OTLP/HTTP JSON, for manually testing `@otel /agent`. Usage: npx ts-node test/scripts/push-genai.ts [baseUrl]
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';
import { URL } from 'url';

const base = normalizeBase(process.argv[2] || 'http://127.0.0.1:4318');

type Value = string | number | boolean;
type Attr = { key: string; value: Record<string, unknown> };

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nowNs = BigInt(Date.now()) * 1_000_000n;
const ns = (offsetMs: number) => (nowNs + BigInt(Math.round(offsetMs * 1_000_000))).toString();

function attrs(o: Record<string, Value>): Attr[] {
  return Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));
}

function resource(service: string) {
  return { attributes: attrs({ 'service.name': service, 'service.instance.id': `${service}-1` }) };
}

function span(traceId: string, spanId: string, parentSpanId: string | undefined, name: string, kind: number, startMs: number, durMs: number, a: Record<string, Value>, error?: string) {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTimeUnixNano: ns(startMs),
    endTimeUnixNano: ns(startMs + durMs),
    status: error ? { code: 2, message: error } : { code: 0 },
    attributes: attrs(a),
  };
}

function logRecord(atMs: number, severity: number, text: string, traceId: string, spanId: string) {
  const sevText = severity >= 17 ? 'ERROR' : severity >= 13 ? 'WARN' : 'INFO';
  return { timeUnixNano: ns(atMs), severityNumber: severity, severityText: sevText, body: { stringValue: text }, traceId, spanId };
}

function scenario() {
  const traceId = hex(16);
  const id = { agent: hex(8), plan: hex(8), search: hex(8), book: hex(8), http: hex(8), retry: hex(8), answer: hex(8) };
  const S = 'travel-agent';
  const spans = [
    span(traceId, id.agent, undefined, 'invoke_agent travel-planner', 1, 0, 2600, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'travel-planner',
      'gen_ai.provider.name': 'openai',
    }),
    span(traceId, id.plan, id.agent, 'chat gpt-4o', 3, 0, 420, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.response.model': 'gpt-4o-2024-08-06',
      'gen_ai.usage.input_tokens': 812,
      'gen_ai.usage.output_tokens': 64,
      // Content attributes: the AI tools must report only their length.
      'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'Plan a trip to Lisbon for my team' }]),
    }),
    span(traceId, id.search, id.agent, 'execute_tool search_flights', 1, 430, 900, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search_flights',
      'gen_ai.tool.call.id': 'call_search_1',
    }),
    // Runs in parallel with search_flights and fails.
    span(traceId, id.book, id.agent, 'execute_tool book_hotel', 1, 500, 600, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'book_hotel',
      'gen_ai.tool.call.id': 'call_book_1',
      'error.type': 'HotelUnavailable',
    }, 'no rooms for the requested dates'),
    span(traceId, id.http, id.book, 'POST hotels.example.com/book', 3, 520, 560, {
      'http.request.method': 'POST',
      'server.address': 'hotels.example.com',
      'http.response.status_code': 409,
      // Redaction check: must show as [REDACTED] in tool output.
      'http.request.header.authorization': 'Bearer sk-live-demo-0123456789abcdefghij',
    }, 'HTTP 409'),
    // Older attribute names and string token counts.
    span(traceId, id.retry, id.agent, 'chat gpt-4o-mini', 3, 1350, 380, {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o-mini',
      'gen_ai.usage.prompt_tokens': '1430',
      'gen_ai.usage.completion_tokens': '120',
      'gen_ai.prompt': 'Summarize the flight options and the hotel error',
    }),
    span(traceId, id.answer, id.agent, 'chat gpt-4o', 3, 1800, 780, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1650,
      'gen_ai.usage.output_tokens': 310,
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'Here is your itinerary…' }]),
    }),
  ];
  const logs = [
    logRecord(5, 9, 'agent run started', traceId, id.agent),
    logRecord(1080, 17, 'book_hotel failed: HotelUnavailable (409)', traceId, id.book),
    logRecord(2590, 9, 'agent run finished with 1 failed tool', traceId, id.agent),
  ];
  console.log(`GenAI agent trace: ${traceId}`);
  return {
    traces: { resourceSpans: [{ resource: resource(S), scopeSpans: [{ scope: { name: 'push-genai' }, spans }] }] },
    logs: { resourceLogs: [{ resource: resource(S), scopeLogs: [{ scope: { name: 'push-genai' }, logRecords: logs }] }] },
  };
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

async function main(): Promise<void> {
  const { traces, logs } = scenario();
  await post('/v1/traces', traces);
  await post('/v1/logs', logs);
}

main().catch((e: Error) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
