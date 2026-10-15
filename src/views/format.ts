// SPDX-License-Identifier: Apache-2.0
// Shared formatting helpers for the webview panels.

export function severityLabel(n: number): string {
  if (n >= 21) return 'FATAL';
  if (n >= 17) return 'ERROR';
  if (n >= 13) return 'WARN';
  if (n >= 9) return 'INFO';
  if (n >= 5) return 'DEBUG';
  if (n >= 1) return 'TRACE';
  return '';
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}min`;
}

export function formatTimestamp(ms: number, useLocalTime: boolean): string {
  if (!useLocalTime) return new Date(ms).toISOString();
  const offset = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return new Date(ms + offset * 60000).toISOString().slice(0, -1) + zone;
}

export function shortId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

// HH:MM:SS in local time, or UTC with a suffix.
export function clockTime(ms: number, useLocalTime: boolean): string {
  return useLocalTime ? formatTimestamp(ms, true).slice(11, 19) : `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

// "HH:MM" or "HH:MM:SS" on the day of `anchorMs`, or the day before if that would be after it.
export function parseClockTime(text: string, anchorMs: number, useLocalTime: boolean): number | undefined {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return undefined;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return undefined;
  const d = new Date(anchorMs);
  if (useLocalTime) d.setHours(h, min, s, 0);
  else d.setUTCHours(h, min, s, 0);
  const ms = d.getTime();
  return ms > anchorMs ? ms - 86_400_000 : ms;
}
