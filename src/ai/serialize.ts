// SPDX-License-Identifier: Apache-2.0
// Bounded, JSON-safe copies of telemetry values and size-limited tool output. No vscode import.

import {
  MAX_ARRAY_ITEMS,
  MAX_ATTRS_PER_OBJECT,
  MAX_RESULT_CHARS,
  MAX_STRING_CHARS,
  MAX_VALUE_DEPTH,
} from './limits';

// Defines an own property, so a telemetry key like "__proto__" can't replace the prototype.
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function truncateString(s: string, max = MAX_STRING_CHARS): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // don't split a surrogate pair
  return s.slice(0, end) + '…';
}

export function safeValue(v: unknown, depth = 0): unknown {
  try {
    return safe(v, depth);
  } catch {
    return null;
  }
}

function safe(v: unknown, depth: number): unknown {
  if (depth > MAX_VALUE_DEPTH) return '[depth]';
  switch (typeof v) {
    case 'string':
      return truncateString(v);
    case 'number':
      return Number.isFinite(v) ? v : null;
    case 'boolean':
      return v;
    case 'bigint':
      return v.toString();
    case 'object':
      break;
    default:
      return v === undefined ? undefined : null;
  }
  if (v === null) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY_ITEMS).map((x) => safeValue(x, depth + 1));
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort().slice(0, MAX_ATTRS_PER_OBJECT)) {
    setOwn(out, k, safeValue(src[k], depth + 1));
  }
  return out;
}

const TOO_LARGE = JSON.stringify({ error: 'result too large' });

function stringify(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

// Serializes obj, dropping trailing obj[listKey] entries until it fits in MAX_RESULT_CHARS.
export function fitResult(obj: Record<string, unknown>, listKey: string, maxChars = MAX_RESULT_CHARS): string {
  const full = stringify(obj);
  if (full === undefined) return JSON.stringify({ error: 'result could not be serialized' });
  if (full.length <= maxChars) return full;

  const list = obj[listKey];
  if (!Array.isArray(list)) return TOO_LARGE;
  const attempt = (keep: number) =>
    stringify({ ...obj, [listKey]: list.slice(0, keep), truncated: true, omitted: list.length - keep });

  // Length only grows with the number of kept entries, so binary search finds the largest that fits.
  let lo = 0;
  let hi = list.length - 1;
  let best: string | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const text = attempt(mid);
    if (text !== undefined && text.length <= maxChars) {
      best = text;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ?? TOO_LARGE;
}

export function iso(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
