/** Return and drawdown measures over an equity series. */

export function returnPct(series: readonly number[], start: number): number {
  const last = series.length ? series[series.length - 1]! : start;
  return (last / start - 1) * 100;
}

/** Worst peak-to-trough drop as a negative percent (0 if it never fell). */
export function maxDrawdownPct(series: readonly number[], start: number): number {
  let peak = start;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = (v / peak - 1) * 100;
    if (dd < worst) worst = dd;
  }
  return worst;
}

/** Keep at most `max` points, always including the last. */
export function downsample<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const step = Math.ceil(points.length / max);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]!);
  return out;
}
