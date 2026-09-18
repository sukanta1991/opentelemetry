// Pure numeric transforms for chart kinds derived from a line series.
// Must not import vscode, uplot, or DOM so they stay node-testable.

// Per-second rate of change. First sample and any step with a non-positive
// dt yields null. Negative deltas are clamped to null only when clampResets is
// set (monotonic counters); non-monotonic sums keep their real signed deltas.
export function computeRate(
  xs: number[],
  ys: (number | null)[],
  clampResets = true
): (number | null)[] {
  const out: (number | null)[] = new Array(ys.length).fill(null);
  for (let i = 1; i < ys.length; i++) {
    const cur = ys[i];
    const prev = ys[i - 1];
    if (cur == null || prev == null) continue;
    const dt = xs[i] - xs[i - 1];
    if (!(dt > 0)) continue;
    const delta = cur - prev;
    out[i] = clampResets && delta < 0 ? null : delta / dt;
  }
  return out;
}

// Cumulative bands for stacked-area rendering. Nulls are treated as 0 for
// accumulation; each output series is the running total of itself and all
// series below it, so uPlot fills render as stacked layers.
export function stack(seriesYs: (number | null)[][]): number[][] {
  const len = seriesYs.reduce((m, s) => Math.max(m, s.length), 0);
  const running = new Array(len).fill(0);
  return seriesYs.map((s) => {
    const band = new Array<number>(len);
    for (let i = 0; i < len; i++) {
      running[i] += s[i] ?? 0;
      band[i] = running[i];
    }
    return band;
  });
}
