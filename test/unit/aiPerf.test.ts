// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { AnalysisContext, AnalysisOutput } from '../../src/ai/analysis/common';
import { compareTraces } from '../../src/ai/analysis/compare';
import { genAiSummary } from '../../src/ai/analysis/genai';
import { queryLogs } from '../../src/ai/analysis/logs';
import { queryMetrics } from '../../src/ai/analysis/metrics';
import { listServices } from '../../src/ai/analysis/services';
import { getServiceMap } from '../../src/ai/analysis/serviceMap';
import { findSpans } from '../../src/ai/analysis/spans';
import { getTraceDetail } from '../../src/ai/analysis/trace';
import { searchTraces } from '../../src/ai/analysis/traces';
import { MAX_RESULT_CHARS } from '../../src/ai/limits';
import { createRedactor } from '../../src/ai/redact';
import { allTraceIds } from '../../src/ai/resolve';
import { fitResult } from '../../src/ai/serialize';
import * as inputs from '../../src/ai/toolInputs';
import { KeyValueMap, LogRecord, Metric, Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import { quantile } from '../../src/views/webview/stats';
import { T0 } from './aiFixtures';

const INSTANCES = 10;
const TRACES = 2000;
const SPANS = 10;
const LOGS = 5000;
const SERIES = 200;
const POINTS = 500;
const RUNS = 10;
const CI_BUDGET_MS = 500;

function fill(): TelemetryStore {
  const store = new TelemetryStore(LOGS, TRACES, POINTS, SERIES);
  for (let inst = 0; inst < INSTANCES; inst++) {
    const resource = { serviceName: `svc${inst}`, serviceInstanceId: 'i', attrs: {} };
    const spans: Span[] = [];
    const logs: LogRecord[] = [];
    for (let t = 0; t < TRACES; t++) {
      const traceId = `${inst.toString(16)}${t.toString(16).padStart(4, '0')}`.padStart(32, 'a');
      const start = T0 + t * 10 + inst;
      const agent = t % 100 === 0;
      for (let s = 0; s < SPANS; s++) {
        const duration = 5 + s + (t % 13);
        const attrs: KeyValueMap = agent
          ? { 'gen_ai.operation.name': s ? 'chat' : 'invoke_agent', 'gen_ai.usage.input_tokens': 10, 'gen_ai.prompt': 'x'.repeat(200) }
          : { 'http.route': `/r${t % 7}`, authorization: 'Bearer abcdefghijklmnop' };
        if (!agent && s === 5) attrs['db.system'] = 'postgresql';
        spans.push({
          traceId,
          spanId: (s + 1).toString(16).padStart(16, '0'),
          parentSpanId: s ? '0000000000000001' : undefined,
          name: s ? `op${s}` : 'GET /api',
          kind: s ? 'CLIENT' : 'SERVER',
          startMs: start + s,
          endMs: start + s + duration,
          durationMs: duration,
          statusCode: t % 50 === 0 && s === 3 ? 'ERROR' : 'UNSET',
          attrs,
          events: [],
          links: [],
        });
      }
      if (t < LOGS / 2) {
        for (let k = 0; k < 2; k++) {
          logs.push({
            timeMs: start + k,
            severityNumber: k ? 17 : 9,
            severityText: '',
            body: `order ${t} processed token=secret${t} ${'y'.repeat(100)}`,
            attrs: { 'http.route': `/r${t % 7}` },
            traceId,
            spanId: '0000000000000001',
          });
        }
      }
    }
    store.ingestSpans([{ resource, spans }]);
    store.ingestLogs([{ resource, logs }]);
  }
  const resource = { serviceName: 'svc0', serviceInstanceId: 'i', attrs: {} };
  for (let p = 0; p < POINTS; p++) {
    const metric: Metric = {
      name: 'requests',
      type: 'sum',
      monotonic: true,
      dataPoints: Array.from({ length: SERIES }, (_, i) => ({ attrs: { route: `/r${i}` }, timeMs: T0 + p * 1000, value: p * i })),
    };
    store.ingestMetrics([{ resource, metrics: [metric] }]);
  }
  return store;
}

function value<T>(p: inputs.Parsed<T>): T {
  if ('error' in p) throw new Error(p.error);
  return p.value;
}

describe('ai analysis performance (full buffers)', function () {
  this.timeout(120_000);
  let store: TelemetryStore;
  let ctx: AnalysisContext;
  let latest: string;

  before(() => {
    store = fill();
    ctx = { now: T0 + TRACES * 10 + 1000, redactor: createRedactor(), maxItems: 25 };
    latest = allTraceIds(store, 1)[0];
  });

  const cases: [string, () => AnalysisOutput][] = [
    ['listServices', () => listServices(store, {}, ctx)],
    ['searchTraces', () => searchTraces(store, value(inputs.parseSearchTracesInput({}, 25)), ctx)],
    [
      'searchTraces query+groupBy',
      () => searchTraces(store, value(inputs.parseSearchTracesInput({ query: 'status=error', groupBy: 'http.route' }, 25)), ctx),
    ],
    ['findSpans', () => findSpans(store, value(inputs.parseFindSpansInput({ sort: 'selfTime' }, 25)), ctx)],
    ['findSpans groupBy', () => findSpans(store, value(inputs.parseFindSpansInput({ groupBy: 'serviceAndName' }, 25)), ctx)],
    ['getTraceDetail', () => getTraceDetail(store, value(inputs.parseGetTraceInput({})), ctx)],
    ['compareTraces', () => compareTraces(store, value(inputs.parseCompareTracesInput({ traceId: latest })), ctx)],
    ['queryLogs', () => queryLogs(store, value(inputs.parseQueryLogsInput({}, 25)), ctx)],
    ['queryLogs text', () => queryLogs(store, value(inputs.parseQueryLogsInput({ text: 'order 1999', minSeverity: 'error' }, 25)), ctx)],
    ['queryMetrics list', () => queryMetrics(store, value(inputs.parseQueryMetricsInput({}, 25)), ctx)],
    ['queryMetrics series', () => queryMetrics(store, value(inputs.parseQueryMetricsInput({ name: 'requests' }, 25)), ctx)],
    ['genAiSummary', () => genAiSummary(store, value(inputs.parseGenAiSummaryInput({}, 25)), ctx)],
    ['getServiceMap', () => getServiceMap(store, value(inputs.parseGetServiceMapInput({}, 25)), ctx)],
  ];

  for (const [name, fn] of cases) {
    it(`${name}: p95 under ${CI_BUDGET_MS} ms and output within MAX_RESULT_CHARS`, () => {
      const times: number[] = [];
      let out: AnalysisOutput | undefined;
      for (let i = 0; i < RUNS; i++) {
        const t = process.hrtime.bigint();
        out = fn();
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      const p95 = quantile(times, 0.95)!;
      assert.ok(p95 < CI_BUDGET_MS, `${name} p95 ${p95.toFixed(1)} ms`);
      assert.ok(!('error' in out!.result), `${name} returned ${JSON.stringify(out!.result)}`);
      const text = fitResult({ ...ctx.redactor.value(out!.result), refs: out!.refs }, out!.listKey ?? '');
      assert.ok(text.length <= MAX_RESULT_CHARS, `${name} output ${text.length} chars`);
      assert.ok(!('error' in JSON.parse(text)), `${name} did not fit`);
      assert.ok(!text.includes('abcdefghijklmnop') && !text.includes('token=secret'), `${name} leaked a secret`);
    });
  }
});
