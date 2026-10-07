// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { TaggedSpan, TelemetryStore } from '../../src/store/store';
import { buildNodeDetails, buildServiceMap } from '../../src/views/serviceMapModel';
import { LayoutEdge, LayoutNode, layoutGraph } from '../../src/views/webview/serviceMapLayout';
import { quantile } from '../../src/views/webview/stats';
import { T0 } from './aiFixtures';

const SERVICES = 10;
const TRACES = 2000;
const SPANS_PER_SERVICE = 10;
const RUNS = 10;
const WARMUP_RUNS = 2;
// Budgets are dev-machine targets; shared CI runners (notably 3-vCPU macOS) are several times slower.
const CI_FACTOR = process.env.CI ? 2 : 1;
const MAP_BUDGET_MS = 250 * CI_FACTOR;
const DETAILS_BUDGET_MS = 150 * CI_FACTOR;
const LAYOUT_BUDGET_MS = 20 * CI_FACTOR;

// Every trace crosses all services (svc0 -> svc1 -> ...), so retention holds 10 x 2000 x 10 = 200k spans.
function fill(): TelemetryStore {
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
          name: k ? `op${k}` : `GET /r${t % 7}`,
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
function timeIt(fn: () => unknown): { median: number; p95: number } {
  for (let i = 0; i < WARMUP_RUNS; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { median: quantile(times, 0.5)!, p95: quantile(times, 0.95)! };
}

function assertBudget(fn: () => unknown, budgetMs: number): void {
  const { median, p95 } = timeIt(fn);
  assert.ok(median < budgetMs, `median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, budget ${budgetMs} ms`);
}

describe('service map performance (full buffers)', function () {
  this.timeout(120_000);
  let tagged: TaggedSpan[];

  before(() => {
    tagged = fill().getAllTaggedSpans();
  });

  it('fills 200k spans with a full cross-service graph', () => {
    assert.strictEqual(tagged.length, SERVICES * TRACES * SPANS_PER_SERVICE);
    const m = buildServiceMap(tagged, { range: 'all' });
    assert.strictEqual(m.nodes.length, SERVICES * 2);
    assert.strictEqual(m.edges.length, SERVICES * 2 - 1);
  });

  for (const range of ['5m', 'all'] as const) {
    it(`buildServiceMap (${range}): median under ${MAP_BUDGET_MS} ms`, () => {
      assertBudget(() => buildServiceMap(tagged, { range }), MAP_BUDGET_MS);
    });
  }

  it(`buildNodeDetails: median under ${DETAILS_BUDGET_MS} ms`, () => {
    const m = buildServiceMap(tagged, { range: 'all' });
    assertBudget(() => buildNodeDetails(tagged, m, { kind: 'node', id: 'svc:svc5' }), DETAILS_BUDGET_MS);
  });

  it(`layoutGraph (250 nodes, 1000 edges with cycles): median under ${LAYOUT_BUDGET_MS} ms`, () => {
    const nodes: LayoutNode[] = Array.from({ length: 250 }, (_, i) =>
      i < 100 ? { id: `svc:s${i}`, label: `service-${i}`, type: 'service' } : { id: `db:d${i}`, label: `db-${i}`, type: 'database' }
    );
    const edges: LayoutEdge[] = [];
    const seen = new Set<string>();
    let seed = 42;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    while (edges.length < 1000) {
      const source = nodes[next(100)].id;
      const target = nodes[next(250)].id;
      if (source === target || seen.has(`${source}>${target}`)) continue;
      seen.add(`${source}>${target}`);
      edges.push({ source, target });
    }
    const layout = layoutGraph(nodes, edges);
    assert.strictEqual(layout.boxes.size, 250);
    assert.ok(layout.backEdges.size > 0);
    assertBudget(() => layoutGraph(nodes, edges), LAYOUT_BUDGET_MS);
  });
});
