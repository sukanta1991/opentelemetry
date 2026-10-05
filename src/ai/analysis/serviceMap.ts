// SPDX-License-Identifier: Apache-2.0
// otel_getServiceMap: service dependency graph with call and error counts.

import { TelemetryStore } from '../../store/store';
import { buildGraph } from '../../views/serviceGraph';
import { GetServiceMapInput } from '../toolInputs';
import { AnalysisContext, AnalysisOutput, round3 } from './common';

const TOP_ERROR_EDGES = 3;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function getServiceMap(store: TelemetryStore, input: GetServiceMapInput, _ctx: AnalysisContext): AnalysisOutput {
  const { nodes, edges } = buildGraph(store.getAllTaggedSpans());
  const rows = edges
    .map((e) => ({ ...e, errorRate: e.count ? round3(e.errors / e.count) : 0 }))
    .sort((a, b) => b.count - a.count || cmpStr(a.source, b.source) || cmpStr(a.target, b.target));
  const topErrorEdges = rows
    .filter((e) => e.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate || cmpStr(a.source, b.source) || cmpStr(a.target, b.target))
    .slice(0, TOP_ERROR_EDGES);
  return {
    result: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes: [...nodes].sort((a, b) => cmpStr(a.type, b.type) || cmpStr(a.id, b.id)),
      topErrorEdges,
      edges: rows.slice(0, input.limit),
    },
    refs: [],
    listKey: 'edges',
  };
}
