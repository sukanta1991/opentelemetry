// SPDX-License-Identifier: Apache-2.0
// Span builders for baseline snapshot and comparison tests.
import { Span } from '../../src/store/model';
import { LIVE_REALM, TelemetryStore } from '../../src/store/store';
import { CaptureRequest, DEFAULT_SNAPSHOT_CAPS, Snapshot, captureSnapshot } from '../../src/views/baseline';
import { Collected, collectCalls, prepare } from '../../src/views/serviceMapModel';
import { addSpans, span } from './aiFixtures';

export const tid = (i: number) => (i + 1).toString(16).padStart(32, '0');
export const sid = (i: number) => (i + 1).toString(16).padStart(16, '0');
export const LIVE: CaptureRequest = { kind: 'window', label: 'test', realm: LIVE_REALM };

export interface Call {
  endMs: number;
  ms?: number;
  route?: string;
  error?: boolean;
  dbMs?: number;
  // postgres children per call when dbMs is set; default 1.
  dbCalls?: number;
}

// api root span per call, optionally with postgres children.
export function apiCalls(calls: Call[], offset = 0): Span[] {
  return calls.flatMap((c, i) => {
    const ms = c.ms ?? 10;
    const route = c.route ?? '/a';
    const traceId = tid(offset + i);
    const root = span({
      traceId,
      spanId: sid(0),
      kind: 'SERVER',
      name: `GET ${route}`,
      startMs: c.endMs - ms,
      endMs: c.endMs,
      durationMs: ms,
      statusCode: c.error ? 'ERROR' : 'UNSET',
      attrs: { 'http.route': route, 'http.request.method': 'GET' },
    });
    if (c.dbMs === undefined) return [root];
    const children = Array.from({ length: c.dbCalls ?? 1 }, (_, k) =>
      span({
        traceId,
        spanId: sid(1 + k),
        parentSpanId: sid(0),
        kind: 'CLIENT',
        name: 'SELECT',
        startMs: c.endMs - ms,
        durationMs: c.dbMs,
        attrs: { 'db.system': 'postgresql', 'db.namespace': 'shop', 'db.operation.name': 'SELECT', 'db.collection.name': 'orders' },
      })
    );
    return [root, ...children];
  });
}

export function storeWith(spans: Span[]): TelemetryStore {
  const store = new TelemetryStore(10, 10_000);
  addSpans(store, 'api', spans);
  return store;
}

export function capture(spans: Span[], req: Partial<CaptureRequest> = {}, caps = DEFAULT_SNAPSHOT_CAPS): Snapshot {
  return captureSnapshot(storeWith(spans).getAllTaggedSpans(), { ...LIVE, ...req }, caps);
}

export function collectAll(spans: Span[]): Collected {
  const tagged = storeWith(spans).getAllTaggedSpans();
  return collectCalls(tagged, prepare(tagged), { inWindow: () => true, ops: true });
}
