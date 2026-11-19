import { HOUR_MS, type Candle } from "@rationale/brain";
import type { CandleFeed } from "../src/market/types";

/** A deterministic candle series covering [start, end). */
export function synthCandles(start: number, end: number, seed = 1): Candle[] {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let p = 2000;
  for (let t = start; t < end; t += HOUR_MS) {
    const o = p;
    p *= 1 + (r() - 0.5) * 0.01;
    out.push({ t, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, v: 100 + r() * 50 });
  }
  return out;
}

export function fakeFeed(name: string, series: Candle[] | (() => never), calls: { n: number } = { n: 0 }): CandleFeed {
  return {
    name,
    symbol: (m) => `${m}USDT`,
    async fetch(_market, from, to) {
      calls.n++;
      if (typeof series === "function") return series();
      return series.filter((c) => c.t >= from && c.t < to);
    },
  };
}
