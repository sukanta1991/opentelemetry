// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Snapshot } from '../../src/views/baseline';
import {
  BASELINE_FORMAT,
  BaselineFileError,
  MAX_BASELINE_FILE_BYTES,
  parseBaselineFile,
  sanitizeBaselineName,
  serializeBaseline,
} from '../../src/views/baselineFile';
import { T0 } from './aiFixtures';
import { apiCalls, capture, tid } from './baselineFixtures';

const sample = (): Snapshot => capture(apiCalls(Array.from({ length: 30 }, (_, i) => ({ endMs: T0 + i, ms: 5 + (i % 4), dbMs: 2, error: i === 3 }))));
const fileOf = (snapshot = sample()) => JSON.parse(serializeBaseline({ name: 'main', createdMs: T0, snapshot }));

function rejects(mutate: (f: any) => void, message: RegExp): void {
  const f = fileOf();
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
      ['{"format":"otel-baseline","version":2}', /newer version/],
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
});
