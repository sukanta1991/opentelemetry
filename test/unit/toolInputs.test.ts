// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS } from '../../src/ai/limits';
import {
  MAX_FIELD_CHARS,
  Parsed,
  parseCompareTracesInput,
  parseFindSpansInput,
  parseGenAiSummaryInput,
  parseGetServiceMapInput,
  parseGetTraceInput,
  parseListServicesInput,
  parseQueryLogsInput,
  parseQueryMetricsInput,
  parseSearchTracesInput,
} from '../../src/ai/toolInputs';
import { MAX_QUERY_LENGTH } from '../../src/views/webview/traceView';

function ok<T>(p: Parsed<T>): T {
  if ('error' in p) assert.fail(`unexpected error: ${p.error}`);
  return p.value;
}

function err<T>(p: Parsed<T>): string {
  if (!('error' in p)) assert.fail(`expected an error, got ${JSON.stringify(p.value)}`);
  return p.error;
}

describe('ai toolInputs', () => {
  describe('shared rules', () => {
    it('rejects non-object input but accepts undefined/null as empty', () => {
      assert.match(err(parseSearchTracesInput('status=error', 25)), /JSON object/);
      assert.match(err(parseSearchTracesInput([1], 25)), /JSON object/);
      assert.strictEqual(ok(parseSearchTracesInput(undefined, 25)).sort, 'recent');
      assert.strictEqual(ok(parseSearchTracesInput(null, 25)).limit, DEFAULT_MAX_ITEMS);
    });

    it('ignores unknown keys', () => {
      const v = ok(parseGetServiceMapInput({ limit: 3, evil: 'x', constructor: 'y' }, 25));
      assert.deepStrictEqual(v, { limit: 3 });
    });

    it('clamps limit to 1…min(HARD_MAX_ITEMS, configured max) and floors it', () => {
      assert.strictEqual(ok(parseQueryMetricsInput({ limit: 0 }, 50)).limit, 1);
      assert.strictEqual(ok(parseQueryMetricsInput({ limit: -5 }, 50)).limit, 1);
      assert.strictEqual(ok(parseQueryMetricsInput({ limit: 1000 }, 50)).limit, 50);
      assert.strictEqual(ok(parseQueryMetricsInput({ limit: 1000 }, 5000)).limit, HARD_MAX_ITEMS);
      assert.strictEqual(ok(parseQueryMetricsInput({ limit: 7.9 }, 50)).limit, 7);
      assert.strictEqual(ok(parseQueryMetricsInput({}, 50)).limit, DEFAULT_MAX_ITEMS);
      assert.strictEqual(ok(parseQueryMetricsInput({}, 10)).limit, 10);
    });

    it('gives an actionable message for a wrong-typed number', () => {
      assert.strictEqual(err(parseQueryMetricsInput({ limit: '10' }, 50)), 'limit must be a number 1–50');
      assert.match(err(parseQueryMetricsInput({ limit: NaN }, 50)), /limit must be a number/);
      assert.match(err(parseQueryMetricsInput({ limit: Infinity }, 50)), /limit must be a number/);
      assert.match(err(parseSearchTracesInput({ minDurationMs: '500ms' }, 25)), /minDurationMs must be a number/);
    });

    it('trims strings, caps length and treats blank as absent', () => {
      const v = ok(parseQueryLogsInput({ service: '  api  ', instanceId: '   ', text: 'x'.repeat(5000) }, 25));
      assert.strictEqual(v.service, 'api');
      assert.strictEqual(v.instanceId, undefined);
      assert.strictEqual(v.text!.length, MAX_QUERY_LENGTH);
      assert.strictEqual(ok(parseQueryLogsInput({ service: 's'.repeat(999) }, 25)).service!.length, MAX_FIELD_CHARS);
      assert.match(err(parseQueryLogsInput({ service: 5 }, 25)), /service must be a string/);
    });

    it('treats null fields as absent', () => {
      const v = ok(parseSearchTracesInput({ status: null, query: null, limit: null }, 25));
      assert.strictEqual(v.status, undefined);
      assert.strictEqual(v.query, undefined);
      assert.strictEqual(v.limit, DEFAULT_MAX_ITEMS);
    });
  });

  describe('parseListServicesInput', () => {
    it('takes no fields', () => {
      assert.deepStrictEqual(ok(parseListServicesInput({ anything: 1 })), {});
      assert.ok('error' in parseListServicesInput(3));
    });
  });

  describe('parseSearchTracesInput', () => {
    it('parses a full valid input', () => {
      assert.deepStrictEqual(
        ok(
          parseSearchTracesInput(
            {
              query: ' status=error dur>500ms ',
              service: 'checkout',
              status: 'ERROR',
              minDurationMs: 250,
              sinceMinutes: 15,
              sort: 'Duration',
              groupBy: 'http.route',
              limit: 10,
            },
            25
          )
        ),
        {
          query: 'status=error dur>500ms',
          service: 'checkout',
          status: 'error',
          minDurationMs: 250,
          sinceMinutes: 15,
          sort: 'duration',
          groupBy: 'http.route',
          limit: 10,
        }
      );
    });

    it('caps the query at MAX_QUERY_LENGTH', () => {
      assert.strictEqual(ok(parseSearchTracesInput({ query: 'q'.repeat(2000) }, 25)).query!.length, MAX_QUERY_LENGTH);
    });

    it('clamps durations and windows', () => {
      const v = ok(parseSearchTracesInput({ minDurationMs: -1, sinceMinutes: 1e9 }, 25));
      assert.strictEqual(v.minDurationMs, 0);
      assert.strictEqual(v.sinceMinutes, 7 * 24 * 60);
      assert.strictEqual(ok(parseSearchTracesInput({ sinceMinutes: 0 }, 25)).sinceMinutes, 1);
    });

    it('rejects unknown enum values with the allowed list', () => {
      assert.strictEqual(err(parseSearchTracesInput({ sort: 'slowest' }, 25)), 'sort must be one of: duration, errors, recent');
      assert.strictEqual(err(parseSearchTracesInput({ status: 'failed' }, 25)), 'status must be one of: error, ok, unset');
      assert.match(err(parseSearchTracesInput({ status: 1 }, 25)), /status must be one of/);
    });
  });

  describe('parseFindSpansInput', () => {
    it('defaults sort and groupBy', () => {
      const v = ok(parseFindSpansInput({}, 25));
      assert.strictEqual(v.sort, 'duration');
      assert.strictEqual(v.groupBy, 'none');
    });

    it('accepts enum values case-insensitively and rejects unknown ones', () => {
      const v = ok(parseFindSpansInput({ sort: 'selftime', groupBy: 'SERVICEANDNAME' }, 25));
      assert.strictEqual(v.sort, 'selfTime');
      assert.strictEqual(v.groupBy, 'serviceAndName');
      assert.match(err(parseFindSpansInput({ groupBy: 'route' }, 25)), /groupBy must be one of: none, service, name, serviceAndName/);
      assert.match(err(parseFindSpansInput({ sort: 'recent' }, 25)), /sort must be one of: duration, selfTime/);
    });
  });

  describe('parseGetTraceInput', () => {
    it('makes everything optional and defaults includeLogs to true', () => {
      assert.deepStrictEqual(ok(parseGetTraceInput({})), { traceId: undefined, spanId: undefined, includeLogs: true });
      assert.strictEqual(ok(parseGetTraceInput({ includeLogs: false })).includeLogs, false);
      assert.match(err(parseGetTraceInput({ includeLogs: 'no' })), /includeLogs must be true or false/);
      assert.match(err(parseGetTraceInput({ traceId: 123 })), /traceId must be a string/);
    });
  });

  describe('parseCompareTracesInput', () => {
    it('requires traceId', () => {
      assert.strictEqual(err(parseCompareTracesInput({})), 'traceId is required');
      assert.strictEqual(err(parseCompareTracesInput({ traceId: '  ' })), 'traceId is required');
      assert.deepStrictEqual(ok(parseCompareTracesInput({ traceId: 'abc', baselineTraceId: 'def' })), {
        traceId: 'abc',
        baselineTraceId: 'def',
      });
    });
  });

  describe('parseQueryLogsInput', () => {
    it('parses severity names case-insensitively', () => {
      assert.strictEqual(ok(parseQueryLogsInput({ minSeverity: 'WARN' }, 25)).minSeverity, 'warn');
      assert.match(
        err(parseQueryLogsInput({ minSeverity: 'warning' }, 25)),
        /minSeverity must be one of: trace, debug, info, warn, error, fatal/
      );
    });

    it('keeps regex-looking text as a plain string', () => {
      assert.strictEqual(ok(parseQueryLogsInput({ text: '.*(a+)+$' }, 25)).text, '.*(a+)+$');
    });
  });

  describe('parseGenAiSummaryInput', () => {
    it('parses traceId and limit', () => {
      assert.deepStrictEqual(ok(parseGenAiSummaryInput({ traceId: ' abc ', limit: 3 }, 25)), { traceId: 'abc', limit: 3 });
    });
  });
});
