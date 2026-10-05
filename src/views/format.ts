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
