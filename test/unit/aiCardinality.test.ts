// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { BaselineLookup } from '../../src/ai/analysis/baseline';
import { CardinalityInputs, analyzeCardinality } from '../../src/ai/analysis/cardinality';
import { AnalysisContext } from '../../src/ai/analysis/common';
import { MAX_RESULT_CHARS } from '../../src/ai/limits';
import { createRedactor } from '../../src/ai/redact';
import { parseAnalyzeCardinalityInput } from '../../src/ai/toolInputs';
import { describeInvocation, runTool } from '../../src/ai/toolRunner';
import { Metric } from '../../src/store/model';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { captureSnapshot } from '../../src/views/baseline';
import { DEFAULT_BASELINE_SETTINGS } from '../../src/views/baselineCompare';
import { captureCardinality } from '../../src/views/cardinalityBaseline';
import { DEFAULT_PRICING } from '../../src/views/cardinalityCost';
import { DEFAULT_CARDINALITY_SETTINGS } from '../../src/views/cardinalityRules';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';
import { fillToCaps } from './cardinalityFixtures';

const ids = (i: number) => ({ traceId: (i + 1).toString(16).padStart(32, '0'), spanId: (i + 1).toString(16).padStart(16, '0') });
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const SECRET = 'Bearer abcdefghijklmnopqrstuvwxyz';

function fixture(): TelemetryStore {
  const store = new TelemetryStore();
  addSpans(
    store,
    'checkout',
    Array.from({ length: 60 }, (_, i) =>
      span({ ...ids(i), name: 'GET /cart', startMs: T0 + i, attrs: { 'user.id': uuid(i), 'session.id': `s-${i}`, 'customer.ref': `cust-${i}` } })
    ),
    'i1'
  );
  addSpans(store, 'checkout', [span({ ...ids(100), name: 'GET /cart', startMs: T0 })], 'i2');
  addLogs(store, 'worker', Array.from({ length: 120 }, (_, i) => log({ timeMs: T0 + i, body: `auth ${SECRET} rejected` })));
  const metric: Metric = {
    name: 'http.requests',
    type: 'sum',
    monotonic: true,
    dataPoints: Array.from({ length: 30 }, (_, p) => ({ attrs: { user: uuid(p) }, timeMs: T0 + p, value: p })),
  };
  store.ingestMetrics([{ resource: { serviceName: 'checkout', serviceInstanceId: 'i1', attrs: {} }, metrics: [metric] }]);
  return store;
}

function run(store: TelemetryStore, raw: unknown, over: { cardinality?: CardinalityInputs; baselines?: BaselineLookup; redactKeys?: string[] } = {}) {
  const parsed = parseAnalyzeCardinalityInput(raw, 25);
  assert.ok('value' in parsed, JSON.stringify(parsed));
  const ctx: AnalysisContext = { now: T0, redactor: createRedactor(over.redactKeys ?? []), maxItems: 25, cardinality: over.cardinality, baselines: over.baselines };
  return analyzeCardinality(store, parsed.value, ctx);
}

describe('ai analyzeCardinality', () => {
  const store = fixture();

  it('parses input and rejects malformed fields', () => {
    assert.deepStrictEqual(parseAnalyzeCardinalityInput({ signal: 'LOGS', limit: 500 }, 25), { value: { service: undefined, instanceId: undefined, session: undefined, signal: 'logs', limit: 25 } });
    assert.match((parseAnalyzeCardinalityInput({ signal: 'traces' }, 25) as any).error, /signal must be one of: all, spans, logs, metrics/);
    assert.match((parseAnalyzeCardinalityInput({ service: 5 }, 25) as any).error, /service must be a string/);
    assert.match((parseAnalyzeCardinalityInput([], 25) as any).error, /JSON object/);
  });

  it('explains scope errors with the known names, and when the analyzer is off', () => {
    assert.match(String(run(store, { service: 'nope' }).result.error), /no counted service "nope" in live data; known services: checkout, worker/);
    assert.match(String(run(store, { instanceId: 'x' }).result.error), /instance "x" not found in live data; known instances: checkout::i1, checkout::i2, worker::i1/);
    assert.match(String(run(store, { instanceId: 'checkout::i1', service: 'worker' }).result.error), /belongs to service "checkout"/);
    assert.match(String(run(store, { session: 'old.json' }).result.error), /no loaded session "old.json"; loaded sessions: \(none\)/);
    const off = fixture();
    off.setCardinality(false);
    assert.match(String(run(off, {}).result.error), /turned off.*otel\.cardinality\.enabled/);
    assert.match(String(run(new TelemetryStore(), {}).result.note), /Nothing has been counted/);
  });

  it('lists findings with hints and redacted examples, plus volume, services, operations, patterns and metrics', () => {
    const out = run(store, {}, { redactKeys: ['customer.ref'] });
    const r = out.result as any;
    assert.strictEqual(out.listKey, 'findings');
    assert.deepStrictEqual(r.scope, { data: 'live' });
    assert.deepStrictEqual(r.summary.findings, { critical: 1, warning: 2, info: 1 });
    const user = r.findings.find((f: any) => f.attribute === 'user.id');
    assert.deepStrictEqual([user.severity, user.rule, user.valuesLookLike, user.service, user.signal], ['warning', 'R2', 'UUID', 'checkout', 'traces']);
    assert.ok(user.hint && user.examples.length === 3);
    const metric = r.findings.find((f: any) => f.metric === 'http.requests');
    assert.deepStrictEqual([metric.severity, metric.attribute], ['critical', 'user']);
    const pattern = r.findings.find((f: any) => f.rule === 'R6');
    assert.ok(!pattern.subject.includes('abcdefghijklmnop'), pattern.subject);
    assert.ok(r.volume.spansPerDay > 0 && r.volume.bytesPerDay.protobuf > 0 && r.volume.activeSeries === 30);
    assert.deepStrictEqual(r.noisiestServices.map((s: any) => s.service).sort(), ['checkout', 'worker']);
    assert.strictEqual(r.noisiestOperations[0].operation, 'GET /cart');
    assert.ok(!r.topLogPatterns[0].pattern.includes('abcdefghijklmnop'));
    assert.deepStrictEqual(r.topMetricsBySeries[0], { service: 'checkout', metric: 'http.requests', series: 30, drivingLabel: 'user' });
    assert.match(r.cost.note, /No prices are set/);
    assert.strictEqual(out.refs.length, 0);
    const json = JSON.stringify(r);
    for (const leaked of ['abcdefghijklmnop', 's-1"', 'cust-1']) assert.ok(!json.includes(leaked), leaked);
  });

  it('narrows to a service, instance, signal and limit', () => {
    const logs = run(store, { signal: 'logs' }).result as any;
    assert.ok(logs.findings.every((f: any) => f.signal === 'logs'));
    assert.deepStrictEqual(Object.keys(logs.volume).sort(), ['bytesPerDay', 'logsPerDay', 'rateFromLastMinutes']);
    assert.ok(logs.topLogPatterns && !logs.noisiestOperations && !logs.topMetricsBySeries);
    const metrics = run(store, { signal: 'metrics', limit: 1 }).result as any;
    assert.deepStrictEqual([metrics.findings.length, metrics.findings[0].signal], [1, 'metrics']);
    const inst = run(store, { instanceId: 'checkout::i2' }).result as any;
    assert.deepStrictEqual(inst.scope, { data: 'live', service: 'checkout', instanceId: 'checkout::i2' });
    assert.deepStrictEqual(inst.findings, []);
    const svc = run(store, { service: 'WORKER' }).result as any;
    assert.deepStrictEqual([svc.scope.service, svc.noisiestServices.length], ['worker', 1]);
  });

  it('analyzes a loaded session by file name', () => {
    const s = new TelemetryStore();
    s.importSession({
      sourceLabel: 'staging.json',
      traces: [{ resource: { serviceName: 'legacy', attrs: {} }, spans: Array.from({ length: 30 }, (_, i) => span({ ...ids(i), name: 'x', startMs: T0 + i * 1000, attrs: { 'order.id': uuid(i) } })) }],
      logs: [],
      metrics: [],
    });
    const r = run(s, { session: 'STAGING.JSON' }).result as any;
    assert.deepStrictEqual(r.scope, { data: 'staging.json' });
    assert.strictEqual(r.findings[0].attribute, 'order.id');
  });

  it('estimates cost only from supplied prices and reports where they came from', () => {
    const cardinality: CardinalityInputs = {
      settings: DEFAULT_CARDINALITY_SETTINGS,
      pricing: { ...DEFAULT_PRICING, perMillionSpans: 2, perSeriesMonth: 0.1, currency: 'EUR' },
      pricingSource: 'workspace',
    };
    const cost = (run(store, {}, { cardinality }).result as any).cost;
    assert.deepStrictEqual([cost.currency, cost.pricingSource, cost.lines.map((l: any) => l.item)], ['EUR', 'workspace', ['spans', 'series']]);
    assert.strictEqual(cost.lines[1].monthly, 3);
    assert.ok(cost.assumptions.length >= 4);
    const strict = run(store, {}, { cardinality: { ...cardinality, settings: { ...DEFAULT_CARDINALITY_SETTINGS, minDistinct: 10, minDistinctRatio: 0 } } }).result as any;
    assert.strictEqual(strict.findings.find((f: any) => f.attribute === 'user.id').rule, 'R1', 'thresholds come from the inputs');
  });

  it('adds a baseline delta when the active baseline has a cardinality summary', () => {
    const before = fixture();
    const snapshot = { ...captureSnapshot(before.getAllTaggedSpans(), { kind: 'mark', label: 'live', realm: LIVE_REALM }), cardinality: captureCardinality(before.getAllInstances(), { realm: LIVE_REALM }) };
    const now = fixture();
    addSpans(now, 'checkout', Array.from({ length: 200 }, (_, i) => span({ ...ids(1000 + i), name: 'GET /cart', attrs: { cart: `c${i}` } })), 'i1');
    const candidate = { id: 'b1', name: 'before', createdMs: T0, sourceKind: 'mark' as const, sourceLabel: 'live', saved: false, active: true };
    const baselines: BaselineLookup = { list: [candidate], bodies: new Map([['b1', snapshot]]), settings: DEFAULT_BASELINE_SETTINGS };
    const delta = (run(now, {}, { baselines }).result as any).baselineDelta;
    assert.deepStrictEqual([delta.baseline, delta.summary.new], ['before', 1]);
    const [first] = delta.changes;
    assert.deepStrictEqual([first.change, first.service, first.attribute, first.unique[0]], ['new', 'checkout', 'cart', null]);
    assert.ok(Math.abs(first.unique[1] - 200) <= 10, 'sketch estimate');
    assert.ok(delta.volumeChanges.some((v: any) => v.service === 'checkout' && v.signal === 'traces'));
    const noSummary: BaselineLookup = { ...baselines, bodies: new Map([['b1', { ...snapshot, cardinality: undefined }]]) };
    assert.strictEqual((run(now, {}, { baselines: noSummary }).result as any).baselineDelta, undefined);
  });

  it('runs through the tool pipeline within the size cap at all caps, redacted', function () {
    // Builds the all-caps fixture; slow under coverage instrumentation.
    this.timeout(60_000);
    const big = fillToCaps();
    addLogs(big, 'logs0', [log({ timeMs: T0, body: `login ${SECRET}` })]);
    const settings = { enabled: true, redactAttributeKeys: [], maxResultItems: 200 };
    const out = runTool('otel_analyzeCardinality', { limit: 200 }, { store: big, settings, receiverRunning: true, now: T0 });
    assert.ok(out.json.length <= MAX_RESULT_CHARS, `${out.json.length}`);
    assert.ok(out.itemCount > 0);
    assert.ok(!out.json.includes('abcdefghijklmnop'));
    const parsed = JSON.parse(out.json);
    assert.ok(parsed.summary.findings.warning >= 3584, JSON.stringify(parsed.summary));
    assert.ok(parsed.summary.findingsTotal > parsed.summary.findingsListed);
    assert.ok(!JSON.stringify(parsed).includes(SECRET));
    const text = describeInvocation('otel_analyzeCardinality', { service: 'a*b', signal: 'logs' }, settings);
    assert.match(text.message, /Analyze Telemetry Cardinality and Cost/);
    assert.ok(text.message.includes('service=a\\*b'));
  });
});
