// Pure log serializers for export. No vscode/DOM imports so they stay unit-testable.

import { byScope, encodeLog, encodeResource, toAnyValue, toKeyValues } from '../store/encode';
import { KeyValueMap, StoredLogRecord } from '../store/model';
import { LogColumnId, columnLabel } from './webview/logColumns';
import { cellText, logTimeMs } from './webview/logView';
import { serializeLog } from './logSerialize';

export type ExportFormat = 'otlp' | 'json' | 'csv';
export type ExportData = 'grid' | 'all';
export type ExportScope = 'filtered' | 'all' | 'selected';

export interface ExportInstance {
  serviceName: string;
  serviceInstanceId?: string;
  resourceAttrs: KeyValueMap;
}

export const EXPORT_FILE_EXTENSION: Record<ExportFormat, string> = {
  otlp: 'json',
  json: 'json',
  csv: 'csv',
};

// Newest N by timestamp, emitted oldest-first so the file reads like a log.
export function pickNewest(
  records: readonly StoredLogRecord[],
  count: number
): StoredLogRecord[] {
  const byTime = records.slice().sort((a, b) => logTimeMs(a) - logTimeMs(b) || a.seq - b.seq);
  if (count > 0 && byTime.length > count) return byTime.slice(byTime.length - count);
  return byTime;
}

// --- OTLP/JSON ---------------------------------------------------------------------------

export { toAnyValue, toKeyValues };

export function exportOtlpJson(
  records: readonly StoredLogRecord[],
  inst: ExportInstance
): string {
  return JSON.stringify(
    {
      resourceLogs: [
        {
          resource: encodeResource(inst.serviceName, inst.serviceInstanceId, inst.resourceAttrs),
          scopeLogs: byScope(records).map((g) => ({ scope: g.scope, logRecords: g.items.map(encodeLog) })),
        },
      ],
    },
    null,
    2
  );
}

// --- Plain JSON --------------------------------------------------------------------------

export function exportPlainJson(
  records: readonly StoredLogRecord[],
  inst: ExportInstance,
  mode: ExportData,
  columns: readonly LogColumnId[],
  useLocalTime: boolean
): string {
  const envelope = {
    version: 1,
    exportedAt: new Date().toISOString(),
    instance: {
      serviceName: inst.serviceName,
      serviceInstanceId: inst.serviceInstanceId,
      resourceAttrs: inst.resourceAttrs,
    },
  };

  if (mode === 'all') {
    // Full records keep UTC times whatever the display setting, like the OTLP export.
    return JSON.stringify({ ...envelope, logs: records.map((l) => serializeLog(l, false)) }, null, 2);
  }

  // Grid mode mirrors what the table shows, keyed by column label.
  const cols = columns.filter((id) => id !== 'select');
  return JSON.stringify(
    {
      ...envelope,
      columns: cols.map((id) => ({ id, label: columnLabel(id) })),
      logs: records.map((l) => {
        const row: Record<string, string> = {};
        for (const id of cols) row[columnLabel(id)] = cellText(l, id, useLocalTime);
        return row;
      }),
    },
    null,
    2
  );
}

// --- CSV ---------------------------------------------------------------------------------

const CORE_CSV_COLUMNS: LogColumnId[] = [
  'time',
  'observedTime',
  'level',
  'severityNumber',
  'message',
  'traceId',
  'spanId',
  'scope',
  'codeLocation',
  'function',
];

export function attributeKeyUnion(records: readonly StoredLogRecord[]): string[] {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.attrs)) keys.add(k);
  return [...keys].sort();
}

// Spreadsheets execute cells beginning with these, so the value is neutralised with a quote.
function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: string): string {
  const safe = neutralise(value);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

export function exportCsv(
  records: readonly StoredLogRecord[],
  mode: ExportData,
  columns: readonly LogColumnId[],
  useLocalTime: boolean
): string {
  if (mode === 'grid') {
    const cols = columns.filter((id) => id !== 'select');
    const lines = [csvRow(cols.map(columnLabel))];
    for (const l of records) lines.push(csvRow(cols.map((id) => cellText(l, id, useLocalTime))));
    return lines.join('\r\n');
  }

  const attrKeys = attributeKeyUnion(records);
  const header = [...CORE_CSV_COLUMNS.map(columnLabel), ...attrKeys.map((k) => `attr.${k}`)];
  const lines = [csvRow(header)];
  for (const l of records) {
    const core = CORE_CSV_COLUMNS.map((id) => cellText(l, id, useLocalTime));
    const attrs = attrKeys.map((k) => cellText(l, `attr:${k}`, useLocalTime));
    lines.push(csvRow([...core, ...attrs]));
  }
  return lines.join('\r\n');
}

// --- Entry point ---------------------------------------------------------------------------

export function serializeExport(
  format: ExportFormat,
  records: readonly StoredLogRecord[],
  inst: ExportInstance,
  mode: ExportData,
  columns: readonly LogColumnId[],
  useLocalTime: boolean
): string {
  switch (format) {
    case 'otlp':
      return exportOtlpJson(records, inst);
    case 'csv':
      return exportCsv(records, mode, columns, useLocalTime);
    default:
      return exportPlainJson(records, inst, mode, columns, useLocalTime);
  }
}

export function defaultExportFileName(serviceName: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Collapse dot runs so a service name can never suggest a '..' path segment.
  const safe = serviceName.replace(/[^\w.-]+/g, '_').replace(/\.{2,}/g, '.') || 'logs';
  return `${safe}-logs-${stamp}.${EXPORT_FILE_EXTENSION[format]}`;
}
