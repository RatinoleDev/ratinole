/**
 * Step 2, Regime (HANDOFF 5.2): trending, ranging or stressed, from trend slope
 * and realised volatility. Deterministic; no LLM.
 *
 *  - stressed: the last day's volatility is at least `stressVolRatio` times its
 *    baseline, or price is more than `stressDropPct` below its 24-hour high.
 *  - trending: the long average moved at least `trendThreshold` typical daily
 *    moves in the last 24 hours.
 *  - ranging: neither.
 */
import { logReturns, rollingMax, rollingStd, sma, pctChange } from "./indicators";
import type { SeriesSource } from "./signals";
import type { Regime } from "./types";

export interface RegimeParams {
  trendWindow: number;
  slopeLookback: number;
  volWindow: number;
  baselineWindow: number;
  minBaselineWindow: number;
  stressVolRatio: number;
  stressDropPct: number;
  trendThreshold: number;
}

export const DEFAULT_REGIME_PARAMS: RegimeParams = {
  trendWindow: 200,
  slopeLookback: 24,
  volWindow: 24,
  baselineWindow: 720,
  minBaselineWindow: 168,
  stressVolRatio: 2,
  stressDropPct: 8,
  trendThreshold: 0.15,
};

export interface RegimeReading {
  regime: Regime;
  direction: "up" | "down" | "flat";
  /** 24-hour % change of the long average. */
  slopePct: number;
  /** Typical daily move over the baseline window, %. */
  dailyVolPct: number;
  /** Last day's volatility divided by the baseline. */
  volRatio: number;
  /** % below the 24-hour high (0 or negative). */
  fromHighPct: number;
  /** Plain-language reason. */
  reason: string;
}

function stdOf(values: (number | null)[], from: number, to: number): number | null {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let k = from; k <= to; k++) {
    const v = values[k];
    if (v == null) continue;
    n++;
    sum += v;
    sumSq += v * v;
  }
  if (n < 2) return null;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1)));
}

/** Number of candles needed before a full reading is possible. */
export function regimeWarmup(p: RegimeParams = DEFAULT_REGIME_PARAMS): number {
  return Math.max(p.trendWindow + p.slopeLookback, p.minBaselineWindow + 1);
}

export function classifyRegime(src: SeriesSource, i: number, p: RegimeParams = DEFAULT_REGIME_PARAMS): RegimeReading | null {
  const avg = src.memoize(`sma:${p.trendWindow}`, () => sma(src.closes, p.trendWindow));
  const slope = src.memoize(`regime:slope:${p.trendWindow}:${p.slopeLookback}`, () => pctChange(avg, p.slopeLookback));
  const rets = src.memoize("logret", () => logReturns(src.closes));
  const volNow = src.memoize(`regime:vol:${p.volWindow}`, () => rollingStd(rets, p.volWindow));
  const high = src.memoize("regime:high:24", () => rollingMax(src.closes, 24));

  const slopePct = slope[i];
  const vNow = volNow[i];
  const h = high[i];
  if (slopePct == null || vNow == null || h == null) return null;

  // Baseline volatility over the last `baselineWindow` hours, or over all the
  // history there is when shorter (but at least `minBaselineWindow`).
  let base: number | null;
  if (i >= p.baselineWindow) {
    base = src.memoize(`regime:vol:${p.baselineWindow}`, () => rollingStd(rets, p.baselineWindow))[i] ?? null;
  } else {
    if (i < p.minBaselineWindow) return null;
    base = stdOf(rets, 1, i);
  }
  if (base == null || base === 0) return null;

  const dailyVolPct = base * Math.sqrt(24) * 100;
  const volRatio = vNow / base;
  const close = src.closes[i]!;
  const fromHighPct = (close / h - 1) * 100;
  const direction: RegimeReading["direction"] = slopePct > 0 ? "up" : slopePct < 0 ? "down" : "flat";

  if (volRatio >= p.stressVolRatio) {
    return { regime: "stressed", direction, slopePct, dailyVolPct, volRatio, fromHighPct, reason: `Volatility over the last day is ${volRatio.toFixed(1)} times its usual level.` };
  }
  if (fromHighPct <= -p.stressDropPct) {
    return { regime: "stressed", direction, slopePct, dailyVolPct, volRatio, fromHighPct, reason: `Price is ${Math.abs(fromHighPct).toFixed(1)}% below its 24-hour high.` };
  }
  const strength = Math.abs(slopePct) / dailyVolPct;
  if (strength >= p.trendThreshold) {
    const word = direction === "up" ? "rising" : "falling";
    return {
      regime: "trending",
      direction,
      slopePct,
      dailyVolPct,
      volRatio,
      fromHighPct,
      reason: `The ${p.trendWindow}-hour average is ${word} (${slopePct > 0 ? "+" : "−"}${Math.abs(slopePct).toFixed(2)}% in 24 hours) and volatility is normal.`,
    };
  }
  return {
    regime: "ranging",
    direction,
    slopePct,
    dailyVolPct,
    volRatio,
    fromHighPct,
    reason: `The ${p.trendWindow}-hour average is nearly flat (${slopePct >= 0 ? "+" : "−"}${Math.abs(slopePct).toFixed(2)}% in 24 hours) and volatility is normal.`,
  };
}
