// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import {
  LayoutEdge,
  LayoutNode,
  MARGIN,
  MIN_ROW_WIDTH,
  NODE_HEIGHT,
  edgeKey,
  layoutGraph,
  nodeWidth,
  topologyKey,
} from '../../src/views/webview/serviceMapLayout';

const svc = (id: string): LayoutNode => ({ id, label: id, type: 'service' });
const db = (id: string): LayoutNode => ({ id, label: id, type: 'database' });
const e = (source: string, target: string): LayoutEdge => ({ source, target });

const layers = (nodes: LayoutNode[], edges: LayoutEdge[]) =>
  Object.fromEntries([...layoutGraph(nodes, edges).boxes].map(([id, b]) => [id, b.layer]));

function assertNoOverlap(nodes: LayoutNode[], edges: LayoutEdge[]): void {
  const boxes = [...layoutGraph(nodes, edges).boxes.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const apart =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
      assert.ok(apart, `boxes ${i} and ${j} overlap`);
    }
  }
}

describe('serviceMapLayout', () => {
  it('returns an empty layout for no nodes', () => {
    const l = layoutGraph([], []);
    assert.strictEqual(l.boxes.size, 0);
    assert.strictEqual(l.backEdges.size, 0);
    assert.deepStrictEqual([l.width, l.height], [2 * MARGIN, 2 * MARGIN]);
  });

  it('puts a chain on successive layers, top to bottom', () => {
    const l = layoutGraph([svc('c'), svc('a'), svc('b')], [e('a', 'b'), e('b', 'c')]);
    assert.deepStrictEqual(
      ['a', 'b', 'c'].map((id) => l.boxes.get(id)!.layer),
      [0, 1, 2]
    );
    assert.ok(l.boxes.get('a')!.y < l.boxes.get('b')!.y && l.boxes.get('b')!.y < l.boxes.get('c')!.y);
    assert.strictEqual(l.boxes.get('a')!.y, MARGIN + NODE_HEIGHT / 2);
  });

  it('lays out a diamond on three layers', () => {
    assert.deepStrictEqual(
      layers([svc('a'), svc('b'), svc('c'), svc('d')], [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]),
      { a: 0, b: 1, c: 1, d: 2 }
    );
  });

  it('breaks cycles and still places every node', () => {
    const l = layoutGraph([svc('a'), svc('b'), svc('c')], [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
    assert.strictEqual(l.boxes.size, 3);
    assert.deepStrictEqual([...l.backEdges], [edgeKey('c', 'a')]);
    assert.deepStrictEqual(
      ['a', 'b', 'c'].map((id) => l.boxes.get(id)!.layer),
      [0, 1, 2]
    );
  });

  it('starts cycle-breaking from sources', () => {
    // web calls into an a<->b loop; web must stay on top.
    const l = layoutGraph([svc('a'), svc('b'), svc('web')], [e('web', 'a'), e('a', 'b'), e('b', 'a')]);
    assert.strictEqual(l.boxes.get('web')!.layer, 0);
    assert.deepStrictEqual([...l.backEdges], [edgeKey('b', 'a')]);
  });

  it('keeps dependencies below every caller', () => {
    assert.deepStrictEqual(
      layers([svc('a'), svc('b'), db('pg')], [e('a', 'b'), e('a', 'pg'), e('b', 'pg')]),
      { a: 0, b: 1, pg: 2 }
    );
  });

  it('ignores self-loops, duplicate edges and edges to unknown nodes', () => {
    const l = layoutGraph([svc('a'), svc('b')], [e('a', 'a'), e('a', 'b'), e('a', 'b'), e('a', 'zz')]);
    assert.strictEqual(l.backEdges.size, 0);
    assert.deepStrictEqual(
      [l.boxes.get('a')!.layer, l.boxes.get('b')!.layer],
      [0, 1]
    );
    assert.strictEqual(l.boxes.has('zz'), false);
  });

  it('reduces crossings with barycenter ordering', () => {
    // Sorted by id, x would sit left of y and cross a->y; barycenter puts y first.
    const l = layoutGraph([svc('a'), svc('b'), svc('x'), svc('y')], [e('a', 'y'), e('a', 'x'), e('b', 'x')]);
    const [a, b, x, y] = ['a', 'b', 'x', 'y'].map((id) => l.boxes.get(id)!.x);
    assert.ok(a < b);
    assert.ok(y < x);
  });

  it('places disconnected components side by side without overlap', () => {
    const nodes = [svc('a'), svc('b'), svc('c'), svc('d'), svc('lonely')];
    const edges = [e('a', 'b'), e('c', 'd')];
    assertNoOverlap(nodes, edges);
    const l = layoutGraph(nodes, edges);
    const right = (id: string) => l.boxes.get(id)!.x + l.boxes.get(id)!.width / 2;
    const left = (id: string) => l.boxes.get(id)!.x - l.boxes.get(id)!.width / 2;
    assert.ok(Math.max(right('a'), right('b')) < Math.min(left('c'), left('d')));
    assert.ok(right('d') < left('lonely'));
    assert.strictEqual(l.boxes.get('lonely')!.layer, 0);
  });

  it('wraps an over-wide layer into rows that stay below their callers', () => {
    const nodes = [svc('root'), ...Array.from({ length: 20 }, (_, i) => db(`database-number-${String(i).padStart(2, '0')}`))];
    const edges = nodes.slice(1).map((n) => e('root', n.id));
    const l = layoutGraph(nodes, edges);
    const kids = nodes.slice(1).map((n) => l.boxes.get(n.id)!);
    const rowsY = [...new Set(kids.map((b) => b.y))].sort((a, b) => a - b);
    assert.ok(rowsY.length > 1, 'wrapped');
    assert.ok(kids.every((b) => b.layer === 1));
    assert.ok(rowsY[0] > l.boxes.get('root')!.y);
    assert.ok(l.width <= MIN_ROW_WIDTH + 2 * MARGIN);
    // Wrapping keeps the layer order: row by row, left to right.
    const order = [...kids].sort((a, b) => a.y - b.y || a.x - b.x).map((b) => [...l.boxes].find(([, v]) => v === b)![0]);
    assert.deepStrictEqual(order, [...order].sort());
  });

  it('never overlaps boxes in a wide layer, and bounds contain every box', () => {
    const nodes = [svc('root'), ...Array.from({ length: 12 }, (_, i) => db(`database-number-${i}`))];
    const edges = nodes.slice(1).map((n) => e('root', n.id));
    assertNoOverlap(nodes, edges);
    const l = layoutGraph(nodes, edges);
    for (const b of l.boxes.values()) {
      assert.ok(b.x - b.width / 2 >= MARGIN && b.x + b.width / 2 <= l.width - MARGIN);
      assert.ok(b.y - b.height / 2 >= MARGIN && b.y + b.height / 2 <= l.height - MARGIN);
    }
  });

  it('is deterministic regardless of input order', () => {
    const nodes = [svc('web'), svc('api'), svc('pay'), db('pg'), db('redis')];
    const edges = [e('web', 'api'), e('api', 'pay'), e('api', 'pg'), e('pay', 'pg'), e('web', 'redis'), e('pay', 'api')];
    const a = layoutGraph(nodes, edges);
    const b = layoutGraph([...nodes].reverse(), [...edges].reverse());
    assert.deepStrictEqual([...b.boxes].sort(), [...a.boxes].sort());
    assert.deepStrictEqual(b.backEdges, a.backEdges);
    assert.deepStrictEqual([b.width, b.height], [a.width, a.height]);
  });

  it('sizes nodes by label within bounds', () => {
    assert.strictEqual(nodeWidth('a'), 96);
    assert.ok(nodeWidth('checkout-api-service') > 96);
    assert.strictEqual(nodeWidth('x'.repeat(500)), 260);
  });

  describe('topologyKey', () => {
    const nodes = [svc('a'), svc('b'), db('pg')];
    const edges = [e('a', 'b'), e('b', 'pg')];

    it('ignores order and anything but ids', () => {
      const withStats = nodes.map((n) => ({ ...n, stats: { count: 5 } }));
      assert.strictEqual(topologyKey([...withStats].reverse(), [...edges].reverse()), topologyKey(nodes, edges));
    });

    it('changes when a node or edge is added', () => {
      const key = topologyKey(nodes, edges);
      assert.notStrictEqual(topologyKey([...nodes, svc('c')], edges), key);
      assert.notStrictEqual(topologyKey(nodes, [...edges, e('a', 'pg')]), key);
    });

    it('does not confuse ids that contain separators of the other part', () => {
      assert.notStrictEqual(topologyKey([svc('a'), svc('b')], []), topologyKey([svc('a')], [e('a', 'b')]));
    });
  });
});
