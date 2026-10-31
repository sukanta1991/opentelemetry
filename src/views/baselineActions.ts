// SPDX-License-Identifier: Apache-2.0
// Baseline actions behind the service map's Baseline menu and the otel.baseline.* commands.

import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { readBaselineSettings, readCardinalitySettings, useLocalTime } from '../settings';
import { LIVE_REALM } from '../store/store';
import { Snapshot, SnapshotSourceKind, captureSnapshot } from './baseline';
import { ComparisonResult, compareSnapshots } from './baselineCompare';
import { exportBaselineToFile, importBaselineFromFile } from './baselineIo';
import { buildComparedMap } from './baselineMap';
import { BaselineMeta, BaselineRegistry, MAX_UNSAVED_BASELINES } from './baselineRegistry';
import { buildBaselineReport } from './baselineReport';
import { captureCardinality, compareCardinality } from './cardinalityBaseline';
import { CardinalityComparison } from './cardinalitySummary';
import { clockTime, formatTimestamp, parseClockTime } from './format';
import { ServiceMapModel } from './serviceMapModel';
import { TIME_RANGE_LABEL, TIME_RANGE_OPTIONS, TIME_RANGE_SECONDS } from './webview/timeRange';

export interface BaselineDeps {
  controller: OtelController;
  registry: BaselineRegistry;
  openComparison(a: string, b: string): void;
}

// The map the menu was opened from, if any.
export interface MapContext {
  realm: string;
  model: ServiceMapModel | null;
  readOnly: boolean;
  compare?: { a: string; b: string };
}

interface Bounds {
  anchorMs: number;
  fromMs: number;
}

const MINUTE = 60_000;

// QuickPick labels and descriptions render `$(name)` as an icon; names can come from imported files.
const noIcons = (text: string) => text.replace(/\$\(/g, '$\u200b(');

// Newest and oldest span end in the realm, for capture commands run without a map open.
function dataBounds(controller: OtelController, realm: string): Bounds | undefined {
  let anchorMs = -Infinity;
  let fromMs = Infinity;
  for (const t of controller.store.getAllTaggedSpans(realm)) {
    if (t.span.endMs > anchorMs) anchorMs = t.span.endMs;
    if (t.span.endMs < fromMs) fromMs = t.span.endMs;
  }
  if (anchorMs === -Infinity) {
    vscode.window.showInformationMessage('No spans collected yet. Send some traffic, then capture a baseline.');
    return undefined;
  }
  return { anchorMs, fromMs };
}

export async function captureBaseline(
  deps: BaselineDeps,
  realm: string,
  kind: Exclude<SnapshotSourceKind, 'file'>,
  bounds: { fromMs?: number; toMs?: number } = {}
): Promise<BaselineMeta | undefined> {
  const { controller, registry } = deps;
  const tagged = controller.store.getAllTaggedSpans(realm);
  const session = realm === LIVE_REALM ? undefined : controller.store.getSession(realm)?.source;
  const local = useLocalTime();
  const until = (ms: number) => clockTime(ms, local);
  const snapshot = captureSnapshot(tagged, { kind, label: session ?? 'live', realm, ...bounds });
  if (!snapshot.entries.length) {
    vscode.window.showInformationMessage('No calls to capture in that range yet.');
    return undefined;
  }
  const cardinality = captureCardinality(controller.store.getAllInstances(), { realm });
  if (cardinality) snapshot.cardinality = cardinality;
  const to = snapshot.source.toMs;
  const name =
    kind === 'session' ? `Session ${session ?? ''}` : kind === 'mark' ? `Mark ${until(to)}` : kind === 'time' ? `Until ${until(to)}` : `Window to ${until(to)}`;
  const { meta, evicted } = registry.add(name, snapshot);
  await registry.setActive(meta.id);
  if (evicted) {
    vscode.window.showWarningMessage(
      `Dropped unsaved baseline “${evicted.name}”: only the ${MAX_UNSAVED_BASELINES} most recent unsaved baselines are kept. Save the ones you need.`
    );
  }
  const since = kind === 'session' ? '' : ` Calls after ${until(to)} are compared with it.`;
  void vscode.window.showInformationMessage(`Baseline “${meta.name}” is active.${since}`, 'Save', 'Rename').then((pick) => {
    if (pick === 'Save') return saveBaseline(deps, meta.id);
    if (pick === 'Rename') return renameBaseline(deps, meta.id);
  });
  return meta;
}

// Recent whole minutes inside the window, plus free entry.
export async function pickCaptureTime(model: Bounds): Promise<number | undefined> {
  const local = useLocalTime();
  const marks: number[] = [];
  for (let t = Math.floor(model.anchorMs / MINUTE) * MINUTE; t > model.fromMs && marks.length < 10; t -= MINUTE) marks.push(t);
  const ENTER = -1;
  const pick = await vscode.window.showQuickPick(
    [
      ...marks.map((t) => ({ label: `$(clock) ${clockTime(t, local)}`, description: `${Math.round((model.anchorMs - t) / 1000)} s before the newest span`, t })),
      { label: '$(edit) Enter a time…', description: local ? 'HH:MM or HH:MM:SS, local time' : 'HH:MM or HH:MM:SS, UTC', t: ENTER },
    ],
    { title: 'Capture a baseline up to…', placeHolder: 'Calls ending at or before this time become the baseline' }
  );
  if (!pick) return undefined;
  if (pick.t !== ENTER) return pick.t;
  const text = await vscode.window.showInputBox({
    title: 'Capture a baseline up to…',
    prompt: local ? 'Time of day (local), HH:MM or HH:MM:SS' : 'Time of day (UTC), HH:MM or HH:MM:SS',
    validateInput: (v) => (parseClockTime(v, model.anchorMs, local) === undefined ? 'Use HH:MM or HH:MM:SS.' : undefined),
  });
  return text === undefined ? undefined : parseClockTime(text, model.anchorMs, local);
}

export async function captureFromSession(deps: BaselineDeps): Promise<BaselineMeta | undefined> {
  const sessions = deps.controller.store.getImportedSessions();
  if (!sessions.length) {
    vscode.window.showInformationMessage('Load a session file first (OpenTelemetry: Load Session).');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: noIcons(s.session.source), description: `${s.instances.length} instances`, id: s.session.id })),
    { title: 'Use a loaded session as the baseline' }
  );
  return pick ? captureBaseline(deps, pick.id, 'session') : undefined;
}

function describe(m: BaselineMeta, activeId: string | undefined): vscode.QuickPickItem & { id: string } {
  const state = m.unavailable ? 'unreadable' : m.saved ? 'saved' : 'unsaved';
  return {
    label: `${m.id === activeId ? '$(check) ' : ''}${noIcons(m.name)}`,
    description: noIcons(`${state} · ${m.sourceKind}${m.sourceLabel ? ` · ${m.sourceLabel}` : ''}`),
    detail: `Captured ${new Date(m.createdMs).toLocaleString()}`,
    id: m.id,
  };
}

async function pickBaseline(registry: BaselineRegistry, title: string, filter: (m: BaselineMeta) => boolean = () => true): Promise<string | undefined> {
  const items = registry.list().filter(filter);
  if (!items.length) {
    vscode.window.showInformationMessage('There are no baselines to choose from.');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items.map((m) => describe(m, registry.activeId)), { title }))?.id;
}

export async function switchBaseline(deps: BaselineDeps): Promise<void> {
  const { registry } = deps;
  const NONE = '';
  const pick = await vscode.window.showQuickPick(
    [...registry.list().map((m) => describe(m, registry.activeId)), { label: '$(circle-slash) None', description: 'Stop comparing', id: NONE }],
    { title: 'Active baseline' }
  );
  if (pick) await registry.setActive(pick.id === NONE ? undefined : pick.id);
}

export async function compareBaselines(deps: BaselineDeps): Promise<void> {
  if (deps.registry.list().length < 2) {
    vscode.window.showInformationMessage('Capture or import at least two baselines to compare them.');
    return;
  }
  const a = await pickBaseline(deps.registry, 'Compare baselines: before');
  if (!a) return;
  const b = await pickBaseline(deps.registry, 'Compare baselines: after', (m) => m.id !== a);
  if (b) deps.openComparison(a, b);
}

export async function saveBaseline(deps: BaselineDeps, id?: string): Promise<void> {
  const { registry } = deps;
  const active = registry.activeId && registry.get(registry.activeId);
  const target = id ?? (active && !active.saved ? active.id : await pickBaseline(registry, 'Save which baseline?', (m) => !m.saved));
  if (!target) return;
  try {
    const meta = await registry.save(target);
    vscode.window.showInformationMessage(`Saved baseline “${meta.name}”.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not save the baseline. ${(e as Error).message}`);
  }
}

export async function renameBaseline(deps: BaselineDeps, id?: string): Promise<void> {
  const { registry } = deps;
  const target = id ?? (await pickBaseline(registry, 'Rename which baseline?'));
  const meta = target ? registry.get(target) : undefined;
  if (!meta) return;
  const name = await vscode.window.showInputBox({
    title: 'Rename baseline',
    value: meta.name,
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name.'),
  });
  if (name !== undefined) await registry.rename(meta.id, name);
}

export async function deleteBaseline(deps: BaselineDeps, id?: string): Promise<void> {
  const { registry } = deps;
  const target = id ?? (await pickBaseline(registry, 'Delete which baseline?'));
  const meta = target ? registry.get(target) : undefined;
  if (!meta) return;
  if (meta.saved) {
    const ok = await vscode.window.showWarningMessage(`Delete saved baseline “${meta.name}”?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
  }
  await registry.remove(meta.id);
}

export async function exportBaseline(deps: BaselineDeps, id?: string): Promise<void> {
  const target = id ?? (await pickBaseline(deps.registry, 'Export which baseline?', (m) => !m.unavailable));
  if (target) await exportBaselineToFile(deps.registry, target);
}

export async function importBaseline(deps: BaselineDeps): Promise<void> {
  const meta = await importBaselineFromFile(deps.registry);
  if (meta) await deps.registry.setActive(meta.id);
}

type MenuAction = () => Promise<unknown> | void;

export async function captureWindowFromCommand(deps: BaselineDeps): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    TIME_RANGE_OPTIONS.map((r) => ({ label: r === 'all' ? 'All retained' : TIME_RANGE_LABEL[r], range: r })),
    { title: 'Capture a baseline from', placeHolder: 'Window back from the newest span received' }
  );
  const bounds = pick && dataBounds(deps.controller, LIVE_REALM);
  if (!pick || !bounds) return;
  const fromMs = pick.range === 'all' ? undefined : bounds.anchorMs - TIME_RANGE_SECONDS[pick.range] * 1000;
  await captureBaseline(deps, LIVE_REALM, 'window', { fromMs, toMs: bounds.anchorMs });
}

export async function captureAtFromCommand(deps: BaselineDeps): Promise<void> {
  const bounds = dataBounds(deps.controller, LIVE_REALM);
  if (!bounds) return;
  const toMs = await pickCaptureTime(bounds);
  if (toMs !== undefined) await captureBaseline(deps, LIVE_REALM, 'time', { toMs });
}

// Baseline A against B, or against the live usage counters; undefined when either side has none.
function cardinalityChanges(deps: BaselineDeps, a: Snapshot, b: Snapshot | undefined): CardinalityComparison | undefined {
  if (!a.cardinality) return undefined;
  const current = b ? b.cardinality : captureCardinality(deps.controller.store.getAllInstances(), { realm: LIVE_REALM });
  return current && compareCardinality(a.cardinality, current, readCardinalitySettings());
}

// Active baseline against live calls, or baseline A against B; copied as Markdown.
export async function copyBaselineReport(deps: BaselineDeps, compare?: { a: string; b: string }): Promise<void> {
  const { registry, controller } = deps;
  const aId = compare?.a ?? registry.activeId;
  if (!aId) {
    vscode.window.showInformationMessage('No baseline is active. Capture or switch to one first.');
    return;
  }
  const a = await registry.load(aId);
  const b = compare ? await registry.load(compare.b) : undefined;
  if (!a || (compare && !b)) {
    vscode.window.showErrorMessage('Could not read the baseline to report on.');
    return;
  }
  const settings = readBaselineSettings();
  let result: ComparisonResult | null;
  let against: string;
  let cutoffMs: number | undefined;
  if (b) {
    result = compareSnapshots(a.snapshot, b.snapshot, settings);
    against = `baseline “${registry.get(b.meta.id)?.name ?? b.meta.name}”`;
  } else {
    const built = buildComparedMap(controller.store.getAllTaggedSpans(LIVE_REALM), { range: 'all' }, a.snapshot, settings, LIVE_REALM);
    result = built.comparison;
    cutoffMs = built.model.cutoffMs;
    against = 'live calls';
  }
  if (!result) {
    vscode.window.showInformationMessage('No calls after the baseline cut-off yet, so there is nothing to report.');
    return;
  }
  const local = useLocalTime();
  const time = (ms: number) => formatTimestamp(ms, local).slice(0, 19).replace('T', ' ') + (local ? '' : ' UTC');
  const cardinality = cardinalityChanges(deps, a.snapshot, b?.snapshot);
  const text = buildBaselineReport(result, { baseline: registry.get(aId) ?? a.meta, against, cutoffMs, time, cardinality });
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Copied the baseline comparison (Markdown) to the clipboard.');
}

export async function showBaselineMenu(deps: BaselineDeps, ctx?: MapContext): Promise<void> {
  const { registry, controller } = deps;
  const list = registry.list();
  const active = registry.activeId ? registry.get(registry.activeId) : undefined;
  const items: (vscode.QuickPickItem & { run?: MenuAction })[] = [];
  const add = (label: string, description: string, run: MenuAction) => items.push({ label, description, run });
  const model = ctx?.model;
  if (ctx && model && !ctx.readOnly) {
    add('$(record) Capture current window', 'Everything the map shows now', () =>
      captureBaseline(deps, ctx.realm, 'window', { fromMs: model.fromMs, toMs: model.anchorMs })
    );
    add('$(pin) Mark now', 'Everything collected so far; later calls are compared', () => captureBaseline(deps, ctx.realm, 'mark'));
    add('$(clock) Capture up to a time…', 'Pick the cut-off', async () => {
      const toMs = await pickCaptureTime(model);
      if (toMs !== undefined) await captureBaseline(deps, ctx.realm, 'time', { toMs });
    });
  } else if (!ctx) {
    add('$(pin) Mark now', 'Everything collected so far; later calls are compared', () => captureBaseline(deps, LIVE_REALM, 'mark'));
    add('$(record) Capture from a recent window…', 'e.g. the last 5 minutes', () => captureWindowFromCommand(deps));
    add('$(clock) Capture up to a time…', 'Pick the cut-off', () => captureAtFromCommand(deps));
  }
  if ((!ctx || ctx.realm === LIVE_REALM) && controller.store.getImportedSessions().length) {
    add('$(file) Use a loaded session…', 'Compare live data with a session file', () => captureFromSession(deps));
  }
  if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (list.length) add('$(list-selection) Switch active baseline…', active ? `Active: ${noIcons(active.name)}` : 'None active', () => switchBaseline(deps));
  if (list.length > 1) add('$(diff) Compare two baselines…', 'Opens a read-only map', () => compareBaselines(deps));
  if (active && !active.saved) add('$(save) Save active baseline', noIcons(active.name), () => saveBaseline(deps, active.id));
  if (ctx?.compare || active) {
    add('$(copy) Copy comparison report', 'Markdown, for a PR description or chat', () => copyBaselineReport(deps, ctx?.compare));
  }
  if (list.length) {
    add('$(edit) Rename…', '', () => renameBaseline(deps));
    add('$(trash) Delete…', '', () => deleteBaseline(deps));
    add('$(export) Export to file…', '', () => exportBaseline(deps));
  }
  add('$(cloud-download) Import from file…', '', () => importBaseline(deps));
  if (active) add('$(circle-slash) Stop comparing', noIcons(active.name), () => registry.setActive(undefined));
  const pick = await vscode.window.showQuickPick(items, { title: 'Baselines' });
  await pick?.run?.();
}
