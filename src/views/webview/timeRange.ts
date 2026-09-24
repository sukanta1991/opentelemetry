// Time-range picker shared by the logs and traces webviews. Pure: no vscode or DOM imports.

export type TimeRangeKind = '1m' | '2m' | '5m' | '15m' | '30m' | '1h' | '2h' | 'all';

export const TIME_RANGE_OPTIONS: TimeRangeKind[] = ['1m', '2m', '5m', '15m', '30m', '1h', '2h', 'all'];

export const TIME_RANGE_SECONDS: Record<TimeRangeKind, number> = {
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  all: Infinity,
};

export const TIME_RANGE_LABEL: Record<TimeRangeKind, string> = {
  '1m': 'Last 1 min',
  '2m': 'Last 2 min',
  '5m': 'Last 5 min',
  '15m': 'Last 15 min',
  '30m': 'Last 30 min',
  '1h': 'Last 1 hour',
  '2h': 'Last 2 hours',
  all: 'All',
};

export const DEFAULT_TIME_RANGE: TimeRangeKind = '5m';

export function isTimeRangeKind(v: unknown): v is TimeRangeKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIME_RANGE_SECONDS, v);
}

// Anchored to the newest record rather than the wall clock, so rows stay visible after the
// emitting app stops. Mirrors the metrics panel's windowBounds().
export function windowBounds(newestTimeMs: number, range: TimeRangeKind): [number, number] {
  if (range === 'all') return [-Infinity, Infinity];
  const to = Number.isFinite(newestTimeMs) && newestTimeMs > 0 ? newestTimeMs : Date.now();
  return [to - TIME_RANGE_SECONDS[range] * 1000, Infinity];
}
