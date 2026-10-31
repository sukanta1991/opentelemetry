// SPDX-License-Identifier: Apache-2.0
// Cardinality and cost panel webview. Telemetry strings reach the DOM only through textContent/attributes.

import type { Pricing, PriceKey, SizeModel } from '../cardinalityCost';
import { estimateCost } from '../cardinalityCost';
import type { CardinalityChange } from '../cardinalitySummary';
import type { Severity } from '../cardinalityRules';
import type { Signal } from '../../store/cardinality/sizes';
import { formatTimestamp } from '../format';
import {
  CLASS_LABEL,
  COST_ITEM_LABEL,
  DetailTable,
  Details,
  FindingView,
  GROWTH_LABEL,
  HostMessage,
  KeyView,
  MetricView,
  OperationView,
  PanelScope,
  PricingView,
  RULE_LABEL,
  SCOPE_LABEL,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  SIGNAL_LABEL,
  ServiceView,
  SpanNameView,
  TABS,
  TAB_LABEL,
  Tab,
  TemplateView,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  ViewMessage,
  findingSubject,
  formatBytes,
  formatCompact,
  formatCount,
  formatMinutes,
  formatMoney,
  formatPercent,
  formatSignedPercent,
  loadViewState,
  overridesFrom,
  parseNumberInput,
  projections,
  sparklinePath,
} from './cardinalityView';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type Update = Extract<HostMessage, { type: 'update' }>;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARK_WIDTH = 160;
const SPARK_HEIGHT = 24;
const DETAIL_SPARK_WIDTH = 280;
const DETAIL_SPARK_HEIGHT = 40;
const SIGNALS: readonly Signal[] = ['traces', 'logs', 'metrics'];
const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];
const PRICE_FIELDS: readonly [PriceKey, string, string][] = [
  ['perGbIngested', 'Per GB ingested', 'Price per GB of telemetry ingested'],
  ['perMillionSpans', 'Per million spans', 'Price per million spans'],
  ['perMillionLogs', 'Per million log records', 'Price per million log records'],
  ['perSeriesMonth', 'Per active series per month', 'Price per active metric series per month'],
  ['perGbMonthRetained', 'Per GB-month retained', 'Storage price per GB per month'],
];

const vscode = acquireVsCodeApi();
const state = loadViewState(vscode.getState());

let update: Update | null = null;
let details: { table: DetailTable; index: number; data: Details } | null = null;
// Identity of the selected row, so the selection survives refreshes that reorder rows.
let selected: { table: DetailTable; id: string } | null = null;
let banner: { kind: 'disabled' | 'error'; text: string } | null = null;
let localTime = document.body.dataset.useLocalTime !== 'false';
let frame = 0;
// While the user edits the pricing form, refreshes leave its inputs alone.
let formDirty = false;
let detailsDirty = false;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const realmSel = byId<HTMLSelectElement>('realm');
const serviceSel = byId<HTMLSelectElement>('service');
const instanceSel = byId<HTMLSelectElement>('instance');
const asOfEl = byId<HTMLSpanElement>('asOf');
const truncatedEl = byId<HTMLSpanElement>('truncated');
const tabsEl = byId<HTMLDivElement>('tabs');
const contentEl = byId<HTMLDivElement>('content');
const detailsEl = byId<HTMLElement>('details');
const bannerEl = byId<HTMLDivElement>('banner');

function post(msg: ViewMessage): void {
  vscode.postMessage(msg);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function sparkline(values: readonly (number | null)[], width: number, height: number, label: string): SVGSVGElement {
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'spark', role: 'img', 'aria-label': label });
  svg.append(svgEl('path', { d: sparklinePath(values, width, height - 2) || `M0,${height - 2}L${width},${height - 2}`, transform: 'translate(0,1)' }));
  return svg;
}

function time(ms: number | null): string {
  if (ms === null) return '–';
  const t = formatTimestamp(ms, localTime);
  return `${t.slice(0, 10)} ${t.slice(11, 19)}${localTime ? '' : ' UTC'}`;
}

function severityCell(s: Severity | undefined): HTMLElement {
  if (!s) return el('span', 'muted', '–');
  const span = el('span', `sev sev-${s}`);
  span.append(el('span', 'glyph', SEVERITY_GLYPH[s]), document.createTextNode(` ${SEVERITY_LABEL[s]}`));
  return span;
}

function persist(): void {
  vscode.setState({ tab: state.tab });
}

// --- Toolbar and tabs -----------------------------------------------------------------------

function fillSelect(sel: HTMLSelectElement, items: { value: string; label: string }[], value: string): void {
  sel.replaceChildren(
    ...items.map((i) => {
      const o = el('option', undefined, i.label);
      o.value = i.value;
      return o;
    })
  );
  sel.value = value;
}

const ALL = '';
let toolbarSig = '';

function renderToolbar(): void {
  const u = update;
  realmSel.disabled = serviceSel.disabled = instanceSel.disabled = !u;
  if (!u) {
    toolbarSig = '';
    return;
  }
  // Refilling a select closes it if open, so only refill when the choices change.
  const sig = JSON.stringify([u.options, u.scope]);
  if (sig !== toolbarSig) {
    toolbarSig = sig;
    fillSelect(realmSel, u.options.realms.map((r) => ({ value: r.id, label: r.label })), u.scope.realm);
    fillSelect(serviceSel, [{ value: ALL, label: 'All services' }, ...u.options.services.map((s) => ({ value: s, label: s }))], u.scope.service ?? ALL);
    fillSelect(
      instanceSel,
      [{ value: ALL, label: 'All instances' }, ...u.options.instances.map((i) => ({ value: i.id, label: i.label }))],
      u.scope.instanceId ?? ALL
    );
  }
  instanceSel.disabled = u.scope.service === undefined;
  asOfEl.textContent = u.summary.lastMs === null ? '' : `as of ${time(u.summary.lastMs)}`;
  truncatedEl.hidden = !u.summary.rowsTruncated && !u.summary.droppedKeyOccurrences;
}

function setScope(scope: PanelScope): void {
  closeDetails();
  post({ type: 'setScope', scope });
}

realmSel.addEventListener('change', () => setScope({ realm: realmSel.value }));
serviceSel.addEventListener('change', () => {
  if (!update) return;
  setScope(serviceSel.value === ALL ? { realm: update.scope.realm } : { realm: update.scope.realm, service: serviceSel.value });
});
instanceSel.addEventListener('change', () => {
  if (!update || update.scope.service === undefined) return;
  const base = { realm: update.scope.realm, service: update.scope.service };
  setScope(instanceSel.value === ALL ? base : { ...base, instanceId: instanceSel.value });
});

const tabButtons = new Map<Tab, HTMLButtonElement>();
for (const t of TABS) {
  const b = el('button', 'tab', TAB_LABEL[t]);
  b.id = `tab-${t}`;
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-controls', 'content');
  b.addEventListener('click', () => selectTab(t));
  b.addEventListener('keydown', (e) => {
    let step = 0;
    if (e.key === 'ArrowRight') step = 1;
    else if (e.key === 'ArrowLeft') step = -1;
    if (!step) return;
    const next = TABS[(TABS.indexOf(t) + step + TABS.length) % TABS.length];
    e.preventDefault();
    selectTab(next);
    tabButtons.get(next)!.focus();
  });
  tabButtons.set(t, b);
  tabsEl.append(b);
}

function selectTab(t: Tab): void {
  if (t === state.tab) return;
  state.tab = t;
  formDirty = false;
  closeDetails();
  persist();
  renderTabs();
  post({ type: 'setTab', tab: t });
}

function renderTabs(): void {
  for (const [t, b] of tabButtons) {
    const on = t === state.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  contentEl.setAttribute('aria-labelledby', `tab-${state.tab}`);
}

// --- Tables ---------------------------------------------------------------------------------

interface Col<T> {
  head: string;
  cell: (row: T) => string | Node;
  num?: boolean;
  title?: string;
}

interface TableOpts<T> {
  label: string;
  detail?: { table: DetailTable; id: (row: T) => string };
  empty?: string;
}

function table<T>(rows: readonly T[], cols: Col<T>[], opts: TableOpts<T>): HTMLElement {
  if (!rows.length) return el('p', 'muted', opts.empty ?? 'Nothing to show.');
  const t = el('table');
  t.setAttribute('aria-label', opts.label);
  const head = el('tr');
  for (const c of cols) {
    const th = el('th', c.num ? 'num' : undefined, c.head);
    th.scope = 'col';
    if (c.title) th.title = c.title;
    head.append(th);
  }
  t.append(el('thead'), el('tbody'));
  t.tHead!.append(head);
  rows.forEach((row, index) => {
    const tr = el('tr');
    for (const c of cols) {
      const v = c.cell(row);
      const td = el('td', c.num ? 'num' : undefined);
      if (typeof v === 'string') td.textContent = v;
      else td.append(v);
      tr.append(td);
    }
    const d = opts.detail;
    if (d) {
      const id = d.id(row);
      tr.className = 'selectable';
      tr.tabIndex = 0;
      tr.dataset.rowId = `${d.table}\u0000${id}`;
      const on = selected?.table === d.table && selected.id === id;
      tr.setAttribute('aria-selected', String(on));
      const open = () => {
        selected = { table: d.table, id };
        requestDetails(d.table, index);
        for (const r of t.querySelectorAll('tr[aria-selected="true"]')) r.setAttribute('aria-selected', 'false');
        tr.setAttribute('aria-selected', 'true');
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    t.tBodies[0].append(tr);
  });
  return t;
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  const s = el('section');
  s.append(el('h2', undefined, title), ...children);
  return s;
}

const note = (text: string) => el('p', 'note', text);
const count = (n: number, approx = false) => formatCount(n, approx);
const bytesCell = (b: number) => formatBytes(b);

const findingId = (f: FindingView) => [f.service, f.rule, f.scope ?? '', f.metric ?? '', f.key].join('\u0000');
const keyId = (k: KeyView) => [k.service, k.scope, k.key].join('\u0000');
const metricId = (m: MetricView) => [m.service, m.name].join('\u0000');
const templateId = (t: TemplateView) => [t.service, t.text].join('\u0000');
const spanNamesId = (s: SpanNameView) => s.service;

function findingsTable(findings: FindingView[]): HTMLElement {
  return table(
    findings,
    [
      { head: 'Severity', cell: (f) => severityCell(f.severity) },
      { head: 'Service', cell: (f) => f.service },
      { head: 'What', cell: (f) => findingSubject(f) },
      { head: 'Why', cell: (f) => RULE_LABEL[f.rule] },
      { head: 'Unique', cell: (f) => count(f.distinct, f.approx), num: true, title: 'Unique values (series for metrics, names for span names)' },
      { head: 'Bytes share', cell: (f) => formatPercent(f.bytesShare), num: true, title: "Share of the service's bytes for this signal" },
      { head: 'Growth', cell: (f) => GROWTH_LABEL[f.growth] },
    ],
    { label: 'Findings', detail: { table: 'findings', id: findingId }, empty: 'No findings: nothing looks likely to drive up cost.' }
  );
}

function servicesTable(services: ServiceView[]): HTMLElement {
  const findings = (s: ServiceView) => {
    const span = el('span');
    for (const sev of SEVERITIES) {
      if (!s.findings[sev]) continue;
      const part = el('span', `sev sev-${sev}`, `${SEVERITY_GLYPH[sev]} ${s.findings[sev]} `);
      part.title = `${s.findings[sev]} ${SEVERITY_LABEL[sev].toLowerCase()}`;
      span.append(part);
    }
    if (!span.childNodes.length) span.textContent = '–';
    return span;
  };
  const bytesPerMin = (s: ServiceView) => s.perMinute.traces.proto + s.perMinute.logs.proto + s.perMinute.metrics.proto;
  return table(
    services,
    [
      { head: 'Service', cell: (s) => s.service },
      { head: 'Instances', cell: (s) => count(s.instances), num: true },
      { head: 'Spans/min', cell: (s) => formatCompact(s.perMinute.traces.count), num: true },
      { head: 'Logs/min', cell: (s) => formatCompact(s.perMinute.logs.count), num: true },
      { head: 'Points/min', cell: (s) => formatCompact(s.perMinute.metrics.count), num: true },
      { head: 'Bytes/min', cell: (s) => bytesCell(bytesPerMin(s)), num: true, title: 'OTLP protobuf, uncompressed' },
      { head: 'Total bytes', cell: (s) => bytesCell(s.totals.traces.proto + s.totals.logs.proto + s.totals.metrics.proto), num: true },
      { head: 'Findings', cell: findings },
    ],
    { label: 'Noisiest services' }
  );
}

function operationsTable(ops: OperationView[], label: string): HTMLElement {
  return table(
    ops,
    [
      { head: 'Service', cell: (o) => o.service },
      { head: 'Operation', cell: (o) => (o.other ? el('span', 'muted', '(other operations)') : o.name) },
      { head: 'Spans', cell: (o) => count(o.count), num: true },
      { head: 'Errors', cell: (o) => count(o.errors), num: true },
      { head: 'Bytes', cell: (o) => bytesCell(o.proto), num: true },
    ],
    { label }
  );
}

// --- Tabs -----------------------------------------------------------------------------------

function card(label: string, value: string, sub?: string): HTMLElement {
  const c = el('div', 'card');
  c.append(el('div', 'card-label', label), el('div', 'card-value', value));
  if (sub) c.append(el('div', 'card-sub', sub));
  return c;
}

function renderOverview(u: Update, data: Extract<Update['data'], { tab: 'overview' }>): Node[] {
  const s = u.summary;
  const cards = el('div', 'cards');
  for (const sig of SIGNALS) {
    const per = s.perMinute[sig];
    const p = projections(per.count);
    const c = card(`${SIGNAL_LABEL[sig]} / min`, formatCompact(per.count), `${formatCompact(p.day)}/day · ${formatCompact(p.month)}/month`);
    c.append(sparkline(s.activity[sig], SPARK_WIDTH, SPARK_HEIGHT, `${SIGNAL_LABEL[sig]} per bucket`));
    cards.append(c);
  }
  const bytesMin = s.perMinute.traces.proto + s.perMinute.logs.proto + s.perMinute.metrics.proto;
  const jsonMin = s.perMinute.traces.json + s.perMinute.logs.json + s.perMinute.metrics.json;
  cards.append(
    card('Bytes / min', formatBytes(bytesMin), `JSON ${formatBytes(jsonMin)} · ${formatBytes(projections(bytesMin).month)}/month`),
    card('Active series', formatCompact(s.activeSeries), 'unique metric series since counting started'),
    card(
      'Findings',
      SEVERITIES.map((sev) => `${SEVERITY_GLYPH[sev]} ${s.findings[sev]}`).join('  '),
      SEVERITIES.map((sev) => `${s.findings[sev]} ${SEVERITY_LABEL[sev].toLowerCase()}`).join(', ')
    ),
    s.cost ? card('Estimated cost', `${formatMoney(s.cost.monthlyTotal, s.cost.currency)}/month`, 'from your pricing; see Pricing') : card('Estimated cost', '–', 'set prices in the Pricing tab')
  );
  const out: Node[] = [cards];
  out.push(
    note(
      `Counts cover everything received since counting started${s.firstMs !== null ? ` (${time(s.firstMs)})` : ''}; ` +
        `rates use the last ${formatMinutes(s.windowMinutes)}. Sizes are uncompressed OTLP estimates.`
    )
  );
  const shown = data.findings.length;
  out.push(
    section(
      `Findings${s.findingsTotal > shown ? ` (first ${shown} of ${s.findingsTotal})` : ''}`,
      findingsTable(data.findings)
    ),
    section('Noisiest services', servicesTable(data.services)),
    section('Noisiest operations', operationsTable(data.operations, 'Noisiest operations'))
  );
  return out;
}

function renderAttributes(keys: KeyView[]): Node[] {
  return [
    section(
      'Attributes',
      note('Span, span event and log attributes by bytes. Select a row for example values, the value mix and how unique values grew.'),
      table(
        keys,
        [
          { head: 'Severity', cell: (k) => severityCell(k.severity) },
          { head: 'Service', cell: (k) => k.service },
          { head: 'Where', cell: (k) => SCOPE_LABEL[k.scope] },
          { head: 'Key', cell: (k) => k.key },
          { head: 'Unique', cell: (k) => count(k.distinct, k.approx), num: true },
          { head: 'Unique/uses', cell: (k) => formatPercent(k.ratio), num: true, title: 'Unique values divided by occurrences' },
          { head: 'Values look like', cell: (k) => (k.valueClass ? CLASS_LABEL[k.valueClass] : 'mixed') },
          { head: 'Growth', cell: (k) => GROWTH_LABEL[k.growth] },
          { head: 'Bytes', cell: (k) => bytesCell(k.proto), num: true },
          { head: 'Bytes share', cell: (k) => formatPercent(k.bytesShare), num: true },
        ],
        { label: 'Attributes', detail: { table: 'keys', id: keyId }, empty: 'No attributes counted yet.' }
      )
    ),
  ];
}

function renderMetrics(metrics: MetricView[]): Node[] {
  return [
    section(
      'Metrics',
      note('Series = unique label sets per metric. The driving label is the one with the most unique values.'),
      table(
        metrics,
        [
          { head: 'Severity', cell: (m) => severityCell(m.severity) },
          { head: 'Service', cell: (m) => m.service },
          { head: 'Metric', cell: (m) => m.name },
          { head: 'Type', cell: (m) => m.type },
          { head: 'Series', cell: (m) => count(m.series, m.approx), num: true },
          { head: 'Driving label', cell: (m) => (m.driver ? `${m.driver.key} (${count(m.driver.distinct, m.driver.approx)})` : '–') },
          { head: 'Points', cell: (m) => count(m.points), num: true },
          { head: 'Bytes', cell: (m) => bytesCell(m.proto), num: true },
          { head: 'Growth', cell: (m) => GROWTH_LABEL[m.growth] },
        ],
        { label: 'Metrics', detail: { table: 'metrics', id: metricId }, empty: 'No metrics counted yet.' }
      )
    ),
  ];
}

function renderLogs(templates: TemplateView[]): Node[] {
  return [
    section(
      'Log patterns',
      note('Log bodies grouped into patterns; variable parts show as <*> or a type such as <NUM>.'),
      table(
        templates,
        [
          { head: 'Severity', cell: (t) => severityCell(t.severity) },
          { head: 'Service', cell: (t) => t.service },
          { head: 'Pattern', cell: (t) => (t.other ? el('span', 'muted', '(other patterns)') : el('code', 'pattern', t.text)) },
          { head: 'Logs', cell: (t) => count(t.count), num: true },
          { head: 'Share', cell: (t) => formatPercent(t.share), num: true, title: "Share of the service's logs" },
          { head: 'Bytes', cell: (t) => bytesCell(t.proto), num: true },
        ],
        { label: 'Log patterns', detail: { table: 'templates', id: templateId }, empty: 'No logs counted yet.' }
      )
    ),
  ];
}

function renderSpanNames(data: Extract<Update['data'], { tab: 'spanNames' }>): Node[] {
  return [
    section(
      'Span names',
      note('Span names should be low-cardinality templates such as "GET /users/{id}"; names with IDs in them create a new operation per value.'),
      table(
        data.spanNames,
        [
          { head: 'Severity', cell: (s) => severityCell(s.severity) },
          { head: 'Service', cell: (s) => s.service },
          { head: 'Unique names', cell: (s) => count(s.distinct, s.approx), num: true },
          { head: 'With IDs', cell: (s) => (s.classified ? `${s.withIds} of ${s.classified} checked` : '–'), num: true },
        ],
        { label: 'Span names', detail: { table: 'spanNames', id: spanNamesId }, empty: 'No spans counted yet.' }
      )
    ),
    section('Operations', operationsTable(data.operations, 'Operations')),
  ];
}

function changeSubject(c: CardinalityChange): string {
  if (c.kind === 'metric') return `${c.key} (metric${c.driver !== undefined ? `, by ${c.driver}` : ''})`;
  return `${c.key} (${SCOPE_LABEL[c.scope ?? 'span']})`;
}

function renderBaseline(b: Extract<Update['data'], { tab: 'baseline' }>['baseline']): Node[] {
  const msg: Partial<Record<typeof b.state, string>> = {
    none: 'No baseline is active. Capture or switch to one from the Service Map’s Baseline menu, then compare cardinality here.',
    loading: 'Loading the active baseline…',
    unreadable: 'The active baseline could not be read.',
    noSummary: 'The active baseline has no cardinality summary (it was captured with an older version or with the analyzer off). Capture a new baseline.',
    noData: 'Nothing has been counted in this scope yet.',
  };
  if (b.state !== 'ready') {
    const head = b.state === 'none' ? [] : [el('p', undefined, `Baseline “${b.name}”.`)];
    return [section('Baseline', ...head, el('p', 'muted', msg[b.state] ?? ''))];
  }
  const out: Node[] = [];
  const summary = el('p', 'summary');
  for (const v of ['new', 'grown', 'resolved'] as const) {
    const part = el('span', `verdict verdict-${v}`, `${VERDICT_GLYPH[v]} ${b.summary[v]} ${VERDICT_LABEL[v].toLowerCase()}`);
    summary.append(part, document.createTextNode('  '));
  }
  out.push(
    section(
      `Compared with baseline “${b.name}”`,
      note(`Baseline captured ${time(b.createdMs)}, counting ${time(b.fromMs)} – ${time(b.toMs)}. Unique values count each side since counting started, not only a window.`),
      summary,
      table(
        b.changes,
        [
          { head: 'Change', cell: (c) => el('span', `verdict verdict-${c.verdict}`, `${VERDICT_GLYPH[c.verdict]} ${VERDICT_LABEL[c.verdict]}`) },
          { head: 'Service', cell: (c) => c.service },
          { head: 'Attribute or metric', cell: changeSubject },
          { head: 'Before', cell: (c) => (c.base === undefined ? '–' : count(c.base)), num: true },
          { head: 'Now', cell: (c) => (c.current === undefined ? '–' : count(c.current)), num: true },
        ],
        { label: 'Cardinality changes', empty: 'No high-cardinality attributes or metrics appeared, grew or went away.' }
      )
    )
  );
  if (b.changesTotal > b.changes.length) out.push(note(`…and ${b.changesTotal - b.changes.length} more.`));
  out.push(
    section(
      'Volume changes',
      table(
        b.volume,
        [
          { head: 'Service', cell: (v) => v.service },
          { head: 'Signal', cell: (v) => SIGNAL_LABEL[v.signal] },
          { head: 'Per minute', cell: (v) => `${formatCompact(v.base)} → ${formatCompact(v.current)}`, num: true },
          { head: 'Change', cell: (v) => formatSignedPercent(v.change), num: true },
          { head: 'Bytes per minute', cell: (v) => `${formatBytes(v.baseBytes)} → ${formatBytes(v.currentBytes)}`, num: true },
        ],
        { label: 'Volume changes', empty: 'No service changed its per-minute volume by 25% or more.' }
      )
    )
  );
  if (b.addedServices.length) out.push(note(`New services: ${b.addedServices.join(', ')}.`));
  if (b.missingServices.length) out.push(note(`Services not seen now: ${b.missingServices.join(', ')}.`));
  return out;
}

// --- Pricing --------------------------------------------------------------------------------

interface PricingForm {
  root: HTMLFormElement;
  inputs: Map<keyof Pricing, HTMLInputElement | HTMLSelectElement>;
  error: HTMLElement;
  source: HTMLElement;
  results: HTMLElement;
  view: PricingView;
  /** Form values from Calculate, shown until saved or reset. */
  preview: Pricing | null;
}

let pricingForm: PricingForm | null = null;

function fieldRow(form: HTMLElement, id: string, label: string, input: HTMLInputElement | HTMLSelectElement, help?: string): void {
  const row = el('div', 'field');
  const l = el('label', undefined, label);
  l.htmlFor = id;
  input.id = id;
  row.append(l, input);
  if (help) {
    const h = el('span', 'muted', help);
    h.id = `${id}-help`;
    input.setAttribute('aria-describedby', h.id);
    row.append(h);
  }
  form.append(row);
}

function numberInput(placeholder: string): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.inputMode = 'decimal';
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  return i;
}

function buildPricingForm(view: PricingView): PricingForm {
  const root = el('form', 'pricing');
  root.noValidate = true;
  const inputs = new Map<keyof Pricing, HTMLInputElement | HTMLSelectElement>();
  const currency = el('input');
  currency.maxLength = 3;
  currency.autocomplete = 'off';
  fieldRow(root, 'p-currency', 'Currency', currency, 'ISO code, e.g. USD');
  inputs.set('currency', currency);
  for (const [key, label, help] of PRICE_FIELDS) {
    const i = numberInput('not priced');
    fieldRow(root, `p-${key}`, label, i, help);
    inputs.set(key, i);
  }
  const days = numberInput('none');
  fieldRow(root, 'p-retentionDays', 'Retention days', days, 'Needed for the retained-storage price');
  inputs.set('retentionDays', days);
  const model = el('select');
  for (const [v, label] of [
    ['protobuf', 'OTLP protobuf'],
    ['json', 'OTLP JSON'],
  ] as const) {
    const o = el('option', undefined, label);
    o.value = v;
    model.append(o);
  }
  fieldRow(root, 'p-sizeModel', 'Size model', model, 'Which payload size your backend bills');
  inputs.set('sizeModel', model);
  const mult = numberInput('1');
  fieldRow(root, 'p-trafficMultiplier', 'Traffic multiplier', mult, 'Scales local volume to production, e.g. 1000');
  inputs.set('trafficMultiplier', mult);

  const error = el('p', 'error');
  error.setAttribute('role', 'alert');
  const source = el('p', 'muted');
  const actions = el('div', 'actions');
  const calculate = el('button', undefined, 'Calculate');
  calculate.type = 'button';
  const save = el('button', 'secondary', 'Save for this workspace');
  save.type = 'submit';
  const reset = el('button', 'secondary', 'Reset to settings');
  reset.type = 'button';
  const settings = el('button', 'secondary', 'Open settings');
  settings.type = 'button';
  actions.append(calculate, save, reset, settings);
  root.append(error, actions, source);
  root.addEventListener('input', () => {
    formDirty = true;
  });
  calculate.addEventListener('click', () => {
    const form = readForm();
    if (!form || !pricingForm) return;
    error.textContent = '';
    pricingForm.preview = form;
    renderPricingResults(pricingForm);
  });
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = readForm();
    if (!form || !pricingForm) return;
    error.textContent = '';
    formDirty = false;
    pricingForm.preview = null;
    post({ type: 'setPricing', overrides: overridesFrom(form, pricingForm.view.settings) });
  });
  reset.addEventListener('click', () => {
    formDirty = false;
    error.textContent = '';
    if (pricingForm) pricingForm.preview = null;
    post({ type: 'resetPricing' });
  });
  settings.addEventListener('click', () => post({ type: 'openSettings', section: 'cost' }));
  return { root, inputs, error, source, results: el('div'), view, preview: null };
}

function fillPricingForm(f: PricingForm): void {
  const p = f.view.effective;
  const text = (v: number | null) => (v === null ? '' : String(v));
  for (const [key, input] of f.inputs) {
    const v = p[key];
    input.value = typeof v === 'number' || v === null ? text(v) : v;
  }
}

function readForm(): Pricing | undefined {
  const f = pricingForm;
  if (!f) return undefined;
  const value = (key: keyof Pricing) => f.inputs.get(key)!.value;
  const fail = (msg: string, key: keyof Pricing) => {
    f.error.textContent = msg;
    (f.inputs.get(key) as HTMLElement).focus();
    return undefined;
  };
  const currency = value('currency').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return fail('Currency must be a three-letter code such as USD.', 'currency');
  const out: Pricing = { ...f.view.settings, currency };
  for (const [key, label] of PRICE_FIELDS) {
    const v = parseNumberInput(value(key), { min: 0, max: 1_000_000 });
    if (v === undefined) return fail(`${label}: enter a number from 0 to 1,000,000, or leave it empty.`, key);
    out[key] = v;
  }
  const days = parseNumberInput(value('retentionDays'), { min: 1, max: 3650, integer: true });
  if (days === undefined) return fail('Retention days: enter a whole number from 1 to 3650, or leave it empty.', 'retentionDays');
  out.retentionDays = days;
  const model = value('sizeModel');
  out.sizeModel = (model === 'json' ? 'json' : 'protobuf') as SizeModel;
  const mult = parseNumberInput(value('trafficMultiplier'), { min: Number.MIN_VALUE, max: 1_000_000, allowEmpty: false });
  if (mult === undefined || mult === null) return fail('Traffic multiplier: enter a number above 0 and up to 1,000,000.', 'trafficMultiplier');
  out.trafficMultiplier = mult;
  return out;
}

function renderPricingResults(f: PricingForm): void {
  const v = f.view;
  const u = v.usage;
  f.source.textContent =
    v.source === 'workspace'
      ? `Workspace overrides: ${Object.keys(v.overrides).join(', ')}. Other fields come from the otel.cost.* settings.`
      : 'All values come from the otel.cost.* settings.';
  const out: Node[] = [];
  const cost = f.preview ? estimateCost(u, f.preview) : v.cost;
  if (!cost) {
    out.push(section('Estimated cost', el('p', 'muted', 'Enter at least one price and click Calculate to see an estimate. Nothing is priced by default.')));
  } else {
    const money = (n: number) => formatMoney(n, cost.currency);
    out.push(
      section(
        `Estimated cost: ${money(cost.monthlyTotal)} per month`,
        ...(f.preview ? [note('Calculated from the values above; not saved. Click Save for this workspace to keep them.')] : []),
        table(
          cost.lines,
          [
            { head: 'Item', cell: (l) => COST_ITEM_LABEL[l.item] },
            { head: 'Quantity', cell: (l) => `${formatCompact(l.quantity)} ${l.unit}`, num: true },
            { head: 'Unit price', cell: (l) => money(l.unitPrice), num: true },
            { head: 'Per month', cell: (l) => money(l.monthly), num: true },
          ],
          { label: 'Estimated monthly cost' }
        ),
        el('h3', undefined, 'Assumptions'),
        list(cost.assumptions)
      )
    );
  }
  out.push(
    section(
      'Observed usage per day',
      note(`Projected from the last ${formatMinutes(u.windowMinutes)} of local data, before the traffic multiplier.`),
      table(
        [
          ['Bytes (protobuf)', formatBytes(u.bytes.protobuf)],
          ['Bytes (JSON)', formatBytes(u.bytes.json)],
          ['Spans', formatCompact(u.spans)],
          ['Log records', formatCompact(u.logs)],
          ['Active series', formatCompact(u.activeSeries)],
        ] as [string, string][],
        [
          { head: 'Item', cell: (r) => r[0] },
          { head: 'Per day', cell: (r) => r[1], num: true },
        ],
        { label: 'Observed usage per day' }
      )
    )
  );
  f.results.replaceChildren(...out);
}

function list(items: readonly string[], cls?: string): HTMLUListElement {
  const ul = el('ul', cls);
  for (const i of items) ul.append(el('li', undefined, i));
  return ul;
}

function renderPricing(view: PricingView): Node[] {
  pricingForm = buildPricingForm(view);
  fillPricingForm(pricingForm);
  renderPricingResults(pricingForm);
  const intro = note(
    'Estimates use the prices you enter: nothing is priced by default and no vendor price list is built in. ' +
      'Saved values override the otel.cost.* settings for this workspace only.'
  );
  return [section('Pricing', intro, pricingForm.root), pricingForm.results];
}

// Refreshes a mounted form in place, so typing and focus survive updates; false when not mounted.
function refreshPricing(view: PricingView): boolean {
  const f = pricingForm;
  if (!f || !contentEl.contains(f.root)) return false;
  f.view = view;
  if (!formDirty) fillPricingForm(f);
  renderPricingResults(f);
  return true;
}

// --- Details --------------------------------------------------------------------------------

function requestDetails(table: DetailTable, index: number): void {
  if (!update) return;
  post({ type: 'select', seq: update.seq, table, index });
}

function closeDetails(): void {
  selected = null;
  details = null;
  detailsEl.hidden = true;
  detailsEl.replaceChildren();
}

function facts(rows: [string, string | Node][]): HTMLElement {
  const dl = el('dl', 'facts');
  for (const [k, v] of rows) {
    const dd = el('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    dl.append(el('dt', undefined, k), dd);
  }
  return dl;
}

function samplesBlock(samples: readonly string[]): Node[] {
  if (!samples.length) return [];
  const ul = el('ul', 'samples');
  for (const s of samples) {
    const li = el('li');
    li.append(el('code', undefined, s));
    ul.append(li);
  }
  return [el('h3', undefined, 'Example values (redacted)'), ul];
}

function hintBlock(hint: string | undefined, prefer: readonly string[] | undefined): Node[] {
  const out: Node[] = [];
  if (hint) out.push(el('h3', undefined, 'How to fix'), el('p', undefined, hint));
  if (prefer?.length) out.push(el('p', undefined, `Group by instead: ${prefer.join(', ')}`));
  return out;
}

function historyBlock(history: readonly (number | null)[], label: string): Node[] {
  if (!history.some((v) => v !== null)) return [];
  return [el('h3', undefined, label), sparkline(history, DETAIL_SPARK_WIDTH, DETAIL_SPARK_HEIGHT, label)];
}

function renderDetails(): void {
  if (!details) return closeDetails();
  const d = details.data;
  const head = el('header');
  let title: string;
  const body: Node[] = [];
  switch (d.kind) {
    case 'finding': {
      const f = d.finding;
      title = findingSubject(f);
      body.push(
        facts([
          ['Severity', severityCell(f.severity)],
          ['Why', RULE_LABEL[f.rule]],
          ['Service', f.service],
          ['Unique', count(f.distinct, f.approx)],
          ['Values look like', f.valueClass ? CLASS_LABEL[f.valueClass] : 'mixed'],
          ['Bytes share', formatPercent(f.bytesShare)],
          ['Bytes', formatBytes(f.proto)],
          ['Growth', GROWTH_LABEL[f.growth]],
          ...(f.driver ? ([['Driving label', `${f.driver.label} (${count(f.driver.distinct)})`]] as [string, string][]) : []),
        ]),
        ...hintBlock(d.hint, d.prefer),
        ...samplesBlock(d.samples)
      );
      break;
    }
    case 'key': {
      const k = d.row;
      title = k.key;
      body.push(
        facts([
          ['Service', k.service],
          ['Where', SCOPE_LABEL[k.scope]],
          ['Unique', count(k.distinct, k.approx)],
          ['Occurrences', count(k.occurrences)],
          ['Values look like', k.valueClass ? CLASS_LABEL[k.valueClass] : 'mixed'],
          ['Bytes', `${formatBytes(k.proto)} (JSON ${formatBytes(k.json)})`],
          ['Growth', GROWTH_LABEL[k.growth]],
        ]),
        ...historyBlock(d.history, 'Unique values over time'),
        ...hintBlock(d.hint, d.prefer),
        ...samplesBlock(d.samples)
      );
      if (d.classes.length) {
        body.push(el('h3', undefined, 'Value mix (first values seen)'), list(d.classes.map(([c, n]) => `${CLASS_LABEL[c]}: ${n}`)));
      }
      if (d.others.length) {
        body.push(el('h3', undefined, 'Same key in other services'), list(d.others.map((o) => `${o.service}: ${count(o.distinct, o.approx)} unique`)));
      }
      break;
    }
    case 'metric': {
      const m = d.row;
      title = m.name;
      body.push(
        facts([
          ['Service', m.service],
          ['Type', m.type],
          ['Series', count(m.series, m.approx)],
          ['Points', count(m.points)],
          ['Bytes', `${formatBytes(m.proto)} (JSON ${formatBytes(m.json)})`],
          ['Growth', GROWTH_LABEL[m.growth]],
        ]),
        ...historyBlock(d.history, 'Series over time')
      );
      if (d.labels.length) {
        body.push(
          el('h3', undefined, 'Labels'),
          list(d.labels.map((l) => `${l.key}: ${count(l.distinct, l.approx)} unique${l.valueClass ? `, ${CLASS_LABEL[l.valueClass]}` : ''}`))
        );
      }
      break;
    }
    case 'template': {
      const t = d.row;
      title = 'Log pattern';
      body.push(
        el('pre', 'pattern', t.text),
        facts([
          ['Service', t.service],
          ['Logs', count(t.count)],
          ['Share', formatPercent(t.share)],
          ['Bytes', formatBytes(t.proto)],
        ]),
        ...(d.sample ? [el('h3', undefined, 'Example (redacted)'), el('pre', 'pattern', d.sample)] : [])
      );
      break;
    }
    case 'spanNames': {
      const s = d.row;
      title = `Span names of ${s.service}`;
      body.push(
        facts([
          ['Unique names', count(s.distinct, s.approx)],
          ['Checked for IDs', count(s.classified)],
          ['With IDs', count(s.withIds)],
        ]),
        ...(d.samples.length ? [el('h3', undefined, 'Names with IDs (redacted)'), list(d.samples)] : [])
      );
      break;
    }
  }
  const h = el('h2', undefined, title);
  const close = el('button', 'close', '×');
  close.setAttribute('aria-label', 'Close details');
  close.addEventListener('click', () => {
    const row = selected && contentEl.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(`${selected.table}\u0000${selected.id}`)}"]`);
    closeDetails();
    for (const r of contentEl.querySelectorAll('tr[aria-selected="true"]')) r.setAttribute('aria-selected', 'false');
    row?.focus();
  });
  head.append(h, close);
  detailsEl.replaceChildren(head, ...body);
  detailsEl.hidden = false;
}

detailsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') detailsEl.querySelector<HTMLButtonElement>('button.close')?.click();
});

// --- Render ---------------------------------------------------------------------------------

function renderContent(): void {
  if (banner) {
    bannerEl.textContent = banner.text;
    bannerEl.className = `empty ${banner.kind}`;
    bannerEl.hidden = false;
    if (banner.kind === 'disabled') {
      const b = el('button', undefined, 'Open settings');
      b.addEventListener('click', () => post({ type: 'openSettings', section: 'cardinality' }));
      bannerEl.append(el('br'), b);
    }
    contentEl.replaceChildren();
    pricingForm = null;
    return;
  }
  bannerEl.hidden = true;
  const u = update;
  if (!u) return;
  const data = u.data;
  if (data.tab === 'pricing' && refreshPricing(data.pricing)) return;
  // Rebuilding keeps neither focus nor scroll on its own.
  const focusedRow = (document.activeElement as HTMLElement | null)?.dataset?.rowId;
  const scroll = contentEl.scrollTop;
  let nodes: Node[];
  switch (data.tab) {
    case 'overview':
      nodes = renderOverview(u, data);
      break;
    case 'attributes':
      nodes = renderAttributes(data.keys);
      break;
    case 'metrics':
      nodes = renderMetrics(data.metrics);
      break;
    case 'logs':
      nodes = renderLogs(data.templates);
      break;
    case 'spanNames':
      nodes = renderSpanNames(data);
      break;
    case 'baseline':
      nodes = renderBaseline(data.baseline);
      break;
    case 'pricing':
      nodes = renderPricing(data.pricing);
      break;
  }
  if (data.tab !== 'pricing') pricingForm = null;
  if (u.summary.firstMs === null && data.tab !== 'pricing' && data.tab !== 'baseline') {
    nodes.unshift(el('p', 'empty-note', 'Nothing has been counted in this scope yet. Send telemetry to the receiver, or pick another scope.'));
  }
  contentEl.replaceChildren(...nodes);
  contentEl.scrollTop = scroll;
  if (focusedRow) contentEl.querySelector<HTMLElement>(`tr[data-row-id="${CSS.escape(focusedRow)}"]`)?.focus();
}

function render(): void {
  renderToolbar();
  renderTabs();
  renderContent();
  if (detailsDirty) {
    detailsDirty = false;
    renderDetails();
  }
}

function scheduleRender(): void {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }
}

// Re-requests details for the selected row at its new index, or closes them when the row is gone.
function followSelection(u: Update): void {
  if (!selected) return;
  const d = u.data;
  const ids: Partial<Record<DetailTable, string[]>> = {};
  if (d.tab === 'overview') ids.findings = d.findings.map(findingId);
  if (d.tab === 'attributes') ids.keys = d.keys.map(keyId);
  if (d.tab === 'metrics') ids.metrics = d.metrics.map(metricId);
  if (d.tab === 'logs') ids.templates = d.templates.map(templateId);
  if (d.tab === 'spanNames') ids.spanNames = d.spanNames.map(spanNamesId);
  const index = ids[selected.table]?.indexOf(selected.id) ?? -1;
  if (index < 0) closeDetails();
  else requestDetails(selected.table, index);
}

window.addEventListener('message', (e: MessageEvent) => {
  // The VS Code host frame posts with targetOrigin = its own origin, which is ours.
  if (e.origin !== window.origin) return;
  const msg = e.data as HostMessage;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'update':
      banner = null;
      update = msg;
      state.tab = msg.tab;
      followSelection(msg);
      break;
    case 'details': {
      if (!update || msg.seq !== update.seq || !selected || msg.table !== selected.table) return;
      const same = details && JSON.stringify(details.data) === JSON.stringify(msg.details);
      details = { table: msg.table, index: msg.index, data: msg.details };
      if (same) return;
      detailsDirty = true;
      break;
    }
    case 'disabled':
      banner = { kind: 'disabled', text: 'The cardinality analyzer is turned off (otel.cardinality.enabled). Turn it on to count new telemetry.' };
      update = null;
      closeDetails();
      break;
    case 'error':
      banner = { kind: 'error', text: `Could not build the cardinality view: ${String(msg.message)}` };
      break;
    case 'timeZone':
      localTime = msg.useLocalTime;
      break;
    default:
      return;
  }
  scheduleRender();
});

renderTabs();
post({ type: 'ready', tab: state.tab });
