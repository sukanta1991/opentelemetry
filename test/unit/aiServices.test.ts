// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { listServices } from '../../src/ai/analysis/services';
import { createRedactor } from '../../src/ai/redact';
import { TelemetryStore } from '../../src/store/store';
import { T0, addDistributedTrace, addTraceLogs, log } from './aiFixtures';

const ctx = { now: T0 + 3_600_000, redactor: createRedactor(), maxItems: 25, receiverRunning: true };

describe('ai listServices', () => {
  it('lists applications, instances and held totals, including imported instances', () => {
    const store = new TelemetryStore();
    addDistributedTrace(store);
    addTraceLogs(store);
    store.importLogs({
      serviceName: 'checkout',
      resourceAttrs: {},
      logs: [log({ timeMs: T0, body: 'from file' })],
      sourceLabel: 'app.log',
    });
    const { result, refs } = listServices(store, {}, ctx);
    const r = result as any;
    assert.strictEqual(r.receiverRunning, true);
    assert.deepStrictEqual(r.totals, { applications: 2, instances: 3, traces: 1, logs: 6, metrics: 0 });
    assert.deepStrictEqual(
      r.applications.map((a: any) => [a.name, a.instanceCount]),
      [
        ['checkout', 2],
        ['frontend', 1],
      ]
    );
    const checkout = r.applications[0].instances;
    const live = checkout.find((i: any) => i.kind === 'live');
    const imported = checkout.find((i: any) => i.kind === 'imported');
    assert.strictEqual(live.id, 'checkout::i1');
    assert.strictEqual(live.spanCount, 2);
    assert.strictEqual(live.traceCount, 1);
    assert.strictEqual(live.logCount, 4);
    assert.match(live.firstSeen, /^\d{4}-\d\d-\d\dT/);
    assert.strictEqual(live.imported, undefined);
    assert.strictEqual(imported.imported, true);
    assert.strictEqual(imported.source, 'app.log');
    assert.deepStrictEqual(refs, []);
  });

  it('handles an empty store', () => {
    const { result } = listServices(new TelemetryStore(), {}, { ...ctx, receiverRunning: false });
    assert.deepStrictEqual(result, {
      receiverRunning: false,
      totals: { applications: 0, instances: 0, traces: 0, logs: 0, metrics: 0 },
      applications: [],
    });
  });
});
