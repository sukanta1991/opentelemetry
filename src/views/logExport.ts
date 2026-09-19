// Pure log serializers for export. No vscode/DOM imports so they stay unit-testable.

import { AttributeValue, KeyValueMap, StoredLogRecord } from '../store/model';
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

// ms * 1e6 exceeds Number.MAX_SAFE_INTEGER for real timestamps, so nanos go through BigInt.
function toNano(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();
}

export function toAnyValue(v: AttributeValue): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    // proto3 JSON encodes int64 as a string.
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } };
  return { kvlistValue: { values: toKeyValues(v as KeyValueMap) } };
}

export function toKeyValues(attrs: KeyValueMap): { key: string; value: unknown }[] {
  return Object.keys(attrs).map((key) => ({ key, value: toAnyValue(attrs[key]) }));
}

export function exportOtlpJson(
  records: readonly StoredLogRecord[],
  inst: ExportInstance
): string {
  const byScope = new Map<string, StoredLogRecord[]>();
  for (const r of records) {
    const key = r.scope ?? '';
    const list = byScope.get(key);
    if (list) list.push(r);
    else byScope.set(key, [r]);
  }

  const resourceAttrs: KeyValueMap = { ...inst.resourceAttrs, 'service.name': inst.serviceName };
  if (inst.serviceInstanceId) resourceAttrs['service.instance.id'] = inst.serviceInstanceId;

  return JSON.stringify(
    {
      resourceLogs: [
        {
          resource: { attributes: toKeyValues(resourceAttrs) },
          scopeLogs: [...byScope.entries()].map(([scope, logs]) => ({
            scope: scope ? { name: scope } : {},
            logRecords: logs.map((l) => {
              const out: Record<string, unknown> = {
                timeUnixNano: toNano(l.timeMs) ?? '0',
                severityNumber: l.severityNumber,
                severityText: l.severityText,
                body: toAnyValue(l.body),
                attributes: toKeyValues(l.attrs),
              };
              const observed = toNano(l.observedTimeMs);
              if (observed) out.observedTimeUnixNano = observed;
              if (l.traceId) out.traceId = l.traceId;
              if (l.spanId) out.spanId = l.spanId;
              return out;
            }),
          })),
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
  columns: readonly LogColumnId[]
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
    return JSON.stringify({ ...envelope, logs: records.map(serializeLog) }, null, 2);
  }

  // Grid mode mirrors what the table shows, keyed by column label.
  const cols = columns.filter((id) => id !== 'select');
  return JSON.stringify(
    {
      ...envelope,
      columns: cols.map((id) => ({ id, label: columnLabel(id) })),
      logs: records.map((l) => {
        const row: Record<string, string> = {};
        for (const id of cols) row[columnLabel(id)] = cellText(l, id);
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
  columns: readonly LogColumnId[]
): string {
  if (mode === 'grid') {
    const cols = columns.filter((id) => id !== 'select');
    const lines = [csvRow(cols.map(columnLabel))];
    for (const l of records) lines.push(csvRow(cols.map((id) => cellText(l, id))));
    return lines.join('\r\n');
  }

  const attrKeys = attributeKeyUnion(records);
  const header = [...CORE_CSV_COLUMNS.map(columnLabel), ...attrKeys.map((k) => `attr.${k}`)];
  const lines = [csvRow(header)];
  for (const l of records) {
    const core = CORE_CSV_COLUMNS.map((id) => cellText(l, id));
    const attrs = attrKeys.map((k) => cellText(l, `attr:${k}`));
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
  columns: readonly LogColumnId[]
): string {
  switch (format) {
    case 'otlp':
      return exportOtlpJson(records, inst);
    case 'csv':
      return exportCsv(records, mode, columns);
    default:
      return exportPlainJson(records, inst, mode, columns);
  }
}

export function defaultExportFileName(serviceName: string, format: ExportFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Collapse dot runs so a service name can never suggest a '..' path segment.
  const safe = serviceName.replace(/[^\w.-]+/g, '_').replace(/\.{2,}/g, '.') || 'logs';
  return `${safe}-logs-${stamp}.${EXPORT_FILE_EXTENSION[format]}`;
}
