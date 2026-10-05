// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { getServiceMap } from '../../src/ai/analysis/serviceMap';
import { createRedactor } from '../../src/ai/redact';
import { parseGetServiceMapInput } from '../../src/ai/toolInputs';
import { TelemetryStore } from '../../src/store/store';
import { T0, addBaselineTraces, addDistributedTrace, addFailingTrace } from './aiFixtures';

const ctx = { now: T0, redactor: createRedactor(), maxItems: 25 };

function run(store: TelemetryStore, raw: Record<string, unknown>): any {
  const input = parseGetServiceMapInput(raw, ctx.maxItems);
  if ('error' in input) throw new Error(input.error);
  return getServiceMap(store, input.value, ctx);
}

describe('ai getServiceMap', () => {
  const store = new TelemetryStore();
  addDistributedTrace(store);
  addBaselineTraces(store);
  addFailingTrace(store);

  it('returns nodes, edges by call count with error rates, and the top error edges', () => {
    const { result, refs } = run(store, {});
    assert.strictEqual(result.nodeCount, 4);
    assert.strictEqual(result.edgeCount, 3);
    assert.deepStrictEqual(
      result.nodes.map((n: any) => n.id),
      ['db:postgresql:shop', 'ext:api.payments.local', 'svc:checkout', 'svc:frontend']
    );
    assert.deepStrictEqual(result.edges, [
      { source: 'svc:checkout', target: 'db:postgresql:shop', count: 31, errors: 0, errorRate: 0 },
      { source: 'svc:frontend', target: 'svc:checkout', count: 31, errors: 0, errorRate: 0 },
      { source: 'svc:checkout', target: 'ext:api.payments.local', count: 1, errors: 1, errorRate: 1 },
    ]);
    assert.deepStrictEqual(
      result.topErrorEdges.map((e: any) => e.target),
      ['ext:api.payments.local']
    );
    assert.deepStrictEqual(refs, []);
  });

  it('caps edges with limit', () => {
    const { result } = run(store, { limit: 1 });
    assert.strictEqual(result.edges.length, 1);
    assert.strictEqual(result.edgeCount, 3);
  });
});
