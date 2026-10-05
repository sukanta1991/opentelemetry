// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { SessionImportError, parseSessionFile } from '../../src/views/sessionImport';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] };

function spansRequest(n = 1, attributes: unknown[] = []) {
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            spans: Array.from({ length: n }, (_, i) => ({
              traceId: TRACE,
              spanId: `a00000000000000${i + 1}`,
              name: `s${i}`,
              startTimeUnixNano: '1767268800000000000',
              endTimeUnixNano: '1767268800001000000',
              attributes,
            })),
          },
        ],
      },
    ],
  };
}

const logsRequest = {
  resourceLogs: [
    { resource, scopeLogs: [{ logRecords: [{ timeUnixNano: '1767268800000000000', body: { stringValue: 'hi' } }] }] },
  ],
};

const metricsRequest = {
  resourceMetrics: [
    {
      resource,
      scopeMetrics: [
        { metrics: [{ name: 'g', gauge: { dataPoints: [{ timeUnixNano: '1767268800000000000', asDouble: 1 }] } }] },
      ],
    },
  ],
};

function throwsImport(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof SessionImportError && pattern.test(e.message));
}

describe('parseSessionFile', () => {
  it('reads the session envelope', () => {
    const text = JSON.stringify({
      format: 'otel-session',
      version: 1,
      traces: spansRequest(2),
      logs: logsRequest,
      metrics: metricsRequest,
    });
    const parsed = parseSessionFile(text, 100);
    assert.deepStrictEqual(parsed.counts, { spans: 2, logs: 1, metricPoints: 1 });
    assert.strictEqual(parsed.traces[0].spans.length, 2);
    assert.strictEqual(parsed.logs[0].logs[0].body, 'hi');
    assert.strictEqual(parsed.metrics[0].metrics[0].name, 'g');
    assert.strictEqual(parsed.skipped, 0);
  });

  it('reads a bare OTLP/JSON request', () => {
    const parsed = parseSessionFile(JSON.stringify(spansRequest(3)), 100);
    assert.deepStrictEqual(parsed.counts, { spans: 3, logs: 0, metricPoints: 0 });
    assert.strictEqual(parsed.traces[0].resource.serviceName, 'svc');
  });

  it('reads Collector file-exporter JSON Lines and skips unreadable lines', () => {
    const text = [JSON.stringify(spansRequest()), '{broken', JSON.stringify(logsRequest), '', JSON.stringify({ other: 1 })].join(
      '\n'
    );
    const parsed = parseSessionFile(text, 100);
    assert.deepStrictEqual(parsed.counts, { spans: 1, logs: 1, metricPoints: 0 });
    assert.strictEqual(parsed.skipped, 2);
    assert.match(parsed.skippedSample!, /^line 2:/);
  });

  it('rejects files over the record limit', () => {
    throwsImport(() => parseSessionFile(JSON.stringify(spansRequest(3)), 2), /more than 2 records/);
  });

  it('rejects records with too many attributes', () => {
    const attrs = Array.from({ length: 257 }, (_, i) => ({ key: `k${i}`, value: { intValue: '1' } }));
    throwsImport(() => parseSessionFile(JSON.stringify(spansRequest(1, attrs)), 100), /257 attributes/);
  });

  it('rejects unknown documents, newer formats, empty files and bad shapes', () => {
    throwsImport(() => parseSessionFile('{"logs": []}', 100), /Not an OpenTelemetry session/);
    throwsImport(() => parseSessionFile('[]', 100), /JSON object/);
    throwsImport(() => parseSessionFile('   ', 100), /Not valid JSON/);
    throwsImport(() => parseSessionFile('{"format":"otel-session","version":99}', 100), /newer version/);
    throwsImport(() => parseSessionFile('{"resourceSpans":[]}', 100), /no spans, logs or metric points/);
    throwsImport(() => parseSessionFile('{"resourceSpans":[{"scopeSpans":{}}]}', 100), /scopeSpans: expected an array/);
  });

  it('keeps a "__proto__" attribute as data without touching the prototype', () => {
    const attrs = [{ key: '__proto__', value: { kvlistValue: { values: [{ key: 'polluted', value: { boolValue: true } }] } } }];
    const parsed = parseSessionFile(JSON.stringify(spansRequest(1, attrs)), 100);
    const spanAttrs = parsed.traces[0].spans[0].attrs;
    assert.strictEqual(Object.getPrototypeOf(spanAttrs), Object.prototype);
    assert.ok(Object.prototype.hasOwnProperty.call(spanAttrs, '__proto__'));
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
  });
});
