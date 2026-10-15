// SPDX-License-Identifier: Apache-2.0
// Shared fixture and timing helpers for the service map and baseline performance tests.
import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import { quantile } from '../../src/views/webview/stats';
import { T0 } from './aiFixtures';

export const SERVICES = 10;
export const TRACES = 2000;
export const SPANS_PER_SERVICE = 10;
const RUNS = 10;
const WARMUP_RUNS = 2;
// Budgets are dev-machine targets; shared CI runners (notably 3-vCPU macOS) are several times slower.
export const CI_FACTOR = process.env.CI ? 2 : 1;

// Every trace crosses all services (svc0 -> svc1 -> ...), so retention holds 10 x 2000 x 10 = 200k spans.
// `routes` sets how many distinct entry operations each service sees.
export function fillServiceMapStore(routes = 7): TelemetryStore {
  const store = new TelemetryStore(10, TRACES);
  for (let s = 0; s < SERVICES; s++) {
    const spans: Span[] = [];
    for (let t = 0; t < TRACES; t++) {
      const traceId = (t + 1).toString(16).padStart(32, '0');
      const start = T0 + t * 50 + s;
      for (let k = 0; k < SPANS_PER_SERVICE; k++) {
        const spanId = (s * 100 + k + 1).toString(16).padStart(16, '0');
        let parentSpanId: string | undefined;
        if (k > 0) parentSpanId = (s * 100 + 1).toString(16).padStart(16, '0');
        else if (s > 0) parentSpanId = ((s - 1) * 100 + 2).toString(16).padStart(16, '0');
        const attrs: Span['attrs'] = k === 3 ? { 'db.system': 'postgresql', 'db.namespace': `db${s}` } : {};
        spans.push({
          traceId,
          spanId,
          parentSpanId,
          name: k ? `op${k}` : `GET /r${t % routes}`,
          kind: k === 0 ? 'SERVER' : k === 2 || k === 3 ? 'CLIENT' : 'INTERNAL',
          startMs: start + k,
          endMs: start + k + 5 + (t % 13),
          durationMs: 5 + (t % 13),
          statusCode: t % 50 === 0 && k === 3 ? 'ERROR' : 'UNSET',
          attrs,
          events: [],
          links: [],
          codeLocation: k === 3 ? { filepath: `/srv/svc${s}/repo.ts`, line: 10 + (t % 5) } : undefined,
        });
      }
    }
    store.ingestSpans([{ resource: { serviceName: `svc${s}`, serviceInstanceId: 'i', attrs: {} }, spans }]);
  }
  return store;
}

// Untimed warm-up runs absorb JIT compilation. The median gates, since with 10 samples p95 is effectively
// the single slowest run and one GC pause would decide the result; p95 is still reported.
export function timeIt(fn: () => unknown): { median: number; p95: number } {
  for (let i = 0; i < WARMUP_RUNS; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { median: quantile(times, 0.5)!, p95: quantile(times, 0.95)! };
}

export function assertBudget(fn: () => unknown, budgetMs: number): void {
  const { median, p95 } = timeIt(fn);
  assert.ok(median < budgetMs, `median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, budget ${budgetMs} ms`);
}
