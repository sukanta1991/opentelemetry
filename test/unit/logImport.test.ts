import * as assert from 'assert';
import { StoredLogRecord } from '../../src/store/model';
import { exportOtlpJson, exportPlainJson } from '../../src/views/logExport';
import {
  LogImportError,
  detectFormat,
  parseLogFile,
  parseOtlpJson,
  parsePlainJson,
} from '../../src/views/logImport';

const instance = {
  serviceName: 'svc',
  serviceInstanceId: 'i1',
  resourceAttrs: { 'deployment.environment': 'dev' },
};

function log(seq: number, over: Partial<StoredLogRecord> = {}): StoredLogRecord {
  return {
    seq,
    timeMs: 1_700_000_000_000 + seq,
    severityNumber: 9,
    severityText: 'INFO',
    body: `m${seq}`,
    attrs: {},
    ...over,
  };
}

function otlpDoc(records: unknown[]): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeLogs: [{ scope: { name: 'app' }, logRecords: records }],
      },
    ],
  };
}

describe('import: format detection', () => {
  it('recognises both supported shapes', () => {
    assert.strictEqual(detectFormat({ resourceLogs: [] }), 'otlp');
    assert.strictEqual(detectFormat({ logs: [] }), 'plain');
  });

  it('rejects anything else', () => {
    assert.strictEqual(detectFormat({}), 'unknown');
    assert.strictEqual(detectFormat([]), 'unknown');
    assert.strictEqual(detectFormat(null), 'unknown');
    assert.strictEqual(detectFormat('a,b\n1,2'), 'unknown', 'CSV is not importable');
  });
});

describe('import: OTLP/JSON', () => {
  it('converts nanosecond timestamps without losing precision', () => {
    const out = parseOtlpJson(
      otlpDoc([{ timeUnixNano: '1700000000123000000', body: { stringValue: 'x' } }])
    );
    assert.strictEqual(out.logs[0].timeMs, 1_700_000_000_123);
  });

  it('reads resource identity and scope', () => {
    const out = parseOtlpJson(otlpDoc([{ timeUnixNano: '1', body: { stringValue: 'x' } }]));
    assert.strictEqual(out.serviceName, 'svc');
    assert.strictEqual(out.logs[0].scope, 'app');
  });

  it('decodes every AnyValue variant', () => {
    const out = parseOtlpJson(
      otlpDoc([
        {
          timeUnixNano: '1',
          body: { stringValue: 'b' },
          attributes: [
            { key: 's', value: { stringValue: 'x' } },
            { key: 'i', value: { intValue: '42' } },
            { key: 'd', value: { doubleValue: 1.5 } },
            { key: 'b', value: { boolValue: true } },
            { key: 'arr', value: { arrayValue: { values: [{ stringValue: 'a' }] } } },
            { key: 'kv', value: { kvlistValue: { values: [{ key: 'n', value: { intValue: '1' } }] } } },
          ],
        },
      ])
    );
    assert.deepStrictEqual(out.logs[0].attrs, {
      s: 'x',
      i: 42,
      d: 1.5,
      b: true,
      arr: ['a'],
      kv: { n: 1 },
    });
  });

  it('clamps an out-of-range severity', () => {
    const out = parseOtlpJson(otlpDoc([{ timeUnixNano: '1', severityNumber: 999 }]));
    assert.strictEqual(out.logs[0].severityNumber, 24);
    const low = parseOtlpJson(otlpDoc([{ timeUnixNano: '1', severityNumber: -5 }]));
    assert.strictEqual(low.logs[0].severityNumber, 0);
  });

  it('falls back to the observed time when the record has none', () => {
    const out = parseOtlpJson(otlpDoc([{ observedTimeUnixNano: '5000000' }]));
    assert.strictEqual(out.logs[0].timeMs, 5);
  });

  it('rejects a malformed timestamp', () => {
    assert.throws(() => parseOtlpJson(otlpDoc([{ timeUnixNano: 'soon' }])), LogImportError);
  });

  it('reports the path of the offending field', () => {
    assert.throws(
      () => parseOtlpJson(otlpDoc(['not-an-object'])),
      /resourceLogs\[0\]\.scopeLogs\[0\]\.logRecords\[0\]: expected an object/
    );
  });

  it('rejects an empty document', () => {
    assert.throws(() => parseOtlpJson({ resourceLogs: [] }), LogImportError);
  });
});

describe('import: plain JSON', () => {
  it('accepts numeric and ISO timestamps', () => {
    assert.strictEqual(parsePlainJson({ logs: [{ timeMs: 1234 }] }).logs[0].timeMs, 1234);
    assert.strictEqual(
      parsePlainJson({ logs: [{ time: '1970-01-01T00:00:01.000Z' }] }).logs[0].timeMs,
      1000
    );
  });

  it('preserves code location', () => {
    const out = parsePlainJson({
      logs: [{ timeMs: 1, codeLocation: { filepath: '/a.ts', line: 7, function: 'run' } }],
    });
    assert.deepStrictEqual(out.logs[0].codeLocation, {
      filepath: '/a.ts',
      line: 7,
      column: undefined,
      function: 'run',
    });
  });

  it('drops a code location with no filepath', () => {
    assert.strictEqual(parsePlainJson({ logs: [{ timeMs: 1, codeLocation: {} }] }).logs[0].codeLocation, undefined);
  });

  it('rejects a grid-columns export with actionable guidance', () => {
    assert.throws(
      () => parsePlainJson({ columns: [{ id: 'time' }], logs: [{ Time: 'x' }] }),
      /Re-export with "All attributes"/
    );
  });

  it('rejects a non-numeric line number', () => {
    assert.throws(
      () => parsePlainJson({ logs: [{ timeMs: 1, codeLocation: { filepath: '/a', line: 'x' } }] }),
      /logs\[0\]\.codeLocation\.line: expected a number/
    );
  });

  it('rejects a bad ISO timestamp', () => {
    assert.throws(() => parsePlainJson({ logs: [{ time: 'nope' }] }), LogImportError);
  });
});

describe('import: hostile input', () => {
  const polluting = ['__proto__', 'prototype', 'constructor'];

  it('rejects prototype-polluting keys in attributes', () => {
    for (const key of polluting) {
      assert.throws(
        () => parsePlainJson({ logs: [{ timeMs: 1, attributes: { [key]: 1 } }] }),
        new RegExp(`key "${key.replace(/[$]/g, '')}" is not allowed`),
        `${key} must be rejected`
      );
    }
  });

  it('rejects prototype-polluting OTLP attribute keys', () => {
    assert.throws(
      () => parseOtlpJson(otlpDoc([{ timeUnixNano: '1', attributes: [{ key: '__proto__', value: { intValue: '1' } }] }])),
      /is not allowed/
    );
  });

  it('does not leak onto Object.prototype', () => {
    try {
      parseLogFile('{"logs":[{"timeMs":1,"attributes":{"__proto__":{"polluted":true}}}]}', 10);
    } catch {
      /* expected */
    }
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
  });

  it('caps attributes per record', () => {
    const attributes: Record<string, number> = {};
    for (let i = 0; i < 300; i++) attributes[`k${i}`] = i;
    assert.throws(
      () => parsePlainJson({ logs: [{ timeMs: 1, attributes }] }),
      /exceeds the 256 per-record limit/
    );
  });

  it('rejects invalid JSON with a clear message', () => {
    assert.throws(() => parseLogFile('{oops', 10), /Not valid JSON/);
  });

  it('rejects an unrecognised document', () => {
    assert.throws(() => parseLogFile('{"a":1}', 10), /Unrecognised file/);
  });

  it('enforces the record cap', () => {
    const logs = Array.from({ length: 5 }, (_, i) => ({ timeMs: i }));
    assert.throws(() => parseLogFile(JSON.stringify({ logs }), 3), /above the 3 limit/);
    assert.strictEqual(parseLogFile(JSON.stringify({ logs }), 5).logs.length, 5);
  });

  it('rejects a file with no records', () => {
    assert.throws(() => parseLogFile('{"logs":[]}', 10), /no log records/);
  });
});

describe('import: trace and span ids', () => {
  const TRACE = '6ab125bfce546e3cb5c05f5c14b3a576';
  const SPAN = '57cff879f5b93ff7';

  it('canonicalises W3C ids from JSON Lines', () => {
    const line = JSON.stringify({ message: 'x', trace_id: TRACE.toUpperCase(), span_id: `0x${SPAN}` });
    const l = parseLogFile(line, 10).logs[0];
    assert.strictEqual(l.traceId, TRACE);
    assert.strictEqual(l.spanId, SPAN);
  });

  it('canonicalises dashed ids from plain JSON and OTLP/JSON', () => {
    const dashed = '6ab125bf-ce54-6e3c-b5c0-5f5c14b3a576';
    assert.strictEqual(parsePlainJson({ logs: [{ timeMs: 1, traceId: dashed }] }).logs[0].traceId, TRACE);
    assert.strictEqual(
      parseOtlpJson(otlpDoc([{ timeUnixNano: '1', traceId: dashed, spanId: SPAN.toUpperCase() }])).logs[0].spanId,
      SPAN
    );
  });

  it('drops all-zero and blank ids', () => {
    const l = parsePlainJson({ logs: [{ timeMs: 1, traceId: '0'.repeat(32), spanId: '  ' }] }).logs[0];
    assert.strictEqual(l.traceId, undefined);
    assert.strictEqual(l.spanId, undefined);
  });

  it('keeps unrecognised vendor formats verbatim', () => {
    const xray = '1-5759e988-bd862e3fe1be46a994272793';
    assert.strictEqual(parsePlainJson({ logs: [{ timeMs: 1, traceId: xray }] }).logs[0].traceId, xray);
  });
});

describe('import: round-trips an export', () => {
  const original = log(1, {
    observedTimeMs: 1_700_000_000_500,
    severityNumber: 17,
    severityText: 'ERROR',
    body: 'boom',
    attrs: { 'http.method': 'GET', retries: 3, ok: false, tags: ['a', 'b'], nested: { x: 1 } },
    traceId: 'abc123',
    spanId: 'def456',
    scope: 'my.scope',
    codeLocation: { filepath: '/src/a.ts', line: 12, column: 4, function: 'run' },
  });

  it('preserves every field through plain JSON', () => {
    const out = parseLogFile(exportPlainJson([original], instance, 'all', []), 100);
    const got = out.logs[0];
    assert.strictEqual(out.serviceName, 'svc');
    assert.strictEqual(out.serviceInstanceId, 'i1');
    assert.deepStrictEqual(out.resourceAttrs, instance.resourceAttrs);
    assert.strictEqual(got.timeMs, original.timeMs);
    assert.strictEqual(got.observedTimeMs, original.observedTimeMs);
    assert.strictEqual(got.severityNumber, 17);
    assert.strictEqual(got.severityText, 'ERROR');
    assert.strictEqual(got.body, 'boom');
    assert.deepStrictEqual(got.attrs, original.attrs);
    assert.strictEqual(got.traceId, 'abc123');
    assert.strictEqual(got.spanId, 'def456');
    assert.strictEqual(got.scope, 'my.scope');
    assert.deepStrictEqual(got.codeLocation, original.codeLocation);
  });

  it('preserves the wire-representable fields through OTLP/JSON', () => {
    const out = parseLogFile(exportOtlpJson([original], instance), 100);
    const got = out.logs[0];
    assert.strictEqual(out.serviceName, 'svc');
    assert.strictEqual(got.timeMs, original.timeMs);
    assert.strictEqual(got.observedTimeMs, original.observedTimeMs);
    assert.strictEqual(got.severityNumber, 17);
    assert.strictEqual(got.body, 'boom');
    assert.deepStrictEqual(got.attrs, original.attrs);
    assert.strictEqual(got.traceId, 'abc123');
    assert.strictEqual(got.scope, 'my.scope');
  });

  it('round-trips a structured body', () => {
    const structured = log(2, { body: { a: 1, b: ['x'] } });
    const out = parseLogFile(exportPlainJson([structured], instance, 'all', []), 100);
    assert.deepStrictEqual(out.logs[0].body, { a: 1, b: ['x'] });
  });

  it('keeps multiple scopes separate through OTLP', () => {
    const out = parseLogFile(
      exportOtlpJson([log(1, { scope: 'a' }), log(2, { scope: 'b' })], instance),
      100
    );
    assert.deepStrictEqual(
      out.logs.map((l) => l.scope),
      ['a', 'b']
    );
  });
});

describe('import: JSON Lines', () => {
  // Shape of a real vendor archive export: payload, labels and metadata in separate branches.
  function vendorLine(over: { message?: string; severity?: string; timestamp?: number } = {}): string {
    return JSON.stringify({
      $d: {
        cx_metadata: {
          cloud_provider: 'aws',
          cloud_region: 'us-west-2',
          faas_name: 'job-aggregator',
          span_id: '57cff879f5b93ff7',
          trace_id: '6ab125bfce546e3cb5c05f5c14b3a576',
        },
        message: over.message ?? 'fail: Archer.JobEngine.Aggregator.Program[0]\n      boom',
      },
      $l: {
        applicationname: 'us-west-2-service-dev-job-aggregator',
        category: null,
        computername: '',
        subsystemname: 'usw2-sdev-job-aggregator',
      },
      $m: {
        ingressTimestamp: 1_789_994_461_583_000_000,
        logid: '971068aa-ff50-4b51-9b10-c7ac14d43f3f',
        severity: over.severity ?? 'Error',
        timestamp: over.timestamp ?? 1_789_994_431_659_000_000,
        timestampMicros: 1_789_994_431_659_000,
      },
    });
  }

  it('maps a nested vendor export onto log records', () => {
    const out = parseLogFile(`${vendorLine()}\n${vendorLine()}\n`, 100);
    assert.strictEqual(out.logs.length, 2);

    const l = out.logs[0];
    assert.strictEqual(l.timeMs, 1_789_994_431_659, 'nanosecond epoch scaled to ms');
    assert.strictEqual(l.observedTimeMs, 1_789_994_461_583, 'ingress timestamp is observed time');
    assert.strictEqual(l.severityNumber, 17);
    assert.strictEqual(l.severityText, 'Error');
    assert.strictEqual(l.body, 'fail: Archer.JobEngine.Aggregator.Program[0]\n      boom');
    assert.strictEqual(l.traceId, '6ab125bfce546e3cb5c05f5c14b3a576');
    assert.strictEqual(l.spanId, '57cff879f5b93ff7');
    assert.strictEqual(out.serviceName, 'us-west-2-service-dev-job-aggregator');
    assert.strictEqual(out.resourceAttrs['service.name'], 'us-west-2-service-dev-job-aggregator');
  });

  it('keeps unclaimed fields as attributes under their full path', () => {
    const out = parseLogFile(vendorLine(), 100);
    const attrs = out.logs[0].attrs;
    assert.strictEqual(attrs['$d.cx_metadata.cloud_region'], 'us-west-2');
    assert.strictEqual(attrs['$m.logid'], '971068aa-ff50-4b51-9b10-c7ac14d43f3f');
    assert.ok(!('$d.message' in attrs), 'consumed fields are not duplicated into attrs');
    assert.ok(!('$l.category' in attrs), 'null placeholders are dropped');
    assert.ok(!('$l.computername' in attrs), 'empty placeholders are dropped');
  });

  it('detects the timestamp unit from its magnitude', () => {
    const at = (timestamp: number | string): number =>
      parseLogFile(JSON.stringify({ timestamp, message: 'x' }), 10).logs[0].timeMs;
    assert.strictEqual(at(1_789_994_431), 1_789_994_431_000, 'seconds');
    assert.strictEqual(at(1_789_994_431_659), 1_789_994_431_659, 'milliseconds');
    assert.strictEqual(at(1_789_994_431_659_000), 1_789_994_431_659, 'microseconds');
    assert.strictEqual(at('1789994431659000000'), 1_789_994_431_659, 'nanoseconds as a string');
    assert.strictEqual(at('2026-09-21T12:40:31.659Z'), 1_789_994_431_659, 'ISO-8601');
  });

  it('does not mistake a near-miss key for the timestamp', () => {
    const out = parseLogFile(
      JSON.stringify({ timestampMicros: 1_789_994_431_659_000, timestamp: 1_700_000_000_000, msg: 'x' }),
      10
    );
    assert.strictEqual(out.logs[0].timeMs, 1_700_000_000_000);
  });

  it('falls back to the log-line prefix when no severity field exists', () => {
    const out = parseLogFile(JSON.stringify({ message: 'warn: Something[0]\n  odd' }), 10);
    assert.strictEqual(out.logs[0].severityNumber, 13);
    assert.strictEqual(out.logs[0].severityText, 'WARN');
  });

  it('skips unreadable lines and reports the count', () => {
    const out = parseLogFile(`${vendorLine()}\nnot json\n[]\n${vendorLine()}\n`, 100);
    assert.strictEqual(out.logs.length, 2);
    assert.strictEqual(out.skipped, 2);
    assert.ok(out.skippedSample?.startsWith('line 2:'));
  });

  it('fails when no line can be read', () => {
    assert.throws(() => parseLogFile('{oops}\n{also oops}\n', 100), LogImportError);
  });

  it('rejects a file above the record limit', () => {
    const text = `${vendorLine()}\n${vendorLine()}\n${vendorLine()}\n`;
    assert.throws(() => parseLogFile(text, 2), /more than 2 records/);
  });

  it('refuses prototype-polluting keys without aborting the import', () => {
    // Written as raw text: an object literal would set the prototype instead of an own key.
    const hostile = '{"message":"x","nested":{"__proto__":{"polluted":true}}}';
    const out = parseLogFile(`${hostile}\n${vendorLine()}\n`, 100);
    assert.strictEqual(out.skipped, 1);
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
  });

  it('refuses over-deep nesting without recursing away the stack', () => {
    let deep: Record<string, unknown> = { message: 'x' };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const out = parseLogFile(`${JSON.stringify(deep)}\n${vendorLine()}\n`, 100);
    assert.strictEqual(out.skipped, 1);
    assert.strictEqual(out.logs.length, 1);
  });

  it('ignores blank lines and a leading byte-order mark', () => {
    const out = parseLogFile(`\uFEFF${vendorLine()}\n\n\n${vendorLine()}\n`, 100);
    assert.strictEqual(out.logs.length, 2);
    assert.strictEqual(out.skipped, 0);
  });

  it('leaves the single-document formats alone', () => {
    assert.strictEqual(parseLogFile(exportOtlpJson([log(1)], instance), 100).skipped, undefined);
    assert.strictEqual(
      parseLogFile(exportPlainJson([log(1)], instance, 'all', []), 100).skipped,
      undefined
    );
  });
});
