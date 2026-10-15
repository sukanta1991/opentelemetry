// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { TaggedSpan } from '../../src/store/store';
import { buildNodeDetails, buildServiceMap } from '../../src/views/serviceMapModel';
import { LayoutEdge, LayoutNode, layoutGraph } from '../../src/views/webview/serviceMapLayout';
import { CI_FACTOR, SERVICES, SPANS_PER_SERVICE, TRACES, assertBudget, fillServiceMapStore as fill } from './perfFixtures';

const MAP_BUDGET_MS = 250 * CI_FACTOR;
const DETAILS_BUDGET_MS = 150 * CI_FACTOR;
const LAYOUT_BUDGET_MS = 20 * CI_FACTOR;

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
