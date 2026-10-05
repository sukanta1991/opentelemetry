// SPDX-License-Identifier: Apache-2.0
// Parses saved sessions and plain OTLP/JSON (single request or Collector file-exporter JSON Lines).
// Input is untrusted: structure, record counts and attribute counts are checked before decoding.

import { decodeLogs, decodeMetrics, decodeTraces } from '../store/decode';
import { ResourceLogs, ResourceMetrics, ResourceSpans } from '../store/model';
import { SESSION_FORMAT, SESSION_VERSION, SessionCounts } from './sessionExport';

export interface ParsedSession {
  traces: ResourceSpans[];
  logs: ResourceLogs[];
  metrics: ResourceMetrics[];
  counts: SessionCounts;
  /** JSON Lines entries that were not OTLP requests. */
  skipped: number;
  skippedSample?: string;
}

export class SessionImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionImportError';
  }
}

const MAX_ATTRS_PER_RECORD = 256;
const METRIC_KINDS = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'];

type Obj = Record<string, unknown>;

interface Request {
  req: Obj;
  path: string;
}

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRequest(v: Obj): boolean {
  return Array.isArray(v.resourceSpans) || Array.isArray(v.resourceLogs) || Array.isArray(v.resourceMetrics);
}

function fail(path: string, expected: string): never {
  throw new SessionImportError(`${path}: expected ${expected}`);
}

function obj(v: unknown, path: string): Obj {
  if (!isObject(v)) fail(path, 'an object');
  return v;
}

function list(v: unknown, path: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(path, 'an array');
  return v;
}

function checkAttrs(v: unknown, path: string): void {
  const n = list(v, path).length;
  if (n > MAX_ATTRS_PER_RECORD) {
    throw new SessionImportError(`${path}: ${n} attributes exceeds the ${MAX_ATTRS_PER_RECORD} per-record limit`);
  }
}

function checkResource(v: Obj, path: string): void {
  if (v.resource !== undefined) checkAttrs(obj(v.resource, `${path}.resource`).attributes, `${path}.resource.attributes`);
}

function documentRequests(doc: Obj): Request[] {
  if (doc.format === SESSION_FORMAT) {
    if (typeof doc.version === 'number' && doc.version > SESSION_VERSION) {
      throw new SessionImportError(
        `This session was saved by a newer version of the extension (format ${doc.version}). Update the extension to load it.`
      );
    }
    const out: Request[] = [];
    for (const key of ['traces', 'logs', 'metrics']) {
      if (doc[key] !== undefined) out.push({ req: obj(doc[key], key), path: key });
    }
    return out;
  }
  if (isRequest(doc)) return [{ req: doc, path: 'root' }];
  throw new SessionImportError(
    'Not an OpenTelemetry session or OTLP/JSON file (expected resourceSpans, resourceLogs or resourceMetrics).'
  );
}

// Validates shape and counts records in the same fallbacks decode.ts reads.
function countRecords(req: Obj, path: string, counts: SessionCounts, maxRecords: number): void {
  const bump = (field: keyof SessionCounts) => {
    counts[field]++;
    if (counts.spans + counts.logs + counts.metricPoints > maxRecords) {
      throw new SessionImportError(
        `File has more than ${maxRecords} records (spans, logs and metric points). Raise otel.import.maxRecords to load it.`
      );
    }
  };

  list(req.resourceSpans, `${path}.resourceSpans`).forEach((r, i) => {
    const rp = `${path}.resourceSpans[${i}]`;
    const rs = obj(r, rp);
    checkResource(rs, rp);
    list(rs.scopeSpans || rs.instrumentationLibrarySpans, `${rp}.scopeSpans`).forEach((s, j) => {
      const sp = `${rp}.scopeSpans[${j}]`;
      list(obj(s, sp).spans, `${sp}.spans`).forEach((x, k) => {
        const p = `${sp}.spans[${k}]`;
        const span = obj(x, p);
        checkAttrs(span.attributes, `${p}.attributes`);
        list(span.events, `${p}.events`).forEach((e, n) => checkAttrs(obj(e, `${p}.events[${n}]`).attributes, `${p}.events[${n}].attributes`));
        list(span.links, `${p}.links`).forEach((l, n) => checkAttrs(obj(l, `${p}.links[${n}]`).attributes, `${p}.links[${n}].attributes`));
        bump('spans');
      });
    });
  });

  list(req.resourceLogs, `${path}.resourceLogs`).forEach((r, i) => {
    const rp = `${path}.resourceLogs[${i}]`;
    const rl = obj(r, rp);
    checkResource(rl, rp);
    list(rl.scopeLogs || rl.instrumentationLibraryLogs, `${rp}.scopeLogs`).forEach((s, j) => {
      const sp = `${rp}.scopeLogs[${j}]`;
      const sl = obj(s, sp);
      list(sl.logRecords || sl.log_records, `${sp}.logRecords`).forEach((x, k) => {
        const p = `${sp}.logRecords[${k}]`;
        checkAttrs(obj(x, p).attributes, `${p}.attributes`);
        bump('logs');
      });
    });
  });

  list(req.resourceMetrics, `${path}.resourceMetrics`).forEach((r, i) => {
    const rp = `${path}.resourceMetrics[${i}]`;
    const rm = obj(r, rp);
    checkResource(rm, rp);
    list(rm.scopeMetrics || rm.instrumentationLibraryMetrics, `${rp}.scopeMetrics`).forEach((s, j) => {
      const sp = `${rp}.scopeMetrics[${j}]`;
      list(obj(s, sp).metrics, `${sp}.metrics`).forEach((x, k) => {
        const p = `${sp}.metrics[${k}]`;
        const m = obj(x, p);
        for (const kind of METRIC_KINDS) {
          if (m[kind] === undefined) continue;
          list(obj(m[kind], `${p}.${kind}`).dataPoints, `${p}.${kind}.dataPoints`).forEach((d, n) => {
            checkAttrs(obj(d, `${p}.${kind}.dataPoints[${n}]`).attributes, `${p}.${kind}.dataPoints[${n}].attributes`);
            bump('metricPoints');
          });
        }
      });
    });
  });
}

export function parseSessionFile(text: string, maxRecords: number): ParsedSession {
  const requests: Request[] = [];
  let skipped = 0;
  let skippedSample: string | undefined;

  let doc: unknown;
  let parseError: string | undefined;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }

  if (parseError === undefined) {
    if (!isObject(doc)) throw new SessionImportError('Expected a JSON object.');
    requests.push(...documentRequests(doc));
  } else {
    // Collector file exporter: one Export*ServiceRequest per line.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (!isObject(v) || !isRequest(v)) throw new Error('not an OTLP/JSON request');
        requests.push({ req: v, path: `line ${i + 1}` });
      } catch (e) {
        skipped++;
        skippedSample ??= `line ${i + 1}: ${(e as Error).message}`;
      }
    }
    if (!requests.length) throw new SessionImportError(`Not valid JSON: ${parseError}`);
  }

  const counts: SessionCounts = { spans: 0, logs: 0, metricPoints: 0 };
  for (const { req, path } of requests) countRecords(req, path, counts, maxRecords);
  if (!counts.spans && !counts.logs && !counts.metricPoints) {
    throw new SessionImportError('File contains no spans, logs or metric points.');
  }

  const out: ParsedSession = { traces: [], logs: [], metrics: [], counts, skipped, skippedSample };
  for (const { req } of requests) {
    out.traces.push(...decodeTraces(req));
    out.logs.push(...decodeLogs(req));
    out.metrics.push(...decodeMetrics(req));
  }
  return out;
}
