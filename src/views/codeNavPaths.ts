// Pure path handling for Navigate To Code. File paths come from untrusted telemetry.

import * as path from 'path';
import { fileURLToPath } from 'url';

const MAX_PATH_LENGTH = 4096;
const GLOB_META = /[*?[\]{}!(),]/g;

// Returns a plain filesystem path, or undefined for anything that is not a local file.
export function sanitizeFilePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let p = raw.trim();
  if (!p || p.length > MAX_PATH_LENGTH || p.includes('\0')) return undefined;
  // Two or more letters so a Windows drive ("C:") is not mistaken for a scheme.
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(p)?.[1].toLowerCase();
  if (scheme) {
    if (scheme !== 'file') return undefined;
    try {
      p = fileURLToPath(p);
    } catch {
      return undefined;
    }
  }
  return p.replace(/\\/g, '/');
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Absolute paths inside the workspace are accepted as-is; relative ones must not escape a folder.
export function relativeCandidates(folders: readonly string[], filepath: string): string[] {
  if (path.isAbsolute(filepath)) return [];
  return folders.map((f) => path.resolve(f, filepath)).filter((c, i) => isInside(folders[i], c));
}

// Glob metacharacters become single-char wildcards; callers filter results by exact basename.
export function globSafe(name: string): string {
  return name.replace(GLOB_META, '?');
}

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean);
}

export function suffixScore(candidate: string, filepath: string): number {
  const a = segments(candidate);
  const b = segments(filepath);
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export function rankBySuffix(
  candidates: readonly string[],
  filepath: string
): { path: string; score: number }[] {
  return candidates
    .map((p) => ({ path: p, score: suffixScore(p, filepath) }))
    .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path));
}
