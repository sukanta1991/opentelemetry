// SPDX-License-Identifier: Apache-2.0
// Background cardinality evaluation for tree badges, the view badge and the status bar. Runs only after data
// or settings changed, at most once per interval, and never while the analyzer is off. No vscode import.

import { byCodeUnit } from '../compare';
import { LIVE_REALM, Instance } from '../store/store';
import { escapeCell } from './baselineReport';
import { findingsFor } from './cardinalityModel';
import { CardinalitySettings, Finding, Severity, compareFindings } from './cardinalityRules';
import { RULE_LABEL, SEVERITY_GLYPH, findingSubject } from './webview/cardinalityView';

export const EVALUATE_INTERVAL_MS = 2000;
/** Findings listed per tree tooltip. */
export const TOOLTIP_FINDINGS = 5;
/** Noisy live services named in the status bar tooltip. */
export const STATUS_SERVICES = 5;

export interface NodeFindings {
  critical: number;
  warning: number;
  info: number;
  /** Most severe findings first, as one line each (plain text, not escaped). */
  top: string[];
}

export interface LiveStatus {
  /** Live services with a warning or critical finding. */
  noisyServices: number;
  findings: Record<Severity, number>;
  /** The noisiest of them, most critical findings first. */
  services: string[];
}

export interface CardinalityOverview {
  /** Services, live and loaded, with a warning or critical finding. */
  noisyServices: number;
  live: LiveStatus;
  /** Keyed by serviceKey / instanceKey. */
  nodes: ReadonlyMap<string, NodeFindings>;
}

export function emptyOverview(): CardinalityOverview {
  return { noisyServices: 0, live: { noisyServices: 0, findings: { critical: 0, warning: 0, info: 0 }, services: [] }, nodes: new Map() };
}

export const serviceKey = (realm: string, service: string) => JSON.stringify(['svc', realm, service]);
export const instanceKey = (id: string) => JSON.stringify(['inst', id]);

const isNoisy = (n: NodeFindings) => n.critical + n.warning > 0;

function summarise(findings: Finding[]): NodeFindings {
  const out: NodeFindings = { critical: 0, warning: 0, info: 0, top: [] };
  for (const f of findings) out[f.severity]++;
  out.top = [...findings]
    .sort(compareFindings)
    .slice(0, TOOLTIP_FINDINGS)
    .map((f) => `${SEVERITY_GLYPH[f.severity]} ${findingSubject(f)}: ${RULE_LABEL[f.rule]}`);
  return out;
}

function byKey<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/** Findings per service (within its realm) and per instance. */
export function evaluateOverview(instances: readonly Instance[], settings: CardinalitySettings): CardinalityOverview {
  const nodes = new Map<string, NodeFindings>();
  const live: LiveStatus = { noisyServices: 0, findings: { critical: 0, warning: 0, info: 0 }, services: [] };
  const liveNoisy: [string, NodeFindings][] = [];
  let noisyServices = 0;
  const counted = instances.filter((i) => i.usage);
  for (const [realm, list] of byKey(counted, (i) => i.realm)) {
    const services = byKey(list, (i) => i.serviceName);
    for (const [service, findings] of byKey(findingsFor(list, settings), (f) => f.service)) {
      const node = summarise(findings);
      nodes.set(serviceKey(realm, service), node);
      if (isNoisy(node)) noisyServices++;
      if (realm !== LIVE_REALM) continue;
      for (const f of findings) live.findings[f.severity]++;
      if (isNoisy(node)) liveNoisy.push([service, node]);
    }
    for (const [service, own] of services) {
      // A lone instance has its service's findings.
      if (own.length === 1) {
        const node = nodes.get(serviceKey(realm, service));
        if (node) nodes.set(instanceKey(own[0].id), node);
        continue;
      }
      for (const inst of own) {
        const findings = findingsFor([inst], settings);
        if (findings.length) nodes.set(instanceKey(inst.id), summarise(findings));
      }
    }
  }
  liveNoisy.sort(([a, x], [b, y]) => y.critical - x.critical || y.warning - x.warning || byCodeUnit(a, b));
  live.noisyServices = liveNoisy.length;
  live.services = liveNoisy.slice(0, STATUS_SERVICES).map(([s]) => s);
  return { noisyServices, live, nodes };
}

/** Tree item tooltip section: untrusted names escaped, no links. */
export function tooltipMarkdown(n: NodeFindings): string {
  const counts = [`${n.critical} critical`, `${n.warning} warning`, `${n.info} info`].join(', ');
  return [`**Cardinality:** ${counts}`, '', ...n.top.map((line) => `- ${escapeCell(line)}`)].join('\n');
}

/** Two characters at most, as file decorations require; nothing for info-only nodes. */
export function decorationBadge(n: NodeFindings): string | undefined {
  const count = n.critical + n.warning;
  if (!count) return undefined;
  return count > 9 ? '9+' : String(count);
}

export function decorationTooltip(n: NodeFindings): string {
  const parts: string[] = [];
  if (n.critical) parts.push(`${n.critical} critical`);
  if (n.warning) parts.push(`${n.warning} warning`);
  return `Cardinality: ${parts.join(', ')} finding${n.critical + n.warning === 1 ? '' : 's'}`;
}

export interface EvaluatorSource {
  onDidChange(listener: () => void): { dispose(): void };
  getAllInstances(): Instance[];
  isCardinalityEnabled(): boolean;
}

export interface EvaluatorOptions {
  intervalMs?: number;
  evaluate?: typeof evaluateOverview;
}

type OverviewListener = (overview: CardinalityOverview, changedKeys: string[]) => void;

/** One shared evaluation for every always-visible surface. */
export class CardinalityEvaluator {
  private overview = emptyOverview();
  private readonly listeners = new Set<OverviewListener>();
  private readonly sub: { dispose(): void };
  private readonly intervalMs: number;
  private readonly evaluate: typeof evaluateOverview;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRun = -Infinity;
  private disposed = false;

  constructor(
    private readonly source: EvaluatorSource,
    private readonly settings: () => CardinalitySettings,
    opts: EvaluatorOptions = {}
  ) {
    this.intervalMs = opts.intervalMs ?? EVALUATE_INTERVAL_MS;
    this.evaluate = opts.evaluate ?? evaluateOverview;
    this.sub = source.onDidChange(() => this.schedule());
  }

  get current(): CardinalityOverview {
    return this.overview;
  }

  onDidChange(listener: OverviewListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Settings changed: evaluate again on the usual schedule. */
  invalidate(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    const wait = Math.max(0, this.lastRun + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, wait);
  }

  private run(): void {
    this.lastRun = Date.now();
    const next = this.source.isCardinalityEnabled() ? this.evaluate(this.source.getAllInstances(), this.settings()) : emptyOverview();
    const changed = changedKeys(this.overview.nodes, next.nodes);
    const summaryChanged = JSON.stringify([this.overview.noisyServices, this.overview.live]) !== JSON.stringify([next.noisyServices, next.live]);
    this.overview = next;
    if (!changed.length && !summaryChanged) return;
    for (const l of [...this.listeners]) {
      try {
        l(next, changed);
      } catch {
        // One failing surface must not stop the others.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sub.dispose();
    this.listeners.clear();
  }
}

function changedKeys(prev: ReadonlyMap<string, NodeFindings>, next: ReadonlyMap<string, NodeFindings>): string[] {
  const out: string[] = [];
  const same = (a: NodeFindings | undefined, b: NodeFindings | undefined) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of next) if (!same(prev.get(k), v)) out.push(k);
  for (const k of prev.keys()) if (!next.has(k)) out.push(k);
  return out;
}
