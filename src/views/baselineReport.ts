// SPDX-License-Identifier: Apache-2.0
// Markdown summary of a baseline comparison, for PR descriptions and chat. No vscode import.

import { ComparisonResult, KeyComparison, MetricDelta, Verdict } from './baselineCompare';
import { BaselineLabel } from './baselineMap';

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
  out.push(
    '',
    '_Only statistically significant changes that also pass the minimum-change thresholds are listed ' +
      '(p50: Mann-Whitney; p95: quantile test; errors: proportion test; Benjamini-Hochberg q < 0.05). ' +
      'Generated by OpenTelemetry for VS Code._'
  );
  return out.join('\n');
}
