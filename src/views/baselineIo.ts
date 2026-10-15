// SPDX-License-Identifier: Apache-2.0
// VS Code side of baselines: file storage under extension storage, and export/import through dialogs.

import * as vscode from 'vscode';
import { BASELINE_EXTENSION, BaselineFileError, MAX_BASELINE_FILE_BYTES } from './baselineFile';
import { BASELINE_ID, BaselineMeta, BaselineRegistry, BaselineStorage } from './baselineRegistry';

export const EXPORT_WARNING =
  'The exported file contains service, route and operation names and example trace ids. Share it only where that is acceptable.';

export function fileBaselineStorage(dir: vscode.Uri): BaselineStorage {
  const uri = (id: string, suffix = '') => {
    if (!BASELINE_ID.test(id)) throw new Error('Invalid baseline id.');
    return vscode.Uri.joinPath(dir, `${id}.json${suffix}`);
  };
  const fs = vscode.workspace.fs;
  return {
    read: async (id) => new TextDecoder('utf-8', { fatal: false }).decode(await fs.readFile(uri(id))),
    // Write then rename, so a crash mid-write never leaves a truncated body behind the index.
    write: async (id, text) => {
      const target = uri(id);
      const tmp = uri(id, '.tmp');
      await fs.createDirectory(dir);
      await fs.writeFile(tmp, Buffer.from(text, 'utf8'));
      await fs.rename(tmp, target, { overwrite: true });
    },
    remove: async (id) => fs.delete(uri(id)),
  };
}

export function createBaselineRegistry(context: vscode.ExtensionContext): BaselineRegistry {
  const dir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'baselines');
  return new BaselineRegistry(context.workspaceState, fileBaselineStorage(dir));
}

function fileNameFor(name: string): string {
  const slug = name.split(/[^A-Za-z0-9._]+/).filter(Boolean).join('-');
  return `${slug || 'baseline'}.${BASELINE_EXTENSION}`;
}

// The user confirms the B18 warning before anything is read or written.
export async function exportBaselineToFile(registry: BaselineRegistry, id: string): Promise<boolean> {
  const meta = registry.get(id);
  if (!meta) return false;
  const choice = await vscode.window.showWarningMessage(EXPORT_WARNING, { modal: true }, 'Export');
  if (choice !== 'Export') return false;
  const text = await registry.exportText(id);
  if (text === undefined) {
    vscode.window.showErrorMessage(`Could not read baseline “${meta.name}”.`);
    return false;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const fileName = fileNameFor(meta.name);
  const uri = await vscode.window.showSaveDialog({
    saveLabel: 'Export Baseline',
    filters: { 'OpenTelemetry baseline': ['json'] },
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : vscode.Uri.file(fileName),
  });
  if (!uri) return false;
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    vscode.window.showInformationMessage(`Exported baseline “${meta.name}” to ${uri.path.split('/').pop()}.`);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not export the baseline. ${(e as Error).message}`);
    return false;
  }
}

export async function importBaselineFromFile(registry: BaselineRegistry): Promise<BaselineMeta | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import Baseline',
    filters: { 'OpenTelemetry baseline': ['json'] },
  });
  const uri = picked?.[0];
  if (!uri) return undefined;
  try {
    // Size is checked before reading so an oversized file never reaches memory.
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_BASELINE_FILE_BYTES) {
      vscode.window.showErrorMessage(`File is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the 8 MB baseline limit.`);
      return undefined;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
    const meta = registry.importText(text, uri.path.split('/').pop() || 'baseline');
    vscode.window.showInformationMessage(`Imported baseline “${meta.name}”. Save it to keep it after a reload.`);
    return meta;
  } catch (e) {
    const message = e instanceof BaselineFileError ? e.message : (e as Error).message;
    vscode.window.showErrorMessage(`Could not import the baseline. ${message}`);
    return undefined;
  }
}
