// SPDX-License-Identifier: Apache-2.0
// Cardinality panel view helpers: message types and validation, formatting, pricing form and sparkline
// geometry. Pure: no vscode or DOM.

import type { Signal, Volume } from '../../store/cardinality/sizes';
import type { ValueClass } from '../../store/cardinality/valueClass';
import type { MetricType } from '../../store/model';
import { CostEstimate, CostItem, DailyUsage, Pricing, PricingSource, sanitizeOverrides } from '../cardinalityCost';
import type { FindingKind, Growth, KeyScope, Rule, Severity } from '../cardinalityRules';
import type { CardinalityChange, ChangeVerdict, VolumeChange } from '../cardinalitySummary';

export type Tab = 'overview' | 'attributes' | 'metrics' | 'logs' | 'spanNames' | 'baseline' | 'pricing';
export const TABS: readonly Tab[] = ['overview', 'attributes', 'metrics', 'logs', 'spanNames', 'baseline', 'pricing'];
export const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  attributes: 'Attributes',
  metrics: 'Metrics',
  logs: 'Log patterns',
  spanNames: 'Span names',
  baseline: 'Baseline',
  pricing: 'Pricing',
};
export const DEFAULT_TAB: Tab = 'overview';

/** Tables whose rows open details; indexes refer to the rows of the update with the same `seq`. */
export type DetailTable = 'findings' | 'keys' | 'metrics' | 'templates' | 'spanNames';
const DETAIL_TABLES: readonly DetailTable[] = ['findings', 'keys', 'metrics', 'templates', 'spanNames'];

export interface PanelScope {
  realm: string;
  service?: string;
  instanceId?: string;
}

export interface ScopeOption {
  id: string;
  label: string;
}

/** What the scope pickers offer: realms, services of the current realm, instances of the current service. */
export interface ScopeOptions {
  realms: ScopeOption[];
  services: string[];
  instances: ScopeOption[];
}

export interface PanelSummary {
  /** null when nothing has been counted. */
  firstMs: number | null;
  lastMs: number | null;
  bucketMs: number;
  windowMinutes: number;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  /** Records per bucket, oldest first. */
  activity: Record<Signal, number[]>;
  activeSeries: number;
  services: number;
  findings: Record<Severity, number>;
  findingsTotal: number;
  rowsTruncated: boolean;
  droppedKeyOccurrences: number;
  cost?: { currency: string; monthlyTotal: number };
}

export interface FindingView {
  severity: Severity;
  rule: Rule;
  kind: FindingKind;
  service: string;
  signal: Signal;
  scope?: KeyScope;
  key: string;
  metric?: string;
  distinct: number;
  approx: boolean;
  proto: number;
  bytesShare: number;
  valueClass?: ValueClass;
  growth: Growth;
  driver?: { label: string; distinct: number };
}

export interface ServiceView {
  service: string;
  instances: number;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  findings: Record<Severity, number>;
  trackedKeys: number;
  droppedKeyOccurrences: number;
}

export interface KeyView {
  service: string;
  scope: KeyScope;
  key: string;
  distinct: number;
  approx: boolean;
  occurrences: number;
  proto: number;
  json: number;
  ratio: number;
  bytesShare: number;
  valueClass?: ValueClass;
  growth: Growth;
  severity?: Severity;
}

export interface MetricView {
  service: string;
  name: string;
  type: MetricType;
  series: number;
  approx: boolean;
  points: number;
  proto: number;
  json: number;
  growth: Growth;
  driver?: { key: string; distinct: number; approx: boolean };
  severity?: Severity;
}

export interface OperationView {
  service: string;
  name: string;
  count: number;
  errors: number;
  proto: number;
  json: number;
  other: boolean;
}

export interface TemplateView {
  service: string;
  text: string;
  count: number;
  share: number;
  proto: number;
  other: boolean;
  severity?: Severity;
}

export interface SpanNameView {
  service: string;
  distinct: number;
  approx: boolean;
  classified: number;
  withIds: number;
  severity?: Severity;
}

export interface VolumeChangeView extends Omit<VolumeChange, 'change'> {
  /** current / base - 1; null when the signal appeared. */
  change: number | null;
}

export type BaselineView =
  | { state: 'none' }
  | { state: 'loading'; name: string }
  | { state: 'unreadable'; name: string }
  | { state: 'noSummary'; name: string }
  | { state: 'noData'; name: string }
  | {
      state: 'ready';
      name: string;
      createdMs: number;
      fromMs: number;
      toMs: number;
      changes: CardinalityChange[];
      changesTotal: number;
      summary: Record<ChangeVerdict, number>;
      volume: VolumeChangeView[];
      addedServices: string[];
      missingServices: string[];
    };

export interface PricingView {
  settings: Pricing;
  overrides: Partial<Pricing>;
  effective: Pricing;
  source: PricingSource;
  usage: DailyUsage;
  cost?: CostEstimate;
}

export type TabData =
  | { tab: 'overview'; services: ServiceView[]; findings: FindingView[]; operations: OperationView[] }
  | { tab: 'attributes'; keys: KeyView[] }
  | { tab: 'metrics'; metrics: MetricView[] }
  | { tab: 'logs'; templates: TemplateView[] }
  | { tab: 'spanNames'; spanNames: SpanNameView[]; operations: OperationView[] }
  | { tab: 'baseline'; baseline: BaselineView }
  | { tab: 'pricing'; pricing: PricingView };

export interface LabelView {
  key: string;
  distinct: number;
  approx: boolean;
  valueClass?: ValueClass;
}

export type Details =
  | { kind: 'finding'; finding: FindingView; samples: string[]; hint?: string; prefer?: string[] }
  | {
      kind: 'key';
      row: KeyView;
      classes: [ValueClass, number][];
      samples: string[];
      /** Unique-value estimate per bucket, oldest first; null = open bucket or no data. */
      history: (number | null)[];
      hint?: string;
      prefer?: string[];
      /** The same key in other services of the scope. */
      others: { service: string; distinct: number; approx: boolean }[];
    }
  | { kind: 'metric'; row: MetricView; labels: LabelView[]; history: (number | null)[] }
  | { kind: 'template'; row: TemplateView; sample: string }
  | { kind: 'spanNames'; row: SpanNameView; samples: string[] };

// Host -> webview.
export type HostMessage =
  | { type: 'update'; seq: number; tab: Tab; scope: PanelScope; options: ScopeOptions; summary: PanelSummary; data: TabData }
  | { type: 'details'; seq: number; table: DetailTable; index: number; details: Details }
  | { type: 'disabled' }
  | { type: 'error'; message: string }
  | { type: 'timeZone'; useLocalTime: boolean };

export type SettingsSection = 'cardinality' | 'cost';

// Webview -> host.
export type ViewMessage =
  | { type: 'ready'; tab: Tab }
  | { type: 'setTab'; tab: Tab }
  | { type: 'setScope'; scope: PanelScope }
  | { type: 'select'; seq: number; table: DetailTable; index: number }
  | { type: 'setPricing'; overrides: Partial<Pricing> }
  | { type: 'resetPricing' }
  | { type: 'openSettings'; section: SettingsSection };

/** What the host last posted; webview messages are only honoured against it. */
export interface HostContext {
  seq: number;
  scope: PanelScope;
  options: ScopeOptions;
  /** Row counts of the detail tables in the last update. */
  tables: Partial<Record<DetailTable, number>>;
}

export const isTab = (v: unknown): v is Tab => typeof v === 'string' && (TABS as readonly string[]).includes(v);
const isDetailTable = (v: unknown): v is DetailTable => typeof v === 'string' && (DETAIL_TABLES as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function parseScope(v: unknown, ctx: HostContext): PanelScope | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  if (!isStr(s.realm) || !ctx.options.realms.some((r) => r.id === s.realm)) return undefined;
  const scope: PanelScope = { realm: s.realm };
  if (s.service === undefined) return s.instanceId === undefined ? scope : undefined;
  // Services and instances are only offered for the current realm (and instances for the current service).
  if (s.realm !== ctx.scope.realm || !isStr(s.service) || !ctx.options.services.includes(s.service)) return undefined;
  scope.service = s.service;
  if (s.instanceId === undefined) return scope;
  if (s.service !== ctx.scope.service || !isStr(s.instanceId) || !ctx.options.instances.some((i) => i.id === s.instanceId)) return undefined;
  scope.instanceId = s.instanceId;
  return scope;
}

/** Every field must be a known, valid pricing field; anything else rejects the whole message. */
function parseOverrides(v: unknown): Partial<Pricing> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const clean = sanitizeOverrides(v);
  return Object.keys(v).every((k) => hasOwn(clean, k)) ? clean : undefined;
}

/** Validates an untrusted webview message; undefined for anything malformed, stale or out of range. */
export function parseCardinalityMessage(m: unknown, ctx: HostContext): ViewMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const msg = m as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return { type: 'ready', tab: isTab(msg.tab) ? msg.tab : DEFAULT_TAB };
    case 'setTab':
      return isTab(msg.tab) ? { type: 'setTab', tab: msg.tab } : undefined;
    case 'setScope': {
      const scope = parseScope(msg.scope, ctx);
      return scope && { type: 'setScope', scope };
    }
    case 'select': {
      if (msg.seq !== ctx.seq || !isDetailTable(msg.table)) return undefined;
      const n = ctx.tables[msg.table] ?? 0;
      const i = msg.index;
      return Number.isInteger(i) && (i as number) >= 0 && (i as number) < n ? { type: 'select', seq: ctx.seq, table: msg.table, index: i as number } : undefined;
    }
    case 'setPricing': {
      const overrides = parseOverrides(msg.overrides);
      return overrides && { type: 'setPricing', overrides };
    }
    case 'resetPricing':
      return { type: 'resetPricing' };
    case 'openSettings':
      return msg.section === 'cardinality' || msg.section === 'cost' ? { type: 'openSettings', section: msg.section } : undefined;
    default:
      return undefined;
  }
}

export interface CardinalityViewState {
  tab: Tab;
}

export function loadViewState(raw: unknown): CardinalityViewState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { tab: isTab(r.tab) ? r.tab : DEFAULT_TAB };
}

// --- Pricing form ---------------------------------------------------------------------------

/** Text from a number input: '' → null (no price), a valid number → it, anything else → undefined. */
export function parseNumberInput(text: string, opts: { min: number; max: number; integer?: boolean; allowEmpty?: boolean }): number | null | undefined {
  const t = text.trim();
  if (!t) return opts.allowEmpty === false ? undefined : null;
  if (!/^[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?$/i.test(t)) return undefined;
  const v = Number(t);
  if (!Number.isFinite(v) || v < opts.min || v > opts.max) return undefined;
  if (opts.integer && !Number.isInteger(v)) return undefined;
  return v;
}

/** The fields of a submitted form that differ from the settings, i.e. the workspace overrides. */
export function overridesFrom(form: Pricing, settings: Pricing): Partial<Pricing> {
  const out: Partial<Pricing> = {};
  for (const key of Object.keys(settings) as (keyof Pricing)[]) {
    if (form[key] !== settings[key]) (out as Record<string, unknown>)[key] = form[key];
  }
  return out;
}

// --- Labels and formatting ------------------------------------------------------------------

export const SEVERITY_GLYPH: Record<Severity, string> = { critical: '✖', warning: '▲', info: 'ℹ' };
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
export const GROWTH_LABEL: Record<Growth, string> = { growing: '↗ growing', saturated: '→ saturated', insufficient: '… too little data' };
export const SIGNAL_LABEL: Record<Signal, string> = { traces: 'Spans', logs: 'Logs', metrics: 'Metric points' };
export const SCOPE_LABEL: Record<KeyScope, string> = { span: 'span', 'span.event': 'span event', log: 'log', metric: 'metric label' };
export const VERDICT_GLYPH: Record<ChangeVerdict, string> = { new: '✚', grown: '⬆', resolved: '✔' };
export const VERDICT_LABEL: Record<ChangeVerdict, string> = { new: 'New', grown: 'Grown', resolved: 'Resolved' };
export const RULE_LABEL: Record<Rule, string> = {
  R1: 'Many unique values',
  R2: 'ID-like values',
  R3: 'Many metric series',
  R4: 'Many span names',
  R6: 'Noisy log pattern',
};
export const COST_ITEM_LABEL: Record<CostItem, string> = {
  ingest: 'Ingest',
  spans: 'Spans',
  logs: 'Log records',
  series: 'Metric series',
  retention: 'Retained storage',
};
export const CLASS_LABEL: Record<ValueClass, string> = {
  uuid: 'UUID',
  hexId: 'hex ID',
  numericId: 'numeric ID',
  token: 'token',
  email: 'email',
  ip: 'IP address',
  timestamp: 'timestamp',
  urlQuery: 'URL with query',
  pathId: 'path with ID',
  freeText: 'free text',
  number: 'number',
  other: 'other',
};

const trim1 = (n: number) => n.toFixed(1).replace(/\.0$/, '');

export function formatCount(n: number, approx = false): string {
  return `${approx ? '≈' : ''}${Math.round(n).toLocaleString('en-US')}`;
}

/** Compact count for cards: 950, 12.3K, 4.1M. */
export function formatCompact(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return a < 10 && !Number.isInteger(n) ? trim1(n) : `${Math.round(n)}`;
  if (a < 1e6) return `${trim1(n / 1e3)}K`;
  if (a < 1e9) return `${trim1(n / 1e6)}M`;
  return `${trim1(n / 1e9)}B`;
}

export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b < 1024) return `${Math.round(Number.isFinite(b) ? b : 0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? trim1(v) : Math.round(v)} ${units[u]}`;
}

export function formatPercent(r: number): string {
  const pct = r * 100;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return pct < 10 ? `${trim1(pct)}%` : `${Math.round(pct)}%`;
}

export function formatSignedPercent(change: number | null): string {
  if (change === null) return 'new';
  const p = Math.round(change * 100);
  return `${p >= 0 ? '+' : '−'}${Math.abs(p)}%`;
}

export function formatMinutes(min: number): string {
  if (min <= 0) return '–';
  if (min < 1) return `${Math.round(min * 60)} s`;
  if (min < 120) return `${Math.round(min)} min`;
  if (min < 2880) return `${trim1(min / 60)} h`;
  return `${trim1(min / 1440)} days`;
}

export function formatMoney(amount: number, currency: string): string {
  const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** Per-minute rate projected to a day and a 30-day month. */
export function projections(perMinute: number): { day: number; month: number } {
  return { day: perMinute * 1440, month: perMinute * 1440 * 30 };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** What a finding is about, e.g. "user.id (span)", "http.requests by user.id", "span names". */
export function findingSubject(f: Pick<FindingView, 'kind' | 'key' | 'scope' | 'metric'>): string {
  if (f.kind === 'attribute') return `${f.key} (${SCOPE_LABEL[f.scope ?? 'span']})`;
  if (f.kind === 'metricLabel') return `${f.metric ?? ''} by ${f.key}`;
  return f.key;
}

// --- Sparkline ------------------------------------------------------------------------------

/** SVG path through the finite values; gaps (null) break the line, a lone point becomes a short dash. */
export function sparklinePath(values: readonly (number | null)[], width: number, height: number): string {
  let max = 0;
  for (const v of values) if (v !== null && Number.isFinite(v) && v > max) max = v;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const r = (n: number) => +n.toFixed(2);
  const y = (v: number) => r(max > 0 ? height - (v / max) * height : height);
  let path = '';
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length === 1) {
      const [x, py] = run[0];
      const d = Math.max(1, step / 2);
      run.push([x + d <= width ? x + d : x - d, py]);
    }
    if (run.length) path += `M${run.map(([px, py]) => `${r(px)},${py}`).join('L')}`;
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) flush();
    else run.push([i * step, y(v)]);
  });
  flush();
  return path;
}
