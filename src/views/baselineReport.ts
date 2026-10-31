// SPDX-License-Identifier: Apache-2.0
// Markdown summary of a baseline comparison, for PR descriptions and chat. No vscode import.

import { ComparisonResult, KeyComparison, MetricDelta, Verdict } from './baselineCompare';
import { BaselineLabel } from './baselineMap';
import { CardinalityChange, CardinalityComparison, ChangeVerdict } from './cardinalitySummary';

export const REPORT_MAX_ROWS = 50;
const MAX_CELL = 120;

const GLYPH: Record<Verdict, string> = {
  regressed: '⬆',
  improved: '⬇',
  new: '✚',
  removed: '⊖',
  untracked: '◌',
  insufficient: '?',
  unchanged: '●',
};
const SHOWN: readonly Verdict[] = ['regressed', 'improved', 'new', 'removed'];
const ORDER: Record<Verdict, number> = { regressed: 0, improved: 1, new: 2, removed: 3, untracked: 4, insufficient: 5, unchanged: 6 };

export interface ReportMeta {
  baseline: BaselineLabel;
  // What the baseline was compared with, e.g. "live calls" or another baseline's name.
  against: string;
  cutoffMs?: number;
  time: (ms: number) => string;
  // Present when both sides have usage counters.
  cardinality?: CardinalityComparison;
}

// Names come from telemetry: flatten to one line, escape Markdown, and bound the length.
export function escapeCell(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const cut = flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
  return cut.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, (c) => `\\${c}`);
}

const ms = (v: number | null) => (v === null ? '–' : v < 10 ? `${Math.round(v * 10) / 10} ms` : `${Math.round(v)} ms`);
const pctOf = (v: number | null) => (v === null ? '–' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v === null ? '–' : `${Math.round(v * 10) / 10}`);

function change(m: MetricDelta | undefined, fmt: (v: number | null) => string): string {
  if (!m || (m.base === null && m.current === null)) return '';
  let text = `${fmt(m.base)} → ${fmt(m.current)}`;
  if (m.base !== null && m.current !== null && m.base > 0 && fmt !== pctOf) {
    const p = Math.round(((m.current - m.base) / m.base) * 100);
    text += ` (${p >= 0 ? '+' : '−'}${Math.abs(p)}%)`;
  }
  return m.change === 'regressed' ? `**${text}**` : text;
}

function where(k: KeyComparison, labels: Map<string, string>): string {
  const name = (id: string) => labels.get(id) ?? id;
  const scope = k.source === undefined ? name(k.target) : `${name(k.source)} → ${name(k.target)}`;
  return escapeCell(scope);
}

function table(keys: KeyComparison[], labels: Map<string, string>, withOp: boolean): string[] {
  const head = withOp ? ['', 'Where', 'Operation', 'Calls', 'p50', 'p95', 'Errors'] : ['', 'Where', 'Calls', 'p50', 'p95', 'Errors', 'Calls/request'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const k of keys) {
    const cells = [
      GLYPH[k.verdict],
      where(k, labels),
      ...(withOp ? [escapeCell(k.op ?? '')] : []),
      `${k.base?.count ?? 0} → ${k.current?.count ?? 0}`,
      change(k.p50, ms),
      change(k.p95, ms),
      change(k.errorRate, pctOf),
      ...(withOp ? [] : [change(k.fanout, num)]),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

const byImportance = (a: KeyComparison, b: KeyComparison) =>
  ORDER[a.verdict] - ORDER[b.verdict] || (b.current?.count ?? b.base?.count ?? 0) - (a.current?.count ?? a.base?.count ?? 0);

const CARD_GLYPH: Record<ChangeVerdict, string> = { new: '✚', grown: '⬆', resolved: '✔' };
const uniques = (v: number | undefined) => (v === undefined ? '–' : `${Math.round(v)}`);
const rate = (v: number) => (v >= 10 ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`);

function bytes(v: number): string {
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.round((v / 1024) * 10) / 10} KB`;
  return `${Math.round((v / 1024 / 1024) * 10) / 10} MB`;
}

function cardinalityName(c: CardinalityChange): string {
  if (c.kind === 'metric') return `${escapeCell(c.key)} (metric${c.driver !== undefined ? `, by ${escapeCell(c.driver)}` : ''})`;
  return `${escapeCell(c.key)} (${c.scope === 'span.event' ? 'span event' : c.scope})`;
}

function cardinalitySection(c: CardinalityComparison, maxRows: number): string[] {
  const out = [
    '',
    '### Cardinality',
    '',
    `**${CARD_GLYPH.new} ${c.summary.new} new · ${CARD_GLYPH.grown} ${c.summary.grown} grown · ${CARD_GLYPH.resolved} ${c.summary.resolved} resolved** ` +
      'high-cardinality attributes and metrics',
  ];
  if (c.changes.length) {
    out.push('', '| | Service | Attribute or metric | Unique values |', '|---|---|---|---|');
    for (const x of c.changes.slice(0, maxRows)) {
      out.push(`| ${CARD_GLYPH[x.verdict]} | ${escapeCell(x.service)} | ${cardinalityName(x)} | ${uniques(x.base)} → ${uniques(x.current)} |`);
    }
    if (c.changes.length > maxRows) out.push('', `…and ${c.changes.length - maxRows} more.`);
  }
  if (c.volume.length) {
    out.push('', '| Service | Signal | Records per minute | Bytes per minute |', '|---|---|---|---|');
    for (const v of c.volume.slice(0, maxRows)) {
      const p = Number.isFinite(v.change) ? ` (${v.change >= 0 ? '+' : '−'}${Math.abs(Math.round(v.change * 100))}%)` : ' (new)';
      out.push(`| ${escapeCell(v.service)} | ${v.signal} | ${rate(v.base)} → ${rate(v.current)}${p} | ${bytes(v.baseBytes)} → ${bytes(v.currentBytes)} |`);
    }
    if (c.volume.length > maxRows) out.push('', `…and ${c.volume.length - maxRows} more.`);
  }
  if (c.addedServices.length) out.push('', `New services: ${c.addedServices.slice(0, maxRows).map(escapeCell).join(', ')}.`);
  if (c.missingServices.length) out.push('', `Services not seen: ${c.missingServices.slice(0, maxRows).map(escapeCell).join(', ')}.`);
  out.push('', '_Unique values count each side up to its capture time, not only the compared window. Rates cover the last 15 minutes._');
  return out;
}

export function buildBaselineReport(result: ComparisonResult, meta: ReportMeta, maxRows = REPORT_MAX_ROWS): string {
  const labels = new Map(result.nodes.map((n) => [n.id, n.label]));
  const scopes = result.keys.filter((k) => k.op === undefined);
  const ops = result.keys.filter((k) => k.op !== undefined);
  const count = (v: Verdict) => scopes.filter((k) => k.verdict === v).length;
  const b = meta.baseline;
  const out = [
    `## Service map vs baseline “${escapeCell(b.name)}”`,
    '',
    `Baseline: ${b.sourceKind}${b.sourceLabel ? ` (${escapeCell(b.sourceLabel)})` : ''}, captured ${meta.time(b.createdMs)}. ` +
      `Compared with: ${escapeCell(meta.against)}${meta.cutoffMs !== undefined ? ` after ${meta.time(meta.cutoffMs)}` : ''}.`,
    '',
    `**${GLYPH.regressed} ${count('regressed')} regressed · ${GLYPH.improved} ${count('improved')} improved · ` +
      `${GLYPH.new} ${count('new')} new · ${GLYPH.removed} ${count('removed')} not seen** ` +
      `(services and calls; ${count('unchanged')} unchanged, ${count('insufficient')} with too few calls)`,
  ];
  if (result.coverage.warn) {
    out.push(
      '',
      `> ⚠ ${Math.round(result.coverage.ratio * 100)}% of the services and dependencies with calls now are not in the baseline; it may come from a different setup.`
    );
  }
  for (const [title, keys, withOp] of [
    ['Services and calls', scopes, false],
    ['Operations', ops, true],
  ] as const) {
    const changed = keys.filter((k) => SHOWN.includes(k.verdict)).sort(byImportance);
    if (!changed.length) continue;
    out.push('', `### ${title}`, '', ...table(changed.slice(0, maxRows), labels, withOp));
    if (changed.length > maxRows) out.push('', `…and ${changed.length - maxRows} more.`);
  }
  if (!scopes.some((k) => SHOWN.includes(k.verdict)) && !ops.some((k) => SHOWN.includes(k.verdict))) {
    out.push('', 'No significant changes.');
  }
  if (meta.cardinality) out.push(...cardinalitySection(meta.cardinality, maxRows));
  out.push(
    '',
    '_Only statistically significant changes that also pass the minimum-change thresholds are listed ' +
      '(p50: Mann-Whitney; p95: quantile test; errors: proportion test; Benjamini-Hochberg q < 0.05). ' +
      'Generated by OpenTelemetry for VS Code._'
  );
  return out.join('\n');
}
