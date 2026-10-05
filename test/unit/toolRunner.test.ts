// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { AiSettings } from '../../src/ai/aiSettings';
import { MAX_RESULT_CHARS } from '../../src/ai/limits';
import { REDACTED } from '../../src/ai/redact';
import { TOOL_NAMES } from '../../src/ai/toolNames';
import { DISABLED_MESSAGE, ToolDeps, ToolInputError, describeInvocation, escapeMarkdown, runTool } from '../../src/ai/toolRunner';
import { TelemetryStore } from '../../src/store/store';
import {
  AGENT_CONTENT,
  DIST_TRACE,
  SECRET_BEARER,
  SECRET_KEY,
  T0,
  addAgentTrace,
  addBaselineTraces,
  addDistributedTrace,
  addFailingTrace,
  addLogs,
  addMetrics,
  addTraceLogs,
  log,
} from './aiFixtures';

const enabled: AiSettings = { enabled: true, redactAttributeKeys: [], maxResultItems: 25 };

function build(): TelemetryStore {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addTraceLogs(store);
  addFailingTrace(store);
  addAgentTrace(store);
  addBaselineTraces(store);
  addMetrics(store);
  return store;
}

describe('ai toolRunner', () => {
  const store = build();
  const deps = (over: Partial<ToolDeps> = {}): ToolDeps => ({
    store,
    settings: enabled,
    receiverRunning: true,
    now: T0 + 120_000,
    ...over,
  });

  it('refuses to run when AI access is disabled', () => {
    assert.throws(() => runTool('otel_listServices', {}, deps({ settings: { ...enabled, enabled: false } })), {
      message: DISABLED_MESSAGE,
    });
  });

  it('rejects invalid input with a message the model can act on', () => {
    assert.throws(
      () => runTool('otel_searchTraces', { limit: 'ten' }, deps()),
      (e: unknown) => e instanceof ToolInputError && e.message === 'Invalid input for otel_searchTraces: limit must be a number 1–25'
    );
    assert.throws(() => runTool('otel_compareTraces', {}, deps()), /traceId is required/);
  });

  it('checks for cancellation after validation and before running, without wrapping the error', () => {
    const calls: string[] = [];
    class Cancelled extends Error {}
    const throwing = {
      getAllInstances: () => {
        calls.push('store');
        return [];
      },
    } as unknown as TelemetryStore;
    assert.throws(
      () =>
        runTool('otel_listServices', {}, deps({
          store: throwing,
          checkCancelled: () => {
            calls.push('check');
            throw new Cancelled('cancelled');
          },
        })),
      Cancelled
    );
    assert.deepStrictEqual(calls, ['check']);
    assert.throws(() => runTool('otel_searchTraces', { sort: 'bad' }, deps({ checkCancelled: () => calls.push('late') })), ToolInputError);
    assert.deepStrictEqual(calls, ['check'], 'invalid input fails before the cancellation check');
  });

  it('wraps unexpected failures without a stack trace', () => {
    const broken = {
      getAllInstances: () => {
        throw new Error('boom\n    at secret/path.ts:1');
      },
    } as unknown as TelemetryStore;
    assert.throws(() => runTool('otel_listServices', {}, deps({ store: broken })), (e: unknown) => {
      const msg = (e as Error).message;
      return msg.startsWith('otel tool failed: boom') && !msg.includes('\n');
    });
  });

  for (const name of TOOL_NAMES) {
    it(`${name}: returns bounded, redacted JSON with refs`, () => {
      const input = name === 'otel_compareTraces' ? { traceId: DIST_TRACE } : name === 'otel_queryMetrics' ? { name: 'http.server.requests' } : {};
      const run = runTool(name, input, deps());
      assert.ok(run.json.length <= MAX_RESULT_CHARS);
      const parsed = JSON.parse(run.json);
      assert.ok(!('error' in parsed), `${name}: ${parsed.error}`);
      assert.ok(Array.isArray(parsed.refs));
      for (const secret of [SECRET_BEARER.slice(7), SECRET_KEY, 'hunter2', 'tok_secret', ...AGENT_CONTENT]) {
        assert.ok(!run.json.includes(secret), `${name} leaked ${secret}`);
      }
    });
  }

  it('reports item counts and truncation', () => {
    const big = new TelemetryStore();
    addLogs(big, 'svc', Array.from({ length: 200 }, (_, i) => log({ timeMs: T0 + i, body: `line ${i} ${'z'.repeat(400)}` })));
    const run = runTool('otel_queryLogs', { limit: 200 }, deps({ store: big, settings: { ...enabled, maxResultItems: 200 } }));
    assert.strictEqual(run.truncated, true);
    assert.ok(run.itemCount > 0 && run.itemCount < 200);
    assert.strictEqual(JSON.parse(run.json).omitted, 200 - run.itemCount);
    assert.strictEqual(run.inputSummary, 'limit=200');
  });

  it('applies the configured extra redaction keys and item cap', () => {
    const run = runTool('otel_findSpans', { query: 'http.route=/checkout', limit: 100 }, deps({
      settings: { ...enabled, redactAttributeKeys: ['http.route'], maxResultItems: 3 },
    }));
    const spans = JSON.parse(run.json).spans;
    assert.strictEqual(spans.length, 3);
    assert.ok(spans.every((s: any) => s.attrs['http.route'] === REDACTED));
  });

  it('passes analysis errors through as JSON the model can read', () => {
    const run = runTool('otel_getTrace', { traceId: 'f'.repeat(32) }, deps());
    assert.match(JSON.parse(run.json).error, /evicted/);
  });

  describe('describeInvocation', () => {
    it('summarizes the call and states what is sent', () => {
      const text = describeInvocation('otel_searchTraces', { query: 'status=error', limit: 10 }, { ...enabled, redactAttributeKeys: ['a', 'b'] });
      assert.strictEqual(text.title, 'Send OpenTelemetry data to the model?');
      assert.strictEqual(text.invocationMessage, 'Searching traces: query=status=error, sort=recent, limit=10');
      assert.match(text.message, /\*\*Search OpenTelemetry Traces\*\* \(`otel_searchTraces`\)/);
      assert.match(text.message, /language model selected in chat/);
      assert.match(text.message, /up to 10 items, at most 24,000 characters/);
      assert.match(text.message, /Secrets are redacted before sending, including 2 extra key\(s\)/);
      assert.strictEqual(describeInvocation('otel_listServices', {}, enabled).invocationMessage, 'Listing OpenTelemetry services');
    });

    it('escapes and cuts model-controlled input', () => {
      const hostile = `[click](command:otel.clear) <img src=x> ${'a'.repeat(500)}\nnext`;
      const text = describeInvocation('otel_queryLogs', { text: hostile }, enabled);
      assert.ok(!text.message.includes('[click](command:'), text.message);
      assert.ok(text.message.includes('\\<img'), 'angle brackets are escaped');
      assert.ok(text.invocationMessage.length <= 200);
      assert.ok(!text.invocationMessage.includes('\n'));
      assert.strictEqual(escapeMarkdown('a*b_[c](d)'), 'a\\*b\\_\\[c\\]\\(d\\)');
    });

    it('still describes invalid input', () => {
      const text = describeInvocation('otel_searchTraces', { limit: 'x' }, enabled);
      assert.match(text.message, /Input: limit=x/);
    });
  });
});
