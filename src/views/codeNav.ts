import * as path from 'path';
import * as vscode from 'vscode';
import { CodeLocation } from '../store/model';
import { globSafe, isInside, rankBySuffix, relativeCandidates, sanitizeFilePath } from './codeNavPaths';

const CANCELLED = 'cancelled';

export async function openCodeLocation(loc: CodeLocation | undefined): Promise<void> {
  if (!loc) {
    vscode.window.showInformationMessage(
      'No code location available (requires code.filepath / code.lineno attributes).'
    );
    return;
  }
  const filepath = sanitizeFilePath(loc.filepath);
  const uri = filepath ? await resolveCodeFile(filepath) : undefined;
  if (uri === CANCELLED) return;
  if (!uri) {
    vscode.window.showWarningMessage(`Could not locate file: ${loc.filepath}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const pos = doc.validatePosition(
    new vscode.Position(Math.max(0, (loc.line ?? 1) - 1), Math.max(0, (loc.column ?? 1) - 1))
  );
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function resolveCodeFile(filepath: string): Promise<vscode.Uri | typeof CANCELLED | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);

  if (path.isAbsolute(filepath)) {
    const uri = vscode.Uri.file(filepath);
    if (await exists(uri)) {
      if (folders.some((f) => isInside(f, uri.fsPath))) return uri;
      return (await confirmOutsideWorkspace(uri.fsPath)) ? uri : CANCELLED;
    }
  } else {
    for (const candidate of relativeCandidates(folders, filepath)) {
      const uri = vscode.Uri.file(candidate);
      if (await exists(uri)) return uri;
    }
  }
  return searchWorkspace(filepath);
}

async function searchWorkspace(filepath: string): Promise<vscode.Uri | typeof CANCELLED | undefined> {
  const base = path.posix.basename(filepath);
  if (!base) return undefined;
  const found = await vscode.workspace.findFiles(`**/${globSafe(base)}`, '**/node_modules/**', 20);
  const byPath = new Map(
    found.filter((u) => path.basename(u.fsPath) === base).map((u) => [u.fsPath, u] as const)
  );
  const ranked = rankBySuffix([...byPath.keys()], filepath);
  if (!ranked.length) return undefined;
  const tied = ranked.filter((r) => r.score === ranked[0].score);
  if (tied.length === 1) return byPath.get(tied[0].path);
  const pick = await vscode.window.showQuickPick(
    tied.map((r) => ({ label: vscode.workspace.asRelativePath(r.path), fsPath: r.path })),
    { placeHolder: `Several files match ${filepath}` }
  );
  return pick ? byPath.get(pick.fsPath) : CANCELLED;
}

async function confirmOutsideWorkspace(fsPath: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'Open a file outside the workspace?',
    { modal: true, detail: `The telemetry points to ${fsPath}` },
    'Open'
  );
  return choice === 'Open';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
