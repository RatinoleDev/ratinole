import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOUR_MS, type Candle } from "../src/types";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Candles from a list of closes: open = previous close, flat volume unless given. */
export function fromCloses(closes: number[], opts: { start?: number; volumes?: number[] } = {}): Candle[] {
  const start = opts.start ?? T0;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    return { t: start + i * HOUR_MS, o, h: Math.max(o, c), l: Math.min(o, c), c, v: opts.volumes?.[i] ?? 100 };
  });
}

/** Geometric random walk with a drift and volatility per hour. */
export function walk(n: number, opts: { seed?: number; drift?: number; vol?: number; start?: number; p0?: number } = {}): Candle[] {
  const r = rng(opts.seed ?? 1);
  const closes: number[] = [];
  let p = opts.p0 ?? 1000;
  for (let i = 0; i < n; i++) {
    p *= 1 + (opts.drift ?? 0) + (r() - 0.5) * 2 * (opts.vol ?? 0.005);
    closes.push(p);
  }
  return fromCloses(closes, { start: opts.start, volumes: closes.map(() => 80 + r() * 40) });
}

/** Real Binance ETHUSDT hourly candles, 2026-07-16 to 2026-11-17 (3000 rows). */
export function realEth(): Candle[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, "fixtures/eth-1h.json"), "utf8")) as { rows: number[][] };
  return raw.rows.map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v! }));
}
