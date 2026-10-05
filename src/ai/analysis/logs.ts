// SPDX-License-Identifier: Apache-2.0
// otel_queryLogs: filter held logs across instances, newest first.

import { normalizeSpanId } from '../../store/ids';
import { StoredLogRecord } from '../../store/model';
import { TelemetryStore } from '../../store/store';
import { severityLabel } from '../../views/format';
import { parseTraceIdInput } from '../../views/navigationTargets';
import { filterLogs, logTimeMs, renderBody } from '../../views/webview/logView';
import { Ref } from '../refs';
import { resolveTraceId } from '../resolve';
import { iso, safeValue, setOwn, truncateString } from '../serialize';
import { QueryLogsInput, SEVERITY_NUMBER } from '../toolInputs';
import {
  AnalysisContext,
  AnalysisOutput,
  codeOf,
  errorOutput,
  isGenAiContentKey,
  refLabel,
  selectInstances,
  sourceRef,
} from './common';

const MAX_ATTRS = 10;
const MAX_LOG_REFS = 5;

interface Hit {
  log: StoredLogRecord;
  instanceId: string;
  service: string;
  time: number;
}

// Logs outlive their traces, so a full id is used as-is; only a prefix needs the trace store.
function traceFilter(store: TelemetryStore, raw: string | undefined): { traceId?: string } | { error: string } {
  if (!raw) return {};
  const full = parseTraceIdInput(raw)?.traceId;
  return full ? { traceId: full } : resolveTraceId(store, raw);
}

export function queryLogs(store: TelemetryStore, input: QueryLogsInput, ctx: AnalysisContext): AnalysisOutput {
  const r = ctx.redactor;
  const sel = selectInstances(store, input.service, input.instanceId);
  if ('error' in sel) return errorOutput(sel.error);
  const trace = traceFilter(store, input.traceId);
  if ('error' in trace) return errorOutput(trace.error);
  let spanId: string | undefined;
  if (input.spanId) {
    spanId = normalizeSpanId(input.spanId);
    if (!spanId) return errorOutput('spanId must be a 16-hex span id');
  }
  const from = input.sinceMinutes !== undefined ? ctx.now - input.sinceMinutes * 60_000 : undefined;
  const level = input.minSeverity ? SEVERITY_NUMBER[input.minSeverity] : 0;

  const hits: Hit[] = [];
  for (const inst of sel.instances) {
    const matched = filterLogs(store.getLogs(inst.id), {
      query: input.text ?? '',
      level,
      attrFilter: '',
      range: 'all',
      traceId: trace.traceId,
      spanId,
    });
    for (const log of matched) {
      const time = logTimeMs(log);
      if (from !== undefined && time < from) continue;
      hits.push({ log, instanceId: inst.id, service: inst.serviceName, time });
    }
  }
  hits.sort(
    (a, b) =>
      b.time - a.time || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0) || b.log.seq - a.log.seq
  );

  const severityCounts: Record<string, number> = {};
  for (const h of hits) {
    const label = severityLabel(h.log.severityNumber) || 'UNSPECIFIED';
    severityCounts[label] = (severityCounts[label] ?? 0) + 1;
  }

  const shown = hits.slice(0, input.limit);
  const logs = shown.map(({ log, instanceId, service, time }) => {
    const picked: Record<string, unknown> = {};
    for (const k of Object.keys(log.attrs).filter((k) => !isGenAiContentKey(k)).sort().slice(0, MAX_ATTRS)) {
      setOwn(picked, k, log.attrs[k]);
    }
    return {
      time: iso(time),
      severity: severityLabel(log.severityNumber) || log.severityText || undefined,
      service,
      instanceId,
      seq: log.seq,
      body: truncateString(r.text(renderBody(log.body))),
      attrs: Object.keys(picked).length ? safeValue(r.value(picked)) : undefined,
      traceId: log.traceId,
      spanId: log.spanId,
      code: codeOf(log.codeLocation),
    };
  });

  const refs: Ref[] = [];
  const seen = new Set<string>();
  for (const { log, instanceId } of shown) {
    if (!log.traceId || refs.length >= MAX_LOG_REFS) continue;
    const key = `${log.traceId}/${log.spanId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: 'logs', traceId: log.traceId, spanId: log.spanId, instanceId, focusSeq: log.seq, label: 'View Logs' });
  }
  const withCode = shown.find((h) => h.log.codeLocation);
  const code = codeOf(withCode?.log.codeLocation);
  if (withCode && code) {
    const file = code.filepath.split(/[\\/]/).pop() || code.filepath;
    const label = refLabel(r, code.line ? `${file}:${code.line}` : file);
    refs.push(sourceRef(code, label, withCode.log.traceId, withCode.log.spanId));
  }

  return {
    result: {
      instances: sel.instances.length,
      totalMatched: hits.length,
      severityCounts,
      logs,
    },
    refs,
    listKey: 'logs',
  };
}
