// Host-side JSON shape for a single log record, shared by "Open In Editor" and log export.
import { LogRecord } from '../store/model';

export interface SerializedLog {
  time: string;
  timeMs: number;
  observedTime?: string;
  observedTimeMs?: number;
  severityNumber: number;
  severityText: string;
  body: unknown;
  traceId?: string;
  spanId?: string;
  scope?: string;
  codeLocation?: LogRecord['codeLocation'];
  attributes: LogRecord['attrs'];
}

export function serializeLog(log: LogRecord): SerializedLog {
  return {
    time: new Date(log.timeMs || 0).toISOString(),
    timeMs: log.timeMs || 0,
    observedTime: log.observedTimeMs ? new Date(log.observedTimeMs).toISOString() : undefined,
    observedTimeMs: log.observedTimeMs,
    severityNumber: log.severityNumber,
    severityText: log.severityText,
    body: log.body,
    traceId: log.traceId,
    spanId: log.spanId,
    scope: log.scope,
    codeLocation: log.codeLocation,
    attributes: log.attrs,
  };
}
