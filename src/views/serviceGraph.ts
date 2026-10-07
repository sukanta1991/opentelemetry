// SPDX-License-Identifier: Apache-2.0
// Service dependency graph derived from spans. Shared by the service map panel and AI tools.
// No vscode import.

import { Span } from '../store/model';

export type NodeType = 'service' | 'database' | 'queue' | 'external';

export interface MapNode {
  id: string;
  label: string;
  type: NodeType;
}
export interface MapEdge {
  source: string;
  target: string;
  count: number;
  errors: number;
}

function str(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function svcId(serviceName: string): string {
  return `svc:${serviceName}`;
}

// The database, queue or external node a span calls, if any. Peers that are known services are not external.
export function classifySpanTarget(span: Span, serviceNames: ReadonlySet<string>): MapNode | undefined {
  const a = span.attrs;
  const db = str(a['db.system']);
  if (db) {
    const name = str(a['db.namespace']) ?? str(a['db.name']) ?? db;
    return { id: `db:${db}:${name}`, label: `${db}: ${name}`, type: 'database' };
  }
  const msg = str(a['messaging.system']);
  if (msg) {
    const dest = str(a['messaging.destination.name']) ?? str(a['messaging.destination']) ?? msg;
    return { id: `queue:${msg}:${dest}`, label: `${msg}: ${dest}`, type: 'queue' };
  }
  if (span.kind === 'CLIENT') {
    const peer =
      str(a['peer.service']) ?? str(a['server.address']) ?? str(a['net.peer.name']) ?? str(a['rpc.service']);
    if (peer && !serviceNames.has(peer)) return { id: `ext:${peer}`, label: peer, type: 'external' };
  }
  return undefined;
}

export function buildGraph(tagged: { span: Span; serviceName: string }[]): {
  nodes: MapNode[];
  edges: MapEdge[];
} {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  // traceId -> spanId -> service; span ids are only unique within a trace.
  const serviceBySpan = new Map<string, Map<string, string>>();
  const serviceNames = new Set<string>();

  const addNode = (node: MapNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (source: string, target: string, isError: boolean) => {
    if (source === target) return;
    const key = `${source}\u0000${target}`;
    const e = edges.get(key) ?? { source, target, count: 0, errors: 0 };
    e.count++;
    if (isError) e.errors++;
    edges.set(key, e);
  };

  for (const { span, serviceName } of tagged) {
    if (!serviceNames.has(serviceName)) {
      serviceNames.add(serviceName);
      addNode({ id: svcId(serviceName), label: serviceName, type: 'service' });
    }
    let byId = serviceBySpan.get(span.traceId);
    if (!byId) serviceBySpan.set(span.traceId, (byId = new Map()));
    byId.set(span.spanId, serviceName);
  }

  for (const { span, serviceName } of tagged) {
    const target = classifySpanTarget(span, serviceNames);
    if (!target) continue;
    addNode(target);
    addEdge(svcId(serviceName), target.id, span.statusCode === 'ERROR');
  }

  // Cross-service edges via parent/child across services.
  for (const { span, serviceName } of tagged) {
    if (!span.parentSpanId) continue;
    const parentService = serviceBySpan.get(span.traceId)?.get(span.parentSpanId);
    if (parentService && parentService !== serviceName) {
      addEdge(svcId(parentService), svcId(serviceName), span.statusCode === 'ERROR');
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
