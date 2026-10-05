// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { queryLogs } from '../../src/ai/analysis/logs';
import { REDACTED, createRedactor } from '../../src/ai/redact';
import { parseQueryLogsInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import { DB_SPAN, DIST_TRACE, T0, addLogs, addTraceLogs, log } from './aiFixtures';

const ctx = { now: T0 + 3_600_000, redactor: createRedactor(), maxItems: 50 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseQueryLogsInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return queryLogs(store, input.value, ctx);
}

function build(): { store: TelemetryStore; importedId: string } {
  const store = new TelemetryStore();
  addTraceLogs(store);
  addLogs(store, 'checkout', [
    log({ timeMs: T0 + 2000, severityNumber: 5, severityText: 'DEBUG', body: 'cache miss' }),
    log({
      timeMs: T0 + 3000,
      severityNumber: 17,
      severityText: 'ERROR',
      body: 'regex-looking text .* in message',
      attrs: { 'user.password': 'pw', 'http.route': '/pay', 'gen_ai.prompt': 'hidden' },
      codeLocation: { filepath: '/srv/checkout/pay.py', line: 42 },
    }),
  ]);
  const importedId = store.importLogs({
    serviceName: 'batch',
    resourceAttrs: {},
    logs: [log({ timeMs: T0 - 5000, body: 'imported line' })],
    sourceLabel: 'batch.log',
  });
  return { store, importedId };
}

describe('ai queryLogs', () => {
  const { store, importedId } = build();

  it('returns all logs newest first with totals and severity counts', () => {
    const { result } = run(store, {});
    assert.strictEqual(result.totalMatched, 8);
    assert.strictEqual(result.instances, 3);
    assert.deepStrictEqual(result.severityCounts, { INFO: 5, WARN: 1, ERROR: 1, DEBUG: 1 });
    const times = result.logs.map((l: any) => Date.parse(l.time));
    assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
    assert.strictEqual(result.logs[0].body, 'regex-looking text .* in message');
  });

  it('applies a severity floor', () => {
    assert.deepStrictEqual(
      run(store, { minSeverity: 'warn' }).result.logs.map((l: any) => l.severity),
      ['ERROR', 'WARN']
    );
  });

  it('treats text as a literal, case-insensitive substring', () => {
    assert.deepStrictEqual(
      run(store, { text: '.*' }).result.logs.map((l: any) => l.body),
      ['regex-looking text .* in message']
    );
    assert.strictEqual(run(store, { text: 'CACHE MISS' }).result.totalMatched, 1);
    assert.strictEqual(run(store, { text: 'c.che' }).result.totalMatched, 0);
  });

  it('filters by trace and span', () => {
    assert.strictEqual(run(store, { traceId: DIST_TRACE }).result.totalMatched, 4);
    assert.strictEqual(run(store, { traceId: DIST_TRACE.toUpperCase(), spanId: DB_SPAN }).result.totalMatched, 2);
    assert.match(run(store, { spanId: 'xyz' }).result.error, /spanId/);
  });

  it('filters by instance and service', () => {
    assert.strictEqual(run(store, { service: 'FRONTEND' }).result.totalMatched, 1);
    assert.strictEqual(run(store, { instanceId: 'checkout::i1' }).result.totalMatched, 6);
    assert.match(run(store, { instanceId: 'nope' }).result.error, /instance "nope" not found; known instances: .*checkout::i1/);
    assert.match(run(store, { service: 'nope' }).result.error, /known services: batch, checkout, frontend/);
  });

  it('includes imported instances', () => {
    const { result } = run(store, { text: 'imported' });
    assert.strictEqual(result.logs.length, 1);
    assert.strictEqual(result.logs[0].instanceId, importedId);
    assert.strictEqual(result.logs[0].service, 'batch');
  });

  it('applies the sinceMinutes window', () => {
    const recent = new TelemetryStore();
    addLogs(recent, 'svc', [log({ timeMs: ctx.now - 30_000, body: 'new' }), log({ timeMs: ctx.now - 300_000, body: 'old' })]);
    assert.deepStrictEqual(
      run(recent, { sinceMinutes: 1 }).result.logs.map((l: any) => l.body),
      ['new']
    );
  });

  it('redacts bodies and attributes and drops GenAI content', () => {
    const { result } = run(store, { minSeverity: 'warn' });
    const [error, warn] = result.logs;
    assert.deepStrictEqual(error.attrs, { 'http.route': '/pay', 'user.password': REDACTED });
    assert.strictEqual(warn.body, `slow query, dsn postgres://app:${REDACTED}@db:5432/shop`);
    assert.ok(!JSON.stringify(result).includes('hidden'));
    assert.ok(Number.isInteger(warn.seq));
    assert.strictEqual(warn.traceId, DIST_TRACE);
  });

  it('emits logs refs per distinct trace/span with focusSeq, plus a source ref', () => {
    const { result, refs } = run(store, {});
    const logsRefs = refs.filter((r: any) => r.kind === 'logs');
    assert.ok(logsRefs.length <= 5);
    assert.deepStrictEqual(
      logsRefs.map((r: any) => [r.spanId, r.instanceId]),
      [
        [DB_SPAN, 'checkout::i1'],
        ['b000000000000001', 'checkout::i1'],
        ['a000000000000001', 'frontend::i1'],
      ]
    );
    const warn = result.logs.find((l: any) => l.severity === 'WARN');
    assert.strictEqual(logsRefs[0].focusSeq, warn.seq, 'newest log of the span is focused');
    assert.deepStrictEqual(refs.at(-1), {
      kind: 'source',
      traceId: undefined,
      spanId: undefined,
      code: { filepath: '/srv/checkout/pay.py', line: 42, column: undefined, function: undefined },
      label: 'pay.py:42',
    });
  });
});
