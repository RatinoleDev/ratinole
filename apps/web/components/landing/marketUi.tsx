/** Small display helpers shared by the server-rendered and live market pieces. */
import type { MarketDTO } from "@rationale/config";

export function LiveDot({ label }: { label?: string }) {
  return <span className="livedot" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function priceText(v: number): string {
  return v >= 10_000
    ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fundingText(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(4)}%`;
}

export function regimeText(m: Pick<MarketDTO, "regime" | "direction">): string {
  if (m.regime === "trending") return m.direction === "down" ? "Trending down" : m.direction === "up" ? "Trending up" : "Trending";
  return m.regime === "ranging" ? "Ranging" : "Stressed";
}

/** A glowing line chart of closes; the last value may be a live price. */
export function Sparkline({ values, id, height = 84 }: { values: number[]; id: string; height?: number }) {
  if (values.length < 2) return null;
  const w = 300;
  const h = height;
  const pad = 6;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / (values.length - 1), pad + (1 - (v - lo) / (hi - lo || 1)) * (h - 2 * pad)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  const area = `${pad},${h} ${line} ${(w - pad).toFixed(1)},${h}`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`sg-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#C6F432" stopOpacity="0.32" />
          <stop offset="1" stopColor="#C6F432" stopOpacity="0" />
        </linearGradient>
        <filter id={`sf-${id}`} x="-10%" y="-30%" width="120%" height="160%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <polygon points={area} fill={`url(#sg-${id})`} />
      <polyline points={line} fill="none" stroke="#C6F432" strokeWidth="5" opacity="0.4" filter={`url(#sf-${id})`} vectorEffect="non-scaling-stroke" />
      <polyline points={line} fill="none" stroke="#DFFF7A" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="#E6FF8A" className="spark-end" />
    </svg>
  );
}
