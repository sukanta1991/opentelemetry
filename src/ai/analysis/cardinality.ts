// SPDX-License-Identifier: Apache-2.0
// otel_analyzeCardinality: telemetry patterns that drive storage, indexing or ingestion cost, with an
// estimate only when the user supplied prices.

import { byCodeUnit } from '../../compare';
import { Signal } from '../../store/cardinality/sizes';
import { LIVE_REALM, TelemetryStore } from '../../store/store';
import { captureCardinality } from '../../views/cardinalityBaseline';
import { DEFAULT_PRICING, Pricing, PricingSource, estimateCost } from '../../views/cardinalityCost';
import { CardinalityModel, CardinalityScope, buildCardinalityModel, dailyUsage } from '../../views/cardinalityModel';
import { baselineView } from '../../views/cardinalityPayload';
import { CardinalitySettings, DEFAULT_CARDINALITY_SETTINGS, Finding } from '../../views/cardinalityRules';
import { CLASS_LABEL, RULE_LABEL, findingSubject } from '../../views/webview/cardinalityView';
import { AnalyzeCardinalityInput } from '../toolInputs';
import { AnalysisContext, AnalysisOutput, errorOutput, pct, round1 } from './common';

/** Prepared by the VS Code adapter from settings and the panel's workspace overrides. */
export interface CardinalityInputs {
  settings: CardinalitySettings;
  pricing: Pricing;
  pricingSource: PricingSource;
}

const MAX_KNOWN = 20;
const TOP_SERVICES = 10;
const TOP_OPERATIONS = 10;
const TOP_PATTERNS = 5;
const TOP_METRICS = 5;
const TOP_CHANGES = 10;
const MAX_PATTERN = 200;
const SIGNAL_OF = { spans: 'traces', logs: 'logs', metrics: 'metrics' } as const;
const NO_PRICES =
  'No prices are set, so no cost is estimated. The user can enter backend prices in the otel.cost.* settings or the Pricing tab of the Cardinality & Cost panel.';

const known = (names: readonly string[]) => names.slice(0, MAX_KNOWN).join(', ') || '(none)';
const iso = (ms: number) => new Date(ms).toISOString();
const bytesPerMin = (v: Record<Signal, { proto: number }>) => v.traces.proto + v.logs.proto + v.metrics.proto;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function resolveScope(store: TelemetryStore, input: AnalyzeCardinalityInput): { scope: CardinalityScope; data: string } | { error: string } {
  let realm = LIVE_REALM;
  let data = 'live';
  if (input.session) {
    const want = input.session.toLowerCase();
    const s = store.getImportedSessions().find((v) => v.session.id === input.session || v.session.source.toLowerCase() === want);
    if (!s) return { error: `no loaded session ${JSON.stringify(input.session)}; loaded sessions: ${known(store.getImportedSessions().map((v) => v.session.source))}` };
    realm = s.session.id;
    data = s.session.source;
  }
  const counted = store.getAllInstances().filter((i) => i.usage && i.realm === realm);
  const services = [...new Set(counted.map((i) => i.serviceName))].sort(byCodeUnit);
  const scope: CardinalityScope = { realm };
  if (input.instanceId) {
    const inst = counted.find((i) => i.id === input.instanceId);
    if (!inst) return { error: `instance ${JSON.stringify(input.instanceId)} not found in ${data} data; known instances: ${known(counted.map((i) => i.id).sort(byCodeUnit))}` };
    if (input.service && inst.serviceName.toLowerCase() !== input.service.toLowerCase()) {
      return { error: `instance ${JSON.stringify(input.instanceId)} belongs to service ${JSON.stringify(inst.serviceName)}` };
    }
    return { scope: { realm, service: inst.serviceName, instanceId: inst.id }, data };
  }
  if (input.service) {
    const want = input.service.toLowerCase();
    const service = services.find((s) => s.toLowerCase() === want);
    if (!service) return { error: `no counted service ${JSON.stringify(input.service)} in ${data} data; known services: ${known(services)}` };
    scope.service = service;
  }
  return { scope, data };
}

function findingRow(f: Finding): Record<string, unknown> {
  const r: Record<string, unknown> = {
    severity: f.severity,
    rule: f.rule,
    why: RULE_LABEL[f.rule],
    service: f.service,
    signal: f.signal,
    subject: findingSubject(f),
    unique: f.distinct,
  };
  if (f.approx) r.approximate = true;
  if (f.kind === 'attribute' || f.kind === 'metricLabel') r.attribute = f.key;
  if (f.metric !== undefined || f.kind === 'metricSeries') r.metric = f.metric ?? f.key;
  if (f.occurrences && f.kind === 'attribute') r.uniquePerUsePct = pct(Math.min(f.distinct, f.occurrences), f.occurrences);
  if (f.valueClass) r.valuesLookLike = CLASS_LABEL[f.valueClass];
  r.growth = f.growth;
  r.bytesSharePct = round1(f.bytesShare * 100);
  if (f.driver) r.drivingLabel = { label: f.driver.label, unique: f.driver.distinct };
  if (f.samples.length) r.examples = [...f.samples];
  if (f.hint) r.hint = f.hint;
  if (f.prefer?.length) r.groupByInstead = [...f.prefer];
  return r;
}

function volume(model: CardinalityModel, signal: AnalyzeCardinalityInput['signal']): Record<string, unknown> {
  const day = dailyUsage(model);
  const all = signal === 'all';
  const out: Record<string, unknown> = { rateFromLastMinutes: round1(model.windowMinutes) };
  if (all || signal === 'spans') out.spansPerDay = Math.round(day.spans);
  if (all || signal === 'logs') out.logsPerDay = Math.round(day.logs);
  if (all || signal === 'metrics') {
    out.metricPointsPerDay = Math.round(model.perMinute.metrics.count * 1440);
    out.activeSeries = model.activeSeries;
  }
  const s = all ? undefined : SIGNAL_OF[signal];
  const bytes = (field: 'proto' | 'json') => (s ? model.perMinute[s][field] : model.perMinute.traces[field] + model.perMinute.logs[field] + model.perMinute.metrics[field]) * 1440;
  out.bytesPerDay = { protobuf: Math.round(bytes('proto')), json: Math.round(bytes('json')) };
  return out;
}

export function analyzeCardinality(store: TelemetryStore, input: AnalyzeCardinalityInput, ctx: AnalysisContext): AnalysisOutput {
  if (!store.isCardinalityEnabled()) {
    return errorOutput('The cardinality analyzer is turned off. Ask the user to enable the otel.cardinality.enabled setting; counting starts from the next telemetry received.');
  }
  const resolved = resolveScope(store, input);
  if ('error' in resolved) return errorOutput(resolved.error);
  const { scope, data } = resolved;
  const inputs = ctx.cardinality ?? { settings: DEFAULT_CARDINALITY_SETTINGS, pricing: DEFAULT_PRICING, pricingSource: 'settings' as const };
  const redact = (key: string, text: string) => {
    if (!key) return ctx.redactor.text(text);
    const v = ctx.redactor.attrs({ [key]: text })[key];
    return typeof v === 'string' ? v : '';
  };
  const model = buildCardinalityModel(store.getAllInstances(), scope, inputs.settings, { redact });
  const scopeOut: Record<string, unknown> = { data };
  if (scope.service) scopeOut.service = scope.service;
  if (scope.instanceId) scopeOut.instanceId = scope.instanceId;
  if (!Number.isFinite(model.firstMs)) {
    return { result: { scope: scopeOut, note: 'Nothing has been counted in this scope yet. Counting starts when telemetry arrives (or when a session is loaded).' }, refs: [] };
  }

  const signal = input.signal;
  const wanted = signal === 'all' ? undefined : SIGNAL_OF[signal];
  const findings = model.findings.filter((f) => !wanted || f.signal === wanted);
  const severities = { critical: 0, warning: 0, info: 0 };
  for (const s of wanted ? [wanted] : (['traces', 'logs', 'metrics'] as const)) {
    for (const sev of ['critical', 'warning', 'info'] as const) severities[sev] += model.findingCounts[s][sev];
  }
  const total = severities.critical + severities.warning + severities.info;

  const result: Record<string, unknown> = {
    scope: scopeOut,
    window: { from: iso(model.firstMs), to: iso(model.lastMs) },
    summary: {
      services: model.services.length,
      findings: severities,
      ...(total > Math.min(findings.length, input.limit) ? { findingsListed: Math.min(findings.length, input.limit), findingsTotal: total } : {}),
      ...(model.rowsTruncated ? { truncated: 'some tables were cut to their largest rows' } : {}),
    },
    volume: volume(model, signal),
    findings: findings.slice(0, input.limit).map(findingRow),
    noisiestServices: [...model.services]
      .sort((a, b) => bytesPerMin(b.perMinute) - bytesPerMin(a.perMinute) || byCodeUnit(a.service, b.service))
      .slice(0, TOP_SERVICES)
      .map((s) => ({
        service: s.service,
        instances: s.instances,
        perMinute: {
          spans: round1(s.perMinute.traces.count),
          logs: round1(s.perMinute.logs.count),
          metricPoints: round1(s.perMinute.metrics.count),
          bytesProtobuf: Math.round(bytesPerMin(s.perMinute)),
        },
        findings: s.findings,
      })),
  };
  if (signal === 'all' || signal === 'spans') {
    result.noisiestOperations = model.operations
      .slice(0, TOP_OPERATIONS)
      .map((o) => ({ service: o.service, operation: o.other ? '(other operations)' : o.name, spans: o.count, errors: o.errors, bytes: o.proto }));
  }
  if (signal === 'all' || signal === 'logs') {
    result.topLogPatterns = model.templates
      .slice(0, TOP_PATTERNS)
      .map((t) => ({ service: t.service, pattern: t.other ? '(other patterns)' : cut(t.text, MAX_PATTERN), logs: t.count, sharePct: round1(t.share * 100) }));
  }
  if (signal === 'all' || signal === 'metrics') {
    result.topMetricsBySeries = [...model.metrics]
      .sort((a, b) => b.series - a.series || byCodeUnit(a.service, b.service) || byCodeUnit(a.name, b.name))
      .slice(0, TOP_METRICS)
      .map((m) => ({ service: m.service, metric: m.name, series: m.series, ...(m.labels[0] ? { drivingLabel: m.labels[0].key } : {}) }));
  }

  const cost = estimateCost(dailyUsage(model), inputs.pricing);
  result.cost = cost
    ? {
        currency: cost.currency,
        monthlyTotal: Math.round(cost.monthlyTotal * 100) / 100,
        lines: cost.lines.map((l) => ({ item: l.item, quantity: round1(l.quantity), unit: l.unit, unitPrice: l.unitPrice, monthly: Math.round(l.monthly * 100) / 100 })),
        pricingSource: inputs.pricingSource,
        assumptions: cost.assumptions,
      }
    : { note: NO_PRICES };

  const delta = baselineDelta(store, scope, inputs.settings, ctx);
  if (delta) result.baselineDelta = delta;
  result.note = 'Counts cover everything received since counting started; "unique" is approximate above 128 values. Examples are redacted.';
  return { result, refs: [], listKey: 'findings' };
}

function baselineDelta(store: TelemetryStore, scope: CardinalityScope, settings: CardinalitySettings, ctx: AnalysisContext): Record<string, unknown> | undefined {
  const active = ctx.baselines?.list.find((b) => b.active);
  const summary = active && ctx.baselines?.bodies.get(active.id)?.cardinality;
  if (!active || !summary) return undefined;
  const view = baselineView({ name: active.name, createdMs: active.createdMs, summary }, captureCardinality(store.getAllInstances(), scope), scope, settings);
  if (view.state !== 'ready') return undefined;
  return {
    baseline: active.name,
    capturedAt: iso(active.createdMs),
    summary: view.summary,
    changes: view.changes.slice(0, TOP_CHANGES).map((c) => ({
      change: c.verdict,
      service: c.service,
      [c.kind === 'metric' ? 'metric' : 'attribute']: c.key,
      unique: [c.base ?? null, c.current ?? null],
    })),
    volumeChanges: view.volume.slice(0, TOP_CHANGES).map((v) => ({
      service: v.service,
      signal: v.signal,
      perMinute: [round1(v.base), round1(v.current)],
      changePct: v.change === null ? null : round1(v.change * 100),
    })),
    ...(view.addedServices.length ? { newServices: view.addedServices.slice(0, MAX_KNOWN) } : {}),
  };
}
