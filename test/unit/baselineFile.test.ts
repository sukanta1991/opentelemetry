// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { Snapshot } from '../../src/views/baseline';
import {
  BASELINE_FORMAT,
  BASELINE_VERSION,
  BaselineFileError,
  MAX_BASELINE_FILE_BYTES,
  parseBaselineFile,
  sanitizeBaselineName,
  serializeBaseline,
} from '../../src/views/baselineFile';
import { captureCardinality } from '../../src/views/cardinalityBaseline';
import { CardinalitySummary } from '../../src/views/cardinalitySummary';
import { T0, addLogs, addSpans, log, span } from './aiFixtures';
import { apiCalls, capture, tid } from './baselineFixtures';

const sample = (): Snapshot => capture(apiCalls(Array.from({ length: 30 }, (_, i) => ({ endMs: T0 + i, ms: 5 + (i % 4), dbMs: 2, error: i === 3 }))));
const fileOf = (snapshot = sample()) => JSON.parse(serializeBaseline({ name: 'main', createdMs: T0, snapshot }));

function usage(): CardinalitySummary {
  const store = new TelemetryStore();
  const ids = (i: number) => ({ traceId: tid(i), spanId: (i + 1).toString(16).padStart(16, '0') });
  addSpans(store, 'api', Array.from({ length: 40 }, (_, i) => span({ ...ids(i), name: 'GET', startMs: T0 + i, attrs: { 'user.id': `u${i}`, tenant: 'a' } })));
  addLogs(store, 'worker', [log({ timeMs: T0, body: 'done', attrs: { 'job.id': 'j1' } })]);
  store.ingestMetrics([
    {
      resource: { serviceName: 'api', serviceInstanceId: 'i1', attrs: {} },
      metrics: [{ name: 'hits', type: 'sum', monotonic: true, dataPoints: [{ attrs: { route: '/' }, timeMs: T0, value: 1 }] }],
    },
  ]);
  return captureCardinality(store.getAllInstances(), { realm: LIVE_REALM })!;
}

const withUsage = (): Snapshot => ({ ...sample(), cardinality: usage() });

function rejects(mutate: (f: any) => void, message: RegExp, snapshot?: Snapshot): void {
  const f = fileOf(snapshot);
  mutate(f);
  assert.throws(() => parseBaselineFile(JSON.stringify(f)), (e: unknown) => e instanceof BaselineFileError && message.test(e.message));
}

describe('baseline file', () => {
  it('round-trips a captured snapshot', () => {
    const snapshot = sample();
    const parsed = parseBaselineFile(serializeBaseline({ name: 'main', createdMs: T0, snapshot }));
    assert.deepStrictEqual(parsed, { name: 'main', createdMs: T0, snapshot });
    assert.strictEqual(fileOf().format, BASELINE_FORMAT);
  });

  it('cleans names of control and bidi characters and bounds their length', () => {
    assert.strictEqual(sanitizeBaselineName(' main\u0000\n\u202ebranch '), 'main   branch');
    assert.strictEqual(sanitizeBaselineName('x'.repeat(500)).length, 80);
    assert.strictEqual(sanitizeBaselineName('   '), 'Baseline');
    assert.strictEqual(sanitizeBaselineName(42, 'fallback'), 'fallback');
    const f = fileOf();
    f.name = '\u0007';
    assert.strictEqual(parseBaselineFile(JSON.stringify(f)).name, 'Baseline');
  });

  it('rejects files that are not baselines', () => {
    for (const [text, message] of [
      ['{', /not valid JSON/],
      ['[]', /must be an object/],
      ['null', /must be an object/],
      ['{"format":"otel-session","version":1}', /Not an OpenTelemetry baseline/],
      ['{"format":"otel-baseline","version":3}', /newer version/],
      ['{"format":"otel-baseline","version":"1"}', /Unsupported/],
    ] as const) {
      assert.throws(() => parseBaselineFile(text), (e: unknown) => e instanceof BaselineFileError && message.test(e.message), text);
    }
    assert.throws(() => parseBaselineFile(' '.repeat(MAX_BASELINE_FILE_BYTES + 1)), /larger than 8 MB/);
  });

  it('rejects malformed nodes', () => {
    rejects((f) => (f.snapshot.nodes = {}), /nodes must be a list/);
    rejects((f) => (f.snapshot.nodes[0].type = 'planet'), /type is not recognised/);
    rejects((f) => (f.snapshot.nodes[0].id = ''), /nodes\[0\]\.id/);
    rejects((f) => f.snapshot.nodes.push({ ...f.snapshot.nodes[0] }), /listed twice/);
  });

  it('rejects malformed entries', () => {
    rejects((f) => (f.snapshot.entries[0].target = 'svc:ghost'), /not a listed node/);
    rejects((f) => (f.snapshot.entries.find((e: any) => e.source).source = 'svc:ghost'), /source is not a listed node/);
    rejects((f) => (f.snapshot.entries[0].count = 1.5), /whole number/);
    rejects((f) => (f.snapshot.entries[0].count = -1), /≥ 0/);
    rejects((f) => (f.snapshot.entries[0].errors = f.snapshot.entries[0].count + 1), /exceeds its count/);
    rejects((f) => (f.snapshot.entries[0].p95 = '9'), /p95/);
    rejects((f) => (f.snapshot.entries[0].samples = [3, 1]), /sorted/);
    rejects((f) => (f.snapshot.entries[0].samples = Array.from({ length: 1001 }, (_, i) => i)), /more than 1000/);
    rejects((f) => (f.snapshot.entries[0].exemplars = ['ABCDEF'.padEnd(32, '0')]), /trace ids/);
    rejects((f) => (f.snapshot.entries[0].exemplars = ['../../etc/passwd']), /trace ids/);
    rejects((f) => (f.snapshot.entries[0].exemplars = [tid(1), tid(2), tid(3)]), /more than 2/);
    rejects((f) => (f.snapshot.entries[0].op = 'x'.repeat(201)), /op must be text/);
    rejects((f) => (f.snapshot.entries[0].opsTruncated = 'yes'), /true or false/);
    rejects((f) => f.snapshot.entries.push({ ...f.snapshot.entries[0] }), /listed twice/);
    rejects((f) => (f.snapshot.truncated = 1), /truncated/);
    rejects((f) => (f.snapshot.source.kind = 'ftp'), /kind is not recognised/);
    rejects((f) => (f.createdMs = -5), /createdMs/);
  });

  it('rejects non-finite numbers smuggled in as huge literals', () => {
    const text = serializeBaseline({ name: 'x', createdMs: T0, snapshot: sample() }).replace(/"p50":[0-9.]+/, '"p50":1e999');
    assert.throws(() => parseBaselineFile(text), /p50/);
  });

  it('enforces entry and total sample caps', () => {
    rejects((f) => (f.snapshot.entries = Array.from({ length: 2001 }, () => f.snapshot.entries[0])), /more than 2000 items/);
    rejects((f) => {
      const base = f.snapshot.entries[0];
      f.snapshot.entries = Array.from({ length: 201 }, (_, i) => ({
        ...base,
        op: `op${i}`,
        samples: Array.from({ length: 1000 }, (_, k) => k),
      }));
    }, /more than 200000 samples/);
  });

  it('drops unknown fields, including __proto__, without polluting prototypes', () => {
    const f = fileOf();
    f.extra = 'ignored';
    f.snapshot.entries[0].extra = 1;
    const text = JSON.stringify(f)
      .replace('{"format"', '{"__proto__":{"polluted":true},"format"')
      .replace('"target"', '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"target"');
    const parsed = parseBaselineFile(text) as any;
    assert.strictEqual(parsed.extra, undefined);
    assert.strictEqual(parsed.snapshot.entries[0].extra, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.snapshot.entries[0], '__proto__'), false);
    assert.strictEqual(({} as any).polluted, undefined);
  });

  describe('cardinality summary (version 2)', () => {
    it('round-trips the summary and omits it when absent', () => {
      const snapshot = withUsage();
      assert.ok(snapshot.cardinality!.services.length === 2 && snapshot.cardinality!.services[0].keys.length === 2);
      const text = serializeBaseline({ name: 'main', createdMs: T0, snapshot });
      assert.strictEqual(JSON.parse(text).version, BASELINE_VERSION);
      assert.deepStrictEqual(parseBaselineFile(text), { name: 'main', createdMs: T0, snapshot });
      assert.strictEqual('cardinality' in fileOf().snapshot, false);
      assert.strictEqual('cardinality' in parseBaselineFile(serializeBaseline({ name: 'x', createdMs: T0, snapshot: sample() })).snapshot, false);
    });

    it('reads version 1 files and ignores a summary in them', () => {
      const f = fileOf(withUsage());
      f.version = 1;
      const parsed = parseBaselineFile(JSON.stringify(f));
      assert.strictEqual(parsed.snapshot.cardinality, undefined);
      assert.strictEqual(parsed.snapshot.entries.length, sample().entries.length);
    });

    it('rejects malformed summaries', () => {
      const snap = withUsage();
      const bad = (mutate: (c: any) => void, message: RegExp) => rejects((f) => mutate(f.snapshot.cardinality), message, snap);
      bad((c) => (c.services = {}), /services must be a list/);
      bad((c) => (c.truncated = 'no'), /truncated must be true or false/);
      bad((c) => (c.toMs = c.fromMs - 1), /before/);
      bad((c) => (c.windowMinutes = -1), /windowMinutes/);
      bad((c) => c.services.push({ ...c.services[0] }), /services lists "api" twice/);
      bad((c) => (c.services[0].service = 5), /service must be text/);
      bad((c) => (c.services[0].service = 'x'.repeat(2001)), /service must be text/);
      bad((c) => (c.services[0].totals.traces.count = 1.5), /whole number/);
      bad((c) => (c.services[0].perMinute.logs = null), /perMinute\.logs must be an object/);
      bad((c) => (c.services[0].perMinute.traces.proto = -1), /≥ 0/);
      bad((c) => (c.services[0].keysTruncated = 0), /keysTruncated/);
      bad((c) => (c.services[0].keys[0].scope = 'metric'), /scope is not recognised/);
      bad((c) => (c.services[0].keys[0].cls = 'secret'), /cls is not recognised/);
      bad((c) => (c.services[0].keys[0].key = 'k'.repeat(257)), /key must be text/);
      bad((c) => (c.services[0].keys[0].distinct = '9'), /distinct/);
      bad((c) => (c.services[0].keys[0].approx = 'yes'), /approx/);
      bad((c) => c.services[0].keys.push({ ...c.services[0].keys[0] }), /keys lists .* twice/);
      bad((c) => (c.services[0].metrics[0].driver = ['route']), /driver must be text/);
      bad((c) => c.services[0].metrics.push({ ...c.services[0].metrics[0] }), /metrics lists .* twice/);
      bad((c) => (c.services[0].keys = Array.from({ length: 201 }, (_, i) => ({ ...c.services[0].keys[0], key: `k${i}` }))), /more than 200 items/);
      bad((c) => {
        const k = c.services[0].keys[0];
        c.services = Array.from({ length: 6 }, (_, s) => ({
          ...c.services[0],
          service: `s${s}`,
          keys: Array.from({ length: 200 }, (__, i) => ({ ...k, key: `k${i}` })),
        }));
      }, /more than 1000 keys/);
      bad((c) => {
        const m = c.services[0].metrics[0];
        c.services = Array.from({ length: 6 }, (_, s) => ({
          ...c.services[0],
          service: `s${s}`,
          metrics: Array.from({ length: 200 }, (__, i) => ({ ...m, name: `m${i}` })),
        }));
      }, /more than 1000 metrics/);
      bad((c) => (c.services = Array.from({ length: 501 }, (_, s) => ({ ...c.services[0], service: `s${s}` }))), /more than 500 items/);
    });

    it('accepts empty keys and metric names and drops unknown fields', () => {
      const f = fileOf(withUsage());
      const c = f.snapshot.cardinality;
      c.services[0].keys[0].key = '';
      c.services[0].keys[0].sample = 'leaked value';
      c.services[0].extra = 1;
      const parsed = parseBaselineFile(JSON.stringify(f).replace('"scope"', '"__proto__":{"polluted":true},"scope"')).snapshot.cardinality as any;
      assert.strictEqual(parsed.services[0].keys[0].key, '');
      assert.strictEqual(parsed.services[0].keys[0].sample, undefined);
      assert.strictEqual(parsed.services[0].extra, undefined);
      assert.strictEqual(({} as any).polluted, undefined);
    });
  });
});
