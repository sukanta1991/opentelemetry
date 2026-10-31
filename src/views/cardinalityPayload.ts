// SPDX-License-Identifier: Apache-2.0
// Slim cardinality panel payloads built from the model: a summary, the rows of one tab, and details for
// one row on demand, so update messages stay small (P4). No vscode import.

import { Signal } from '../store/cardinality/sizes';
import { CostEstimate, Pricing, effectivePricing, estimateCost, sanitizeOverrides } from './cardinalityCost';
import { CardinalityModel, KeyRow, MAX_ROWS, MetricRow, OperationRow, ServiceRow, SpanNameRow, TemplateRow, dailyUsage } from './cardinalityModel';
import { compareCardinality } from './cardinalityBaseline';
import { CardinalitySettings, Finding } from './cardinalityRules';
import { CardinalitySummary } from './cardinalitySummary';
import {
  BaselineView,
  DetailTable,
  Details,
  FindingView,
  KeyView,
  MetricView,
  OperationView,
  PanelScope,
  PanelSummary,
  PricingView,
  ServiceView,
  SpanNameView,
  Tab,
  TabData,
  TemplateView,
  truncate,
} from './webview/cardinalityView';

/** Template text and finding keys in tables; details carry the full text. */
export const MAX_TABLE_TEXT = 300;
/** Same key in other services, listed in key details. */
export const MAX_OTHER_SERVICES = 50;
export const OVERVIEW_OPERATIONS = 10;

const SIGNALS: readonly Signal[] = ['traces', 'logs', 'metrics'];
const finite = (v: number) => (Number.isFinite(v) ? v : null);
const historyOf = (h: readonly number[]) => h.map(finite);

export function summaryOf(model: CardinalityModel, cost?: CostEstimate): PanelSummary {
  const findings = { critical: 0, warning: 0, info: 0 };
  let dropped = 0;
  for (const s of model.services) {
    findings.critical += s.findings.critical;
    findings.warning += s.findings.warning;
    findings.info += s.findings.info;
    dropped += s.droppedKeyOccurrences;
  }
  const activity = { traces: [] as number[], logs: [] as number[], metrics: [] as number[] };
  for (const s of SIGNALS) activity[s] = model.buckets[s].count;
  const summary: PanelSummary = {
    firstMs: finite(model.firstMs),
    lastMs: finite(model.lastMs),
    bucketMs: model.bucketMs,
    windowMinutes: model.windowMinutes,
    totals: model.totals,
    perMinute: model.perMinute,
    activity,
    activeSeries: model.activeSeries,
    services: model.services.length,
    findings,
    findingsTotal: model.findingsTotal,
    rowsTruncated: model.rowsTruncated || model.services.length > MAX_ROWS,
    droppedKeyOccurrences: dropped,
  };
  if (cost) summary.cost = { currency: cost.currency, monthlyTotal: cost.monthlyTotal };
  return summary;
}

export function findingView(f: Finding, maxText = MAX_TABLE_TEXT): FindingView {
  const v: FindingView = {
    severity: f.severity,
    rule: f.rule,
    kind: f.kind,
    service: f.service,
    signal: f.signal,
    key: truncate(f.key, maxText),
    distinct: f.distinct,
    approx: f.approx,
    proto: f.proto,
    bytesShare: f.bytesShare,
    growth: f.growth,
  };
  if (f.scope) v.scope = f.scope;
  if (f.metric !== undefined) v.metric = f.metric;
  if (f.valueClass) v.valueClass = f.valueClass;
  if (f.driver) v.driver = { label: f.driver.label, distinct: f.driver.distinct };
  return v;
}

const serviceView = (s: ServiceRow): ServiceView => ({
  service: s.service,
  instances: s.instances,
  totals: s.totals,
  perMinute: s.perMinute,
  findings: s.findings,
  trackedKeys: s.trackedKeys,
  droppedKeyOccurrences: s.droppedKeyOccurrences,
});

function keyView(k: KeyRow): KeyView {
  const v: KeyView = {
    service: k.service,
    scope: k.scope,
    key: k.key,
    distinct: k.distinct,
    approx: k.approx,
    occurrences: k.occurrences,
    proto: k.proto,
    json: k.json,
    ratio: k.ratio,
    bytesShare: k.bytesShare,
    growth: k.growth,
  };
  if (k.valueClass) v.valueClass = k.valueClass;
  if (k.severity) v.severity = k.severity;
  return v;
}

function metricView(m: MetricRow): MetricView {
  const v: MetricView = {
    service: m.service,
    name: m.name,
    type: m.type,
    series: m.series,
    approx: m.approx,
    points: m.points,
    proto: m.proto,
    json: m.json,
    growth: m.growth,
  };
  // Labels are sorted by unique values, so the first one drives the series count.
  const top = m.labels[0];
  if (top) v.driver = { key: top.key, distinct: top.distinct, approx: top.approx };
  if (m.severity) v.severity = m.severity;
  return v;
}

const operationView = (o: OperationRow): OperationView => ({
  service: o.service,
  name: o.name,
  count: o.count,
  errors: o.errors,
  proto: o.proto,
  json: o.json,
  other: o.other,
});

function templateView(t: TemplateRow, maxText = MAX_TABLE_TEXT): TemplateView {
  const v: TemplateView = { service: t.service, text: truncate(t.text, maxText), count: t.count, share: t.share, proto: t.proto, other: t.other };
  if (t.severity) v.severity = t.severity;
  return v;
}

function spanNameView(s: SpanNameRow): SpanNameView {
  const v: SpanNameView = { service: s.service, distinct: s.distinct, approx: s.approx, classified: s.classified, withIds: s.withIds };
  if (s.severity) v.severity = s.severity;
  return v;
}

export interface TabSources {
  pricing: () => PricingView;
  baseline: () => BaselineView;
}

export function tabData(tab: Tab, model: CardinalityModel, sources: TabSources): TabData {
  switch (tab) {
    case 'overview':
      return {
        tab,
        services: model.services.slice(0, MAX_ROWS).map(serviceView),
        findings: model.findings.map((f) => findingView(f)),
        operations: model.operations.slice(0, OVERVIEW_OPERATIONS).map(operationView),
      };
    case 'attributes':
      return { tab, keys: model.keys.map(keyView) };
    case 'metrics':
      return { tab, metrics: model.metrics.map(metricView) };
    case 'logs':
      return { tab, templates: model.templates.map((t) => templateView(t)) };
    case 'spanNames':
      return { tab, spanNames: model.spanNames.map(spanNameView), operations: model.operations.map(operationView) };
    case 'baseline':
      return { tab, baseline: sources.baseline() };
    case 'pricing':
      return { tab, pricing: sources.pricing() };
  }
}

/** Row counts of the tables in `data` whose rows open details. */
export function detailTables(data: TabData): Partial<Record<DetailTable, number>> {
  switch (data.tab) {
    case 'overview':
      return { findings: data.findings.length };
    case 'attributes':
      return { keys: data.keys.length };
    case 'metrics':
      return { metrics: data.metrics.length };
    case 'logs':
      return { templates: data.templates.length };
    case 'spanNames':
      return { spanNames: data.spanNames.length };
    default:
      return {};
  }
}

/** Details for one row; the index refers to the model the last update was built from. */
export function detailsOf(model: CardinalityModel, table: DetailTable, index: number): Details | undefined {
  switch (table) {
    case 'findings': {
      const f = model.findings[index];
      if (!f) return undefined;
      const d: Details = { kind: 'finding', finding: findingView(f, Infinity), samples: [...f.samples] };
      if (f.hint) d.hint = f.hint;
      if (f.prefer?.length) d.prefer = [...f.prefer];
      return d;
    }
    case 'keys': {
      const k = model.keys[index];
      if (!k) return undefined;
      const others = model.keys
        .filter((o) => o !== k && o.scope === k.scope && o.key === k.key)
        .slice(0, MAX_OTHER_SERVICES)
        .map((o) => ({ service: o.service, distinct: o.distinct, approx: o.approx }));
      const d: Details = {
        kind: 'key',
        row: keyView(k),
        classes: k.classes.map(([c, n]): [typeof c, number] => [c, n]),
        samples: [...k.samples],
        history: historyOf(k.history),
        others,
      };
      if (k.hint) d.hint = k.hint;
      if (k.prefer?.length) d.prefer = [...k.prefer];
      return d;
    }
    case 'metrics': {
      const m = model.metrics[index];
      return m && { kind: 'metric', row: metricView(m), labels: m.labels.map((l) => ({ ...l })), history: historyOf(m.history) };
    }
    case 'templates': {
      const t = model.templates[index];
      return t && { kind: 'template', row: templateView(t, Infinity), sample: t.sample };
    }
    case 'spanNames': {
      const s = model.spanNames[index];
      return s && { kind: 'spanNames', row: spanNameView(s), samples: [...s.samples] };
    }
  }
}

export function pricingView(model: CardinalityModel, settings: Pricing, overrides: unknown): PricingView {
  const { pricing, source } = effectivePricing(settings, overrides);
  const usage = dailyUsage(model);
  const view: PricingView = { settings, overrides: sanitizeOverrides(overrides), effective: pricing, source, usage };
  const cost = estimateCost(usage, pricing);
  if (cost) view.cost = cost;
  return view;
}

export interface BaselineSource {
  name: string;
  createdMs: number;
  summary: CardinalitySummary;
}

/** The scope's current summary against the baseline's, limited to the scope's service when one is picked. */
export function baselineView(base: BaselineSource, current: CardinalitySummary | undefined, scope: PanelScope, settings: CardinalitySettings): BaselineView {
  if (!current) return { state: 'noData', name: base.name };
  const before = scope.service === undefined ? base.summary : { ...base.summary, services: base.summary.services.filter((s) => s.service === scope.service) };
  const c = compareCardinality(before, current, settings);
  return {
    state: 'ready',
    name: base.name,
    createdMs: base.createdMs,
    fromMs: base.summary.fromMs,
    toMs: base.summary.toMs,
    changes: c.changes.slice(0, MAX_ROWS),
    changesTotal: c.changes.length,
    summary: c.summary,
    volume: c.volume.slice(0, MAX_ROWS).map((v) => ({ ...v, change: Number.isFinite(v.change) ? v.change : null })),
    addedServices: c.addedServices.slice(0, MAX_ROWS),
    missingServices: c.missingServices.slice(0, MAX_ROWS),
  };
}
