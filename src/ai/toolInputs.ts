// SPDX-License-Identifier: Apache-2.0
// Validates tool input from the model. Returns { value } or an { error } the model can act on.
// Strings are trimmed and capped, numbers clamped, enums checked; unknown keys are ignored.

import { MAX_QUERY_LENGTH } from '../views/webview/traceView';
import { DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS } from './limits';

export const MAX_FIELD_CHARS = 256;
const MAX_DURATION_MS = 7 * 24 * 3600_000;
const MAX_SINCE_MINUTES = 7 * 24 * 60;

export type Parsed<T> = { value: T } | { error: string };

export const STATUS_VALUES = ['error', 'ok', 'unset'] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];

export const SEVERITY_NUMBER = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 } as const;
export type SeverityName = keyof typeof SEVERITY_NUMBER;
const SEVERITY_NAMES = Object.keys(SEVERITY_NUMBER) as SeverityName[];

export const TRACE_SORTS = ['duration', 'errors', 'recent'] as const;
export const SPAN_SORTS = ['duration', 'selfTime'] as const;
export const SPAN_GROUPS = ['none', 'service', 'name', 'serviceAndName'] as const;

export type ListServicesInput = Record<string, never>;

export interface SearchTracesInput {
  query?: string;
  service?: string;
  status?: StatusValue;
  minDurationMs?: number;
  sinceMinutes?: number;
  sort: (typeof TRACE_SORTS)[number];
  // 'rootName' | 'rootService' | 'time', or any root-span attribute key.
  groupBy?: string;
  limit: number;
}

export interface FindSpansInput {
  query?: string;
  service?: string;
  status?: StatusValue;
  minDurationMs?: number;
  sinceMinutes?: number;
  sort: (typeof SPAN_SORTS)[number];
  groupBy: (typeof SPAN_GROUPS)[number];
  limit: number;
}

export interface GetTraceInput {
  traceId?: string;
  spanId?: string;
  includeLogs: boolean;
}

export interface CompareTracesInput {
  traceId: string;
  baselineTraceId?: string;
}

export interface QueryLogsInput {
  service?: string;
  instanceId?: string;
  minSeverity?: SeverityName;
  text?: string;
  traceId?: string;
  spanId?: string;
  sinceMinutes?: number;
  limit: number;
}

export interface QueryMetricsInput {
  service?: string;
  instanceId?: string;
  name?: string;
  limit: number;
}

export interface GetServiceMapInput {
  limit: number;
}

export interface GenAiSummaryInput {
  traceId?: string;
  limit: number;
}

class InputError extends Error {}

type Raw = Record<string, unknown>;

function parse<T>(raw: unknown, build: (r: Raw) => T): Parsed<T> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { error: 'input must be a JSON object' };
  }
  try {
    return { value: build((raw ?? {}) as Raw) };
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
}

const absent = (v: unknown) => v === undefined || v === null;

function optString(r: Raw, key: string, max = MAX_FIELD_CHARS): string | undefined {
  const v = r[key];
  if (absent(v)) return undefined;
  if (typeof v !== 'string') throw new InputError(`${key} must be a string`);
  const s = v.trim().slice(0, max);
  return s || undefined;
}

function reqString(r: Raw, key: string): string {
  const s = optString(r, key);
  if (s === undefined) throw new InputError(`${key} is required`);
  return s;
}

function optNumber(r: Raw, key: string, min: number, max: number): number | undefined {
  const v = r[key];
  if (absent(v)) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InputError(`${key} must be a number ${min}–${max}`);
  return Math.min(max, Math.max(min, v));
}

function optBool(r: Raw, key: string): boolean | undefined {
  const v = r[key];
  if (absent(v)) return undefined;
  if (typeof v !== 'boolean') throw new InputError(`${key} must be true or false`);
  return v;
}

// Case-insensitive; returns the canonical spelling.
function optEnum<T extends string>(r: Raw, key: string, allowed: readonly T[]): T | undefined {
  const v = r[key];
  if (absent(v) || v === '') return undefined;
  if (typeof v === 'string') {
    const hit = allowed.find((a) => a.toLowerCase() === v.trim().toLowerCase());
    if (hit) return hit;
  }
  throw new InputError(`${key} must be one of: ${allowed.join(', ')}`);
}

function limit(r: Raw, maxItems: number): number {
  const cap = Math.max(1, Math.min(HARD_MAX_ITEMS, Math.floor(maxItems) || DEFAULT_MAX_ITEMS));
  const n = optNumber(r, 'limit', 1, cap);
  return n === undefined ? Math.min(DEFAULT_MAX_ITEMS, cap) : Math.floor(n);
}

const query = (r: Raw) => optString(r, 'query', MAX_QUERY_LENGTH);
const duration = (r: Raw) => optNumber(r, 'minDurationMs', 0, MAX_DURATION_MS);
const since = (r: Raw) => optNumber(r, 'sinceMinutes', 1, MAX_SINCE_MINUTES);

export function parseListServicesInput(raw: unknown): Parsed<ListServicesInput> {
  return parse(raw, () => ({}));
}

export function parseSearchTracesInput(raw: unknown, maxItems: number): Parsed<SearchTracesInput> {
  return parse(raw, (r) => ({
    query: query(r),
    service: optString(r, 'service'),
    status: optEnum(r, 'status', STATUS_VALUES),
    minDurationMs: duration(r),
    sinceMinutes: since(r),
    sort: optEnum(r, 'sort', TRACE_SORTS) ?? 'recent',
    groupBy: optString(r, 'groupBy'),
    limit: limit(r, maxItems),
  }));
}

export function parseFindSpansInput(raw: unknown, maxItems: number): Parsed<FindSpansInput> {
  return parse(raw, (r) => ({
    query: query(r),
    service: optString(r, 'service'),
    status: optEnum(r, 'status', STATUS_VALUES),
    minDurationMs: duration(r),
    sinceMinutes: since(r),
    sort: optEnum(r, 'sort', SPAN_SORTS) ?? 'duration',
    groupBy: optEnum(r, 'groupBy', SPAN_GROUPS) ?? 'none',
    limit: limit(r, maxItems),
  }));
}

export function parseGetTraceInput(raw: unknown): Parsed<GetTraceInput> {
  return parse(raw, (r) => ({
    traceId: optString(r, 'traceId'),
    spanId: optString(r, 'spanId'),
    includeLogs: optBool(r, 'includeLogs') ?? true,
  }));
}

export function parseCompareTracesInput(raw: unknown): Parsed<CompareTracesInput> {
  return parse(raw, (r) => ({
    traceId: reqString(r, 'traceId'),
    baselineTraceId: optString(r, 'baselineTraceId'),
  }));
}

export function parseQueryLogsInput(raw: unknown, maxItems: number): Parsed<QueryLogsInput> {
  return parse(raw, (r) => ({
    service: optString(r, 'service'),
    instanceId: optString(r, 'instanceId'),
    minSeverity: optEnum(r, 'minSeverity', SEVERITY_NAMES),
    text: optString(r, 'text', MAX_QUERY_LENGTH),
    traceId: optString(r, 'traceId'),
    spanId: optString(r, 'spanId'),
    sinceMinutes: since(r),
    limit: limit(r, maxItems),
  }));
}

export function parseQueryMetricsInput(raw: unknown, maxItems: number): Parsed<QueryMetricsInput> {
  return parse(raw, (r) => ({
    service: optString(r, 'service'),
    instanceId: optString(r, 'instanceId'),
    name: optString(r, 'name'),
    limit: limit(r, maxItems),
  }));
}

export function parseGetServiceMapInput(raw: unknown, maxItems: number): Parsed<GetServiceMapInput> {
  return parse(raw, (r) => ({ limit: limit(r, maxItems) }));
}

export function parseGenAiSummaryInput(raw: unknown, maxItems: number): Parsed<GenAiSummaryInput> {
  return parse(raw, (r) => ({
    traceId: optString(r, 'traceId'),
    limit: limit(r, maxItems),
  }));
}
