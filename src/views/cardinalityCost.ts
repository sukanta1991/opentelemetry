// SPDX-License-Identifier: Apache-2.0
// Cost estimates from local usage rates and user-supplied backend prices. Nothing is priced unless the
// user sets a price; every figure is an estimate with its assumptions listed. No vscode import.

export type SizeModel = 'protobuf' | 'json';

export interface Pricing {
  /** ISO 4217 code, display only. */
  currency: string;
  perGbIngested: number | null;
  perMillionSpans: number | null;
  perMillionLogs: number | null;
  perSeriesMonth: number | null;
  perGbMonthRetained: number | null;
  retentionDays: number | null;
  sizeModel: SizeModel;
  /** Scales local traffic up (or down) to the expected production volume. */
  trafficMultiplier: number;
}

export type PriceKey = 'perGbIngested' | 'perMillionSpans' | 'perMillionLogs' | 'perSeriesMonth' | 'perGbMonthRetained';

export const PRICE_KEYS: readonly PriceKey[] = ['perGbIngested', 'perMillionSpans', 'perMillionLogs', 'perSeriesMonth', 'perGbMonthRetained'];

export const MAX_PRICE = 1_000_000;
/** workspaceState key of the panel's pricing overrides. */
export const PRICING_OVERRIDES_KEY = 'otel.cost.overrides';
export const MAX_RETENTION_DAYS = 3650;
export const MAX_TRAFFIC_MULTIPLIER = 1_000_000;
const CURRENCY = /^[A-Z]{3}$/;
const DAYS_PER_MONTH = 30;
const BYTES_PER_GB = 1e9;

export const DEFAULT_PRICING: Readonly<Pricing> = Object.freeze({
  currency: 'USD',
  perGbIngested: null,
  perMillionSpans: null,
  perMillionLogs: null,
  perSeriesMonth: null,
  perGbMonthRetained: null,
  retentionDays: null,
  sizeModel: 'protobuf',
  trafficMultiplier: 1,
});

const PRICING_KEYS = Object.keys(DEFAULT_PRICING) as (keyof Pricing)[];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One field from user input, or undefined when absent or invalid (null is a valid "no price"). */
function field<K extends keyof Pricing>(key: K, v: unknown): Pricing[K] | undefined {
  if (key === 'currency') return (typeof v === 'string' && CURRENCY.test(v) ? v : undefined) as Pricing[K] | undefined;
  if (key === 'sizeModel') return (v === 'protobuf' || v === 'json' ? v : undefined) as Pricing[K] | undefined;
  if (key === 'trafficMultiplier') {
    return (isNum(v) && v > 0 && v <= MAX_TRAFFIC_MULTIPLIER ? v : undefined) as Pricing[K] | undefined;
  }
  if (v === null) return null as Pricing[K];
  if (key === 'retentionDays') {
    return (isNum(v) && Number.isInteger(v) && v >= 1 && v <= MAX_RETENTION_DAYS ? v : undefined) as Pricing[K] | undefined;
  }
  return (isNum(v) && v >= 0 && v <= MAX_PRICE ? v : undefined) as Pricing[K] | undefined;
}

/** Pricing from user input: invalid or missing fields take the defaults (no price). */
export function sanitizePricing(raw: unknown): Pricing {
  const out: Pricing = { ...DEFAULT_PRICING };
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const key of PRICING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(r, key)) continue;
    const v = field(key, r[key]);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Valid override fields only; an explicit null clears a price. */
export function sanitizeOverrides(raw: unknown): Partial<Pricing> {
  const out: Partial<Pricing> = {};
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const key of PRICING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(r, key)) continue;
    const v = field(key, r[key]);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

export type PricingSource = 'settings' | 'workspace';

/** Settings as defaults, workspace overrides on top. */
export function effectivePricing(settings: Pricing, overrides: unknown): { pricing: Pricing; source: PricingSource } {
  const o = sanitizeOverrides(overrides);
  return { pricing: { ...settings, ...o }, source: Object.keys(o).length ? 'workspace' : 'settings' };
}

export function hasPrices(p: Pricing): boolean {
  return PRICE_KEYS.some((k) => p[k] !== null);
}

/** Observed usage per day (before the traffic multiplier). */
export interface DailyUsage {
  bytes: Record<SizeModel, number>;
  spans: number;
  logs: number;
  /** Unique metric series seen since the counters started. */
  activeSeries: number;
  /** Minutes of data the rates are based on. */
  windowMinutes: number;
}

export type CostItem = 'ingest' | 'spans' | 'logs' | 'series' | 'retention';

export interface CostLine {
  item: CostItem;
  quantity: number;
  unit: string;
  unitPrice: number;
  monthly: number;
}

export interface CostEstimate {
  currency: string;
  sizeModel: SizeModel;
  trafficMultiplier: number;
  lines: CostLine[];
  monthlyTotal: number;
  assumptions: string[];
}

/** Monthly cost per priced item, or undefined when no price is set. */
export function estimateCost(usage: DailyUsage, p: Pricing): CostEstimate | undefined {
  if (!hasPrices(p)) return undefined;
  const m = p.trafficMultiplier;
  const gbPerDay = (usage.bytes[p.sizeModel] * m) / BYTES_PER_GB;
  const lines: CostLine[] = [];
  const add = (item: CostItem, quantity: number, unit: string, unitPrice: number | null, monthly: number) => {
    if (unitPrice !== null) lines.push({ item, quantity, unit, unitPrice, monthly });
  };
  const gbMonth = gbPerDay * DAYS_PER_MONTH;
  add('ingest', gbMonth, 'GB/month', p.perGbIngested, gbMonth * (p.perGbIngested ?? 0));
  const spansMonth = (usage.spans * m * DAYS_PER_MONTH) / 1e6;
  add('spans', spansMonth, 'million spans/month', p.perMillionSpans, spansMonth * (p.perMillionSpans ?? 0));
  const logsMonth = (usage.logs * m * DAYS_PER_MONTH) / 1e6;
  add('logs', logsMonth, 'million logs/month', p.perMillionLogs, logsMonth * (p.perMillionLogs ?? 0));
  add('series', usage.activeSeries, 'active series', p.perSeriesMonth, usage.activeSeries * (p.perSeriesMonth ?? 0));
  const assumptions = [
    `Rates come from the last ${formatMinutes(usage.windowMinutes)} of local data, projected to ${DAYS_PER_MONTH}-day months.`,
    `Sizes are uncompressed OTLP ${p.sizeModel === 'json' ? 'JSON' : 'protobuf'} estimated locally; 1 GB = 10^9 bytes. Start times, exemplars and dropped counts are not kept locally, so real payloads are somewhat larger.`,
    m === 1 ? 'No traffic multiplier: local volume is priced as is.' : `Traffic multiplier ×${m} applied to volume (not to metric series).`,
    'Active series = unique metric series since the counters started (not a monthly peak).',
    'Compression, sampling, indexing fees, free tiers and minimum commitments are not modelled.',
  ];
  if (p.perGbMonthRetained !== null) {
    if (p.retentionDays === null) {
      assumptions.push('Retention cost needs retention days; it is left out.');
    } else {
      const stored = gbPerDay * p.retentionDays;
      add('retention', stored, `GB stored (${p.retentionDays} days)`, p.perGbMonthRetained, stored * p.perGbMonthRetained);
    }
  }
  return {
    currency: p.currency,
    sizeModel: p.sizeModel,
    trafficMultiplier: m,
    lines,
    monthlyTotal: lines.reduce((s, l) => s + l.monthly, 0),
    assumptions,
  };
}

function formatMinutes(min: number): string {
  if (min >= 120) return `${Math.round(min / 60)} hours`;
  const rounded = Math.max(1, Math.round(min));
  return rounded === 1 ? '1 minute' : `${rounded} minutes`;
}
