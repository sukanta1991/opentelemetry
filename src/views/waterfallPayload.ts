// Assembles the waterfall message: span rows plus correlated logs grouped by span, with caps
// so a chatty trace cannot produce an unbounded webview payload.

import { KeyValueMap, StoredLogRecord } from '../store/model';
import { TraceLog } from '../store/store';
import {
  WaterfallInput,
  WaterfallPayload,
  WaterfallRow,
  WfLog,
  WfResource,
  buildWaterfall,
  toAttrEntries,
} from './waterfall';
import { renderBody } from './webview/logView';

export const MAX_WATERFALL_LOGS = 2000;
export const MAX_LOG_MESSAGE = 300;

export interface PayloadOptions {
  linkAvailable?: (traceId: string) => boolean;
  truncated?: boolean;
  maxLogs?: number;
}

function logTime(l: StoredLogRecord): number {
  return l.timeMs || l.observedTimeMs || 0;
}

export function truncateMessage(text: string, max = MAX_LOG_MESSAGE): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function buildWaterfallPayload(
  traceId: string,
  tagged: readonly WaterfallInput[],
  logs: readonly TraceLog[],
  resources: ReadonlyMap<string, { serviceName: string; attrs: KeyValueMap }>,
  opts: PayloadOptions = {}
): WaterfallPayload {
  const rows = buildWaterfall(tagged, { linkAvailable: opts.linkAvailable });
  let traceStart = Infinity;
  let totalMs = 0;
  const bySpan = new Map<string, WaterfallRow>();
  for (const r of rows) {
    traceStart = Math.min(traceStart, r.startMs);
    totalMs = Math.max(totalMs, r.offsetMs + r.durationMs);
    bySpan.set(r.spanId, r);
  }
  if (!Number.isFinite(traceStart)) traceStart = 0;

  const max = opts.maxLogs ?? MAX_WATERFALL_LOGS;
  const kept = logs.length > max ? logs.slice(logs.length - max) : logs;
  const logsBySpan: Record<string, WfLog[]> = {};
  const traceLogs: WfLog[] = [];
  for (const { instanceId, log } of kept) {
    const t = logTime(log);
    const row = log.spanId ? bySpan.get(log.spanId) : undefined;
    const entry: WfLog = {
      seq: log.seq,
      instanceId,
      spanId: log.spanId,
      offsetMs: t - traceStart,
      severityNumber: log.severityNumber,
      severityText: log.severityText,
      message: truncateMessage(renderBody(log.body)),
    };
    if (!row) {
      traceLogs.push(entry);
      continue;
    }
    if (t < row.startMs) entry.skew = 'before';
    else if (t > row.startMs + row.durationMs) entry.skew = 'after';
    (logsBySpan[row.spanId] ??= []).push(entry);
    row.logCount++;
  }

  const res: Record<string, WfResource> = {};
  for (const r of rows) {
    if (res[r.instanceId]) continue;
    const info = resources.get(r.instanceId);
    if (info) res[r.instanceId] = { serviceName: info.serviceName, attrs: toAttrEntries(info.attrs) };
  }

  return {
    traceId,
    rows,
    totalMs,
    resources: res,
    logsBySpan,
    traceLogs,
    truncated: (opts.truncated ?? false) || logs.length > max,
  };
}
