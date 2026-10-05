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

export function buildGraph(tagged: { span: Span; serviceName: string }[]): {
  nodes: MapNode[];
  edges: MapEdge[];
} {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const serviceBySpan = new Map<string, string>();

  const addNode = (id: string, label: string, type: NodeType) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, type });
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
    addNode(`svc:${serviceName}`, serviceName, 'service');
    serviceBySpan.set(span.spanId, serviceName);
  }

  for (const { span, serviceName } of tagged) {
    const a = span.attrs;
    const isError = span.statusCode === 'ERROR';
    const db = str(a['db.system']);
    const msg = str(a['messaging.system']);
    if (db) {
      const name = str(a['db.namespace']) ?? str(a['db.name']) ?? db;
      const id = `db:${db}:${name}`;
      addNode(id, `${db}: ${name}`, 'database');
      addEdge(`svc:${serviceName}`, id, isError);
    } else if (msg) {
      const dest = str(a['messaging.destination.name']) ?? str(a['messaging.destination']) ?? msg;
      const id = `queue:${msg}:${dest}`;
      addNode(id, `${msg}: ${dest}`, 'queue');
      addEdge(`svc:${serviceName}`, id, isError);
    } else if (span.kind === 'CLIENT') {
      const peer =
        str(a['peer.service']) ??
        str(a['server.address']) ??
        str(a['net.peer.name']) ??
        str(a['rpc.service']);
      if (peer && !serviceExists(nodes, peer)) {
        const id = `ext:${peer}`;
        addNode(id, peer, 'external');
        addEdge(`svc:${serviceName}`, id, isError);
      }
    }
  }

  // Cross-service edges via parent/child across services.
  for (const { span, serviceName } of tagged) {
    if (!span.parentSpanId) continue;
    const parentService = serviceBySpan.get(span.parentSpanId);
    if (parentService && parentService !== serviceName) {
      addEdge(`svc:${parentService}`, `svc:${serviceName}`, span.statusCode === 'ERROR');
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function serviceExists(nodes: Map<string, MapNode>, name: string): boolean {
  return nodes.has(`svc:${name}`);
}
