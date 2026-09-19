import * as assert from 'assert';
import { StoredLogRecord } from '../../src/store/model';
import {
  attributeKeyUnion,
  csvCell,
  defaultExportFileName,
  exportCsv,
  exportOtlpJson,
  exportPlainJson,
  pickNewest,
  toAnyValue,
} from '../../src/views/logExport';

const instance = {
  serviceName: 'svc',
  serviceInstanceId: 'i1',
  resourceAttrs: { 'deployment.environment': 'dev' },
};

function log(seq: number, over: Partial<StoredLogRecord> = {}): StoredLogRecord {
  return {
    seq,
    timeMs: seq * 1000,
    severityNumber: 9,
    severityText: 'INFO',
    body: `m${seq}`,
    attrs: {},
    ...over,
  };
}

describe('export: newest-N selection', () => {
  const rows = [log(1), log(2), log(3), log(4)];

  it('keeps the newest N but emits oldest-first', () => {
    assert.deepStrictEqual(
      pickNewest(rows, 2).map((l) => l.seq),
      [3, 4]
    );
  });

  it('treats 0 as unlimited', () => {
    assert.strictEqual(pickNewest(rows, 0).length, 4);
  });

  it('is a no-op when N exceeds the input', () => {
    assert.strictEqual(pickNewest(rows, 99).length, 4);
  });

  it('orders by timestamp, not arrival', () => {
    const outOfOrder = [log(1, { timeMs: 9000 }), log(2, { timeMs: 1000 })];
    assert.deepStrictEqual(
      pickNewest(outOfOrder, 1).map((l) => l.seq),
      [1]
    );
  });
});

describe('export: OTLP/JSON', () => {
  it('encodes each attribute value type', () => {
    assert.deepStrictEqual(toAnyValue('s'), { stringValue: 's' });
    assert.deepStrictEqual(toAnyValue(true), { boolValue: true });
    assert.deepStrictEqual(toAnyValue(7), { intValue: '7' }, 'int64 is a string in proto3 JSON');
    assert.deepStrictEqual(toAnyValue(1.5), { doubleValue: 1.5 });
    assert.deepStrictEqual(toAnyValue(null), {});
    assert.deepStrictEqual(toAnyValue(['a']), { arrayValue: { values: [{ stringValue: 'a' }] } });
    assert.deepStrictEqual(toAnyValue({ k: 1 }), {
      kvlistValue: { values: [{ key: 'k', value: { intValue: '1' } }] },
    });
  });

  it('keeps nanosecond precision for real timestamps', () => {
    const out = JSON.parse(exportOtlpJson([log(1, { timeMs: 1_700_000_000_123 })], instance));
    const rec = out.resourceLogs[0].scopeLogs[0].logRecords[0];
    assert.strictEqual(rec.timeUnixNano, '1700000000123000000');
    assert.ok(!rec.timeUnixNano.includes('e'), 'must not be exponential');
  });

  it('carries service identity on the resource', () => {
    const out = JSON.parse(exportOtlpJson([log(1)], instance));
    const attrs = out.resourceLogs[0].resource.attributes;
    const byKey = new Map(attrs.map((a: { key: string; value: unknown }) => [a.key, a.value]));
    assert.deepStrictEqual(byKey.get('service.name'), { stringValue: 'svc' });
    assert.deepStrictEqual(byKey.get('service.instance.id'), { stringValue: 'i1' });
    assert.deepStrictEqual(byKey.get('deployment.environment'), { stringValue: 'dev' });
  });

  it('groups records into one scopeLogs entry per scope', () => {
    const out = JSON.parse(
      exportOtlpJson([log(1, { scope: 'a' }), log(2, { scope: 'b' }), log(3, { scope: 'a' })], instance)
    );
    const scopes = out.resourceLogs[0].scopeLogs;
    assert.strictEqual(scopes.length, 2);
    assert.strictEqual(scopes[0].logRecords.length, 2);
  });

  it('omits optional fields that are absent', () => {
    const out = JSON.parse(exportOtlpJson([log(1)], instance));
    const rec = out.resourceLogs[0].scopeLogs[0].logRecords[0];
    assert.ok(!('traceId' in rec));
    assert.ok(!('observedTimeUnixNano' in rec));
  });

  it('preserves code location through its attributes', () => {
    const rec = log(1, {
      attrs: { 'code.filepath': '/a.ts', 'code.lineno': 12 },
      codeLocation: { filepath: '/a.ts', line: 12 },
    });
    const out = JSON.parse(exportOtlpJson([rec], instance));
    const attrs = out.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    assert.ok(attrs.some((a: { key: string }) => a.key === 'code.filepath'));
  });
});

describe('export: plain JSON', () => {
  it('emits a full-fidelity envelope in all-attributes mode', () => {
    const out = JSON.parse(exportPlainJson([log(1, { attrs: { a: 1 } })], instance, 'all', []));
    assert.strictEqual(out.version, 1);
    assert.strictEqual(out.instance.serviceName, 'svc');
    assert.deepStrictEqual(out.logs[0].attributes, { a: 1 });
    assert.strictEqual(out.logs[0].timeMs, 1000, 'numeric time survives for round-trip');
    assert.strictEqual(out.logs[0].time, new Date(1000).toISOString());
  });

  it('emits only the visible columns in grid mode', () => {
    const out = JSON.parse(
      exportPlainJson([log(1)], instance, 'grid', ['time', 'level', 'message'])
    );
    assert.deepStrictEqual(Object.keys(out.logs[0]), ['Time', 'Level', 'Message']);
    assert.strictEqual(out.logs[0].Message, 'm1');
    assert.deepStrictEqual(
      out.columns.map((c: { id: string }) => c.id),
      ['time', 'level', 'message']
    );
  });

  it('never emits the selection checkbox column', () => {
    const out = JSON.parse(exportPlainJson([log(1)], instance, 'grid', ['select', 'message']));
    assert.deepStrictEqual(Object.keys(out.logs[0]), ['Message']);
  });
});

describe('export: CSV', () => {
  it('quotes only when required and doubles inner quotes', () => {
    assert.strictEqual(csvCell('plain'), 'plain');
    assert.strictEqual(csvCell('a,b'), '"a,b"');
    assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(csvCell('line\nbreak'), '"line\nbreak"');
  });

  it('neutralises spreadsheet formula injection', () => {
    assert.strictEqual(csvCell('=1+1'), "'=1+1");
    assert.strictEqual(csvCell('+SUM(A1)'), "'+SUM(A1)");
    assert.strictEqual(csvCell('-2'), "'-2");
    assert.strictEqual(csvCell('@cmd'), "'@cmd");
    assert.strictEqual(csvCell('\tTAB'), "'\tTAB", 'tab is not a CSV delimiter, so no quoting');
  });

  it('does not neutralise a safe leading character', () => {
    assert.strictEqual(csvCell('2024-01-01'), '2024-01-01');
  });

  it('writes a header of column labels in grid mode', () => {
    const csv = exportCsv([log(1)], 'grid', ['time', 'level', 'message']);
    const [header, row] = csv.split('\r\n');
    assert.strictEqual(header, 'Time,Level,Message');
    assert.ok(row.endsWith(',INFO,m1'));
  });

  it('emits the union of attribute keys in all-attributes mode', () => {
    const csv = exportCsv(
      [log(1, { attrs: { a: 1 } }), log(2, { attrs: { b: 2 } })],
      'all',
      []
    );
    const [header, first, second] = csv.split('\r\n');
    assert.ok(header.endsWith('attr.a,attr.b'));
    assert.ok(first.endsWith(',1,'), 'missing keys leave blanks');
    assert.ok(second.endsWith(',,2'));
  });

  it('collects attribute keys in sorted order', () => {
    assert.deepStrictEqual(
      attributeKeyUnion([log(1, { attrs: { z: 1, a: 2 } }), log(2, { attrs: { m: 3 } })]),
      ['a', 'm', 'z']
    );
  });

  it('uses CRLF line endings per RFC 4180', () => {
    assert.ok(exportCsv([log(1)], 'grid', ['message']).includes('\r\n'));
  });
});

describe('export: file names', () => {
  it('uses the right extension per format', () => {
    assert.ok(defaultExportFileName('svc', 'csv').endsWith('.csv'));
    assert.ok(defaultExportFileName('svc', 'otlp').endsWith('.json'));
    assert.ok(defaultExportFileName('svc', 'json').endsWith('.json'));
  });

  it('sanitises the service name', () => {
    const name = defaultExportFileName('my svc/../etc', 'json');
    assert.ok(!name.includes('/'), 'no path separators');
    assert.ok(!name.includes(' '));
    assert.ok(name.startsWith('my_svc_._etc-logs-'));
  });

  it('falls back when the name sanitises to nothing', () => {
    assert.ok(defaultExportFileName('///', 'json').startsWith('_-logs-'));
  });
});
