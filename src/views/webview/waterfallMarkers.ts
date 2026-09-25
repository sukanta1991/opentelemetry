// Groups a span's logs into bar markers so dense spans stay readable. Pure: no DOM.

export interface MarkerLog {
  seq: number;
  offsetMs: number;
  severityNumber: number;
}

export interface LogMarker {
  pct: number;
  count: number;
  maxSeverity: number;
  seqs: number[];
  // True when any member lies outside the span and was pinned to its edge.
  clamped: boolean;
}

export function bucketLogMarkers(
  logs: readonly MarkerLog[],
  spanOffsetMs: number,
  spanDurMs: number,
  totalMs: number,
  bucketPct = 0.5,
  maxPerBar = 50
): LogMarker[] {
  if (!logs.length) return [];
  const end = spanOffsetMs + Math.max(0, spanDurMs);
  const scale = totalMs > 0 ? 100 / totalMs : 0;
  const points = logs.map((l) => {
    const at = Math.min(end, Math.max(spanOffsetMs, l.offsetMs));
    return { log: l, pct: at * scale, clamped: at !== l.offsetMs };
  });

  let width = Math.max(bucketPct, 1e-6);
  for (;;) {
    const buckets = new Map<number, LogMarker & { sum: number }>();
    for (const p of points) {
      const key = Math.floor(p.pct / width);
      let b = buckets.get(key);
      if (!b) {
        b = { pct: 0, count: 0, maxSeverity: 0, seqs: [], clamped: false, sum: 0 };
        buckets.set(key, b);
      }
      b.count++;
      b.sum += p.pct;
      b.seqs.push(p.log.seq);
      b.maxSeverity = Math.max(b.maxSeverity, p.log.severityNumber);
      b.clamped ||= p.clamped;
    }
    if (buckets.size <= maxPerBar || width >= 100) {
      return [...buckets.values()]
        .map(({ sum, ...m }) => ({ ...m, pct: sum / m.count }))
        .sort((a, b) => a.pct - b.pct);
    }
    width *= 2;
  }
}

export type SeverityClass = 'error' | 'warn' | 'info' | 'debug';

export function severityBucket(n: number): SeverityClass {
  if (n >= 17) return 'error';
  if (n >= 13) return 'warn';
  if (n >= 9) return 'info';
  return 'debug';
}
