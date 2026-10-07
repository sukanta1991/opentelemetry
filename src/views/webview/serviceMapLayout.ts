// SPDX-License-Identifier: Apache-2.0
// Layered (top-down) layout for the service map. Pure: no vscode or DOM imports.

export interface LayoutNode {
  id: string;
  label: string;
  type: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

// x/y are the box centre.
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface Layout {
  boxes: Map<string, NodeBox>;
  // Edges reversed to break cycles (edgeKey); drawn as curves.
  backEdges: Set<string>;
  width: number;
  height: number;
}

export const NODE_HEIGHT = 56;
export const LAYER_GAP = 72;
// Gap between wrapped rows of the same layer; smaller than LAYER_GAP so layers still read as bands.
export const SUBROW_GAP = 28;
export const NODE_GAP = 32;
export const COMPONENT_GAP = 80;
export const MARGIN = 24;
// Wide layers wrap at max(MIN_ROW_WIDTH, width giving roughly TARGET_ASPECT), so big maps stay legible when fitted.
export const MIN_ROW_WIDTH = 1100;
const TARGET_ASPECT = 1.6;
const CHAR_WIDTH = 7;
// Side padding plus the health glyph drawn before the label.
const LABEL_PADDING = 40;
const MIN_NODE_WIDTH = 96;
export const MAX_NODE_WIDTH = 260;
const SWEEPS = 4;

export function edgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

export function nodeWidth(label: string): number {
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, label.length * CHAR_WIDTH + LABEL_PADDING));
}

// Changes only when nodes or edges are added or removed, not when their stats change.
export function topologyKey(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string {
  const ids = nodes.map((n) => n.id).sort();
  const links = edges.map((e) => edgeKey(e.source, e.target)).sort();
  return `${ids.join('\u0001')}\u0002${links.join('\u0001')}`;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (n: LayoutNode) => (n.type === 'service' ? 0 : 1);

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Layout {
  const byId = new Map<string, LayoutNode>();
  for (const n of [...nodes].sort((a, b) => rank(a) - rank(b) || cmp(a.id, b.id))) {
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  const ids = [...byId.keys()];

  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const links: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const e of [...edges].sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target))) {
    const key = edgeKey(e.source, e.target);
    if (e.source === e.target || !byId.has(e.source) || !byId.has(e.target) || seen.has(key)) continue;
    seen.add(key);
    out.get(e.source)!.push(e.target);
    links.push(e);
  }

  const backEdges = findBackEdges(ids, out, links);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of links) {
    if (backEdges.has(edgeKey(e.source, e.target))) continue;
    succs.get(e.source)!.push(e.target);
    preds.get(e.target)!.push(e.source);
  }

  const layer = assignLayers(ids, preds, succs);
  const widthOf = (id: string) => nodeWidth(byId.get(id)!.label);
  const totalWidth = ids.reduce((w, id) => w + widthOf(id) + NODE_GAP, 0);
  const maxRowWidth = Math.max(MIN_ROW_WIDTH, Math.sqrt(TARGET_ASPECT * totalWidth * (NODE_HEIGHT + LAYER_GAP)));
  const boxes = new Map<string, NodeBox>();
  let offsetX = MARGIN;
  let height = 0;
  for (const component of components(ids, links)) {
    const layers = orderLayers(component, layer, preds, succs);
    const rows: { ids: string[]; layer: number; width: number }[] = [];
    layers.forEach((ids, l) => {
      for (const chunk of wrapRow(ids, widthOf, maxRowWidth)) rows.push({ ids: chunk, layer: l, width: rowWidth(chunk, widthOf) });
    });
    const width = Math.max(...rows.map((r) => r.width));
    let y = MARGIN;
    rows.forEach((row, i) => {
      if (i > 0) y += row.layer === rows[i - 1].layer ? SUBROW_GAP : LAYER_GAP;
      let x = offsetX + (width - row.width) / 2;
      for (const id of row.ids) {
        const w = widthOf(id);
        boxes.set(id, { x: x + w / 2, y: y + NODE_HEIGHT / 2, width: w, height: NODE_HEIGHT, layer: row.layer });
        x += w + NODE_GAP;
      }
      y += NODE_HEIGHT;
    });
    height = Math.max(height, y + MARGIN);
    offsetX += width + COMPONENT_GAP;
  }

  return {
    boxes,
    backEdges,
    width: ids.length ? offsetX - COMPONENT_GAP + MARGIN : 2 * MARGIN,
    height: ids.length ? height : 2 * MARGIN,
  };
}

function rowWidth(ids: string[], widthOf: (id: string) => number): number {
  return ids.reduce((w, id) => w + widthOf(id), 0) + NODE_GAP * Math.max(0, ids.length - 1);
}

// Splits an ordered layer into consecutive chunks no wider than maxWidth (always at least one node each).
function wrapRow(ids: string[], widthOf: (id: string) => number, maxWidth: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let w = 0;
  for (const id of ids) {
    const add = widthOf(id) + (cur.length ? NODE_GAP : 0);
    if (cur.length && w + add > maxWidth) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    w += widthOf(id) + (cur.length ? NODE_GAP : 0);
    cur.push(id);
  }
  out.push(cur);
  return out;
}

// Iterative DFS, sources first, so deep graphs cannot overflow the stack.
function findBackEdges(ids: string[], out: Map<string, string[]>, links: LayoutEdge[]): Set<string> {
  const hasIncoming = new Set(links.map((e) => e.target));
  const state = new Map<string, 'open' | 'done'>();
  const back = new Set<string>();
  for (const start of [...ids.filter((id) => !hasIncoming.has(id)), ...ids]) {
    if (state.has(start)) continue;
    state.set(start, 'open');
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const kids = out.get(top.id)!;
      if (top.next < kids.length) {
        const kid = kids[top.next++];
        const s = state.get(kid);
        if (s === 'open') back.add(edgeKey(top.id, kid));
        else if (!s) {
          state.set(kid, 'open');
          stack.push({ id: kid, next: 0 });
        }
      } else {
        state.set(top.id, 'done');
        stack.pop();
      }
    }
  }
  return back;
}

// Longest path from the sources, so every node sits below all of its callers.
function assignLayers(ids: string[], preds: Map<string, string[]>, succs: Map<string, string[]>): Map<string, number> {
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const pending = new Map<string, number>(ids.map((id) => [id, preds.get(id)!.length]));
  const queue = ids.filter((id) => pending.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of succs.get(u)!) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      const left = pending.get(v)! - 1;
      pending.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  return layer;
}

// Weakly connected components, in order of their first node.
function components(ids: string[], links: LayoutEdge[]): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  for (const e of links) {
    const a = find(e.source);
    const b = find(e.target);
    if (a !== b) parent.set(b, a);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()];
}

// Barycenter ordering, alternating down and up sweeps. Rows are re-based so each component starts at layer 0.
function orderLayers(
  component: string[],
  layer: Map<string, number>,
  preds: Map<string, string[]>,
  succs: Map<string, string[]>
): string[][] {
  const base = Math.min(...component.map((id) => layer.get(id)!));
  const rows: string[][] = [];
  for (const id of component) {
    const l = layer.get(id)! - base;
    while (rows.length <= l) rows.push([]);
    rows[l].push(id);
  }
  const pos = new Map<string, number>();
  const place = (row: string[]) => row.forEach((id, i) => pos.set(id, (i + 0.5) / row.length));
  rows.forEach(place);

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? rows.map((_, l) => l).slice(1) : rows.map((_, l) => l).reverse().slice(1);
    for (const l of order) {
      const bary = new Map<string, number>();
      for (const id of rows[l]) {
        const nbrs = (down ? preds : succs).get(id)!;
        bary.set(id, nbrs.length ? nbrs.reduce((s, n) => s + pos.get(n)!, 0) / nbrs.length : pos.get(id)!);
      }
      rows[l].sort((a, b) => bary.get(a)! - bary.get(b)! || pos.get(a)! - pos.get(b)! || cmp(a, b));
      place(rows[l]);
    }
  }
  return rows;
}
