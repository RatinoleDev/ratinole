/**
 * Line chart drawn the same way as the prototype's draw(): strategy in solid
 * ink, holding dashed, optional shaded "unseen" region, four grid lines.
 * Values are plotted as given; callers pass stored series only.
 */
type Props = {
  strategy: number[];
  holding: number[];
  /** Index in the series where the shaded region starts. */
  splitIndex?: number | null;
  label: string;
  className?: string;
};

const W = 600;
const H = 230;
const P = 14;

export function Chart({ strategy, holding, splitIndex, label, className = "chart" }: Props) {
  const n = Math.max(strategy.length, holding.length);
  const all = [...strategy, ...holding].filter((v) => Number.isFinite(v));
  const grid = [0, 1, 2, 3].map((g) => P + (g * (H - 2 * P)) / 3);
  if (n < 2 || all.length === 0) {
    return (
      <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {grid.map((y) => (
          <line key={y} x1="0" x2={W} y1={y} y2={y} stroke="#E6E2D9" strokeWidth="1" />
        ))}
      </svg>
    );
  }
  const mn = Math.min(...all);
  const mx = Math.max(...all);
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - P - ((v - mn) / (mx - mn || 1)) * (H - 2 * P);
  const path = (s: number[]) =>
    s.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const sx = splitIndex !== null && splitIndex !== undefined && splitIndex > 0 && splitIndex < n ? x(splitIndex) : null;
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {grid.map((yy) => (
        <line key={yy} x1="0" x2={W} y1={yy} y2={yy} stroke="#E6E2D9" strokeWidth="1" />
      ))}
      {sx !== null && <rect x={sx} y="0" width={W - sx} height={H} fill="#CDF545" opacity=".32" />}
      {holding.length > 1 && (
        <path
          d={path(holding)}
          fill="none"
          stroke="#A29E94"
          strokeWidth="2"
          strokeDasharray="5 5"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {strategy.length > 1 && (
        <path
          d={path(strategy)}
          fill="none"
          stroke="#0B0B0C"
          strokeWidth="3"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Index of the first curve point at or after `splitIso`. */
export function splitIndexOf(points: { t: string }[], splitIso: string): number | null {
  const s = Date.parse(splitIso);
  if (!Number.isFinite(s)) return null;
  const i = points.findIndex((p) => Date.parse(p.t) >= s);
  return i > 0 ? i : null;
}
