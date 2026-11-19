/**
 * Step 3, Weigh (HANDOFF 5.2). Each piece of evidence gets a score from -100
 * to +100 for the action the plan is considering, and the scores combine into
 * a confidence from 0 to 100. Deterministic.
 *
 * Scores use tanh of a margin measured in signal-specific units, so a rule
 * that barely holds scores near 0 and one that holds by a wide margin nears 100.
 */
import { sma, trailingMeanExcl } from "./indicators";
import type { RegimeReading } from "./regime";
import { SIGNALS, conditionHolds, formatSignalValue, fundingAverage, type SeriesSource, type SignalId, type SignalSpec } from "./signals";
import type { Condition, EvidenceItem } from "./types";

export interface ResolvedCondition {
  cond: Condition;
  /** e.g. "entry.0" */
  path: string;
  window: number;
  spec: SignalSpec;
}

export interface ConditionReading {
  rc: ResolvedCondition;
  holds: boolean;
  current: number | null;
  previous: number | null;
  item: EvidenceItem;
}

const clampScore = (x: number) => Math.max(-100, Math.min(100, Math.round(x)));
const tanhScore = (m: number) => clampScore(100 * Math.tanh(m));

const OP_SHORT: Record<Condition["op"], string> = {
  "<": "below",
  ">": "above",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

function ruleValue(spec: SignalSpec, v: number): string {
  const n = Number.isInteger(v) ? String(Math.abs(v)) : String(Math.abs(Number(v.toFixed(2))));
  const sign = v < 0 ? "−" : spec.unit === "%" && v > 0 ? "+" : "";
  return `${sign}${n}${spec.unit === "%" ? "%" : spec.unit === "x" ? "×" : ""}`;
}

export function conditionName(rc: ResolvedCondition): string {
  const id = rc.spec.id;
  if (id === "rsi") return rc.window === 14 ? "RSI" : `RSI (${rc.window} h)`;
  if (id === "price_vs_sma_pct") return `Price vs ${rc.window}-hour average`;
  if (id === "trend_pct") return `Trend (${rc.window}-hour average, 24 h)`;
  if (id === "change_pct") return `Price change (${rc.window} h)`;
  if (id === "from_high_pct") return `Below ${rc.window}-hour high`;
  if (id === "volume_ratio") return `Volume vs ${rc.window}-hour average`;
  if (id === "volatility_pct") return `Volatility (${rc.window} h)`;
  if (id === "funding_rate") return `Funding (${rc.window}-hour average)`;
  return rc.spec.name;
}

export function scoreCondition(op: Condition["op"], value: number, current: number, previous: number | null, scale: number): number {
  const holds = conditionHolds(op, value, current, previous);
  switch (op) {
    case "<":
      return tanhScore((value - current) / scale);
    case ">":
      return tanhScore((current - value) / scale);
    case "crosses_above":
    case "crosses_below": {
      const up = op === "crosses_above";
      const dist = Math.abs(current - value) / scale;
      if (holds) return clampScore(60 + 40 * Math.tanh(dist));
      const onTargetSide = up ? current > value : current < value;
      // Already past the level without a fresh cross this hour: mildly against.
      if (onTargetSide) return -20;
      return clampScore(-(20 + 80 * Math.tanh(dist)));
    }
  }
}

export function readCondition(src: SeriesSource, i: number, rc: ResolvedCondition): ConditionReading {
  const series = src.signal(rc.spec.id, rc.window);
  const current = series[i] ?? null;
  const previous = i > 0 ? (series[i - 1] ?? null) : null;
  const rule = `rule: ${OP_SHORT[rc.cond.op]} ${ruleValue(rc.spec, rc.cond.value)}`;
  if (current == null) {
    return { rc, holds: false, current, previous, item: { name: conditionName(rc), value: `not enough history (${rule})`, score: 0 } };
  }
  const holds = conditionHolds(rc.cond.op, rc.cond.value, current, previous);
  const score = scoreCondition(rc.cond.op, rc.cond.value, current, previous, rc.spec.scale);
  return {
    rc,
    holds,
    current,
    previous,
    item: { name: conditionName(rc), value: `${formatSignalValue(rc.spec.id as SignalId, current)} (${rule})`, score },
  };
}

export function resolveConditions(conds: readonly Condition[], prefix: "entry" | "exit", windows: Record<string, number>): ResolvedCondition[] {
  return conds.map((cond, k) => {
    const path = `${prefix}.${k}`;
    const spec = SIGNALS[cond.signal as SignalId];
    const window = cond.window ?? windows[path] ?? spec.defaultWindow ?? 1;
    return { cond, path, window, spec };
  });
}

/**
 * Market context scored for buying: trend, volatility and volume. For a sell
 * decision the caller negates the scores.
 */
export function contextEvidence(src: SeriesSource, i: number, reg: RegimeReading, sources: { funding?: string } = {}): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const slopeScale = Math.max(0.05, 0.3 * reg.dailyVolPct);
  const trendWord = reg.direction === "up" ? "Rising" : reg.direction === "down" ? "Falling" : "Flat";
  items.push({
    name: "Trend",
    value: `${trendWord}, 200-hour average ${pct(reg.slopePct, 2)} in 24 h`,
    score: tanhScore(reg.slopePct / slopeScale),
  });
  items.push({
    name: "Volatility",
    value: `${reg.volRatio.toFixed(1)}× its usual level, typical daily move ${reg.dailyVolPct.toFixed(1)}%`,
    score: tanhScore((1 - reg.volRatio) * 1.5),
  });

  const vol6 = src.memoize("ctx:vol6", () => sma(src.volumes, 6));
  const base = src.memoize("ctx:volbase168", () => trailingMeanExcl(src.volumes, 168));
  const v6 = vol6[i];
  const b = i >= 5 ? base[i - 5] : null;
  if (v6 != null && b != null && b > 0 && i >= 6) {
    const ratio = v6 / b;
    const ret6 = (src.closes[i]! / src.closes[i - 6]! - 1) * 100;
    const sign = ret6 > 0 ? 1 : ret6 < 0 ? -1 : 0;
    items.push({
      name: "Volume",
      value: `${ratio.toFixed(1)}× normal over 6 h, price ${pct(ret6, 1)}`,
      score: clampScore(100 * Math.tanh(ratio - 1) * sign),
    });
  }

  // Funding, read contrarian: crowded longs paying a lot argue against buying,
  // shorts paying argue for it. About +0.01% per 8 hours is neutral.
  const fr = src.memoize("ctx:funding8", () => fundingAverage(src.funding, 8))[i];
  if (fr != null) {
    items.push({
      name: "Funding",
      value: `${formatSignalValue("funding_rate", fr)} per 8 h, 8-hour average${sources.funding ? ` (${sources.funding})` : ""}`,
      score: tanhScore(-(fr - 0.01) / 0.02),
    });
  }
  return items;
}

export function negate(items: EvidenceItem[]): EvidenceItem[] {
  return items.map((e) => ({ ...e, score: e.score === 0 ? 0 : -e.score }));
}

/** Confidence 0..100: rule evidence weighs 60%, context 40%. */
export function combineConfidence(rule: EvidenceItem[], context: EvidenceItem[]): number {
  const mean = (xs: EvidenceItem[]) => xs.reduce((a, e) => a + e.score, 0) / xs.length;
  let combined: number;
  if (rule.length && context.length) combined = 0.6 * mean(rule) + 0.4 * mean(context);
  else if (rule.length) combined = mean(rule);
  else if (context.length) combined = mean(context);
  else combined = 0;
  return Math.max(0, Math.min(100, Math.round(50 + combined / 2)));
}

export function pct(v: number, digits = 1): string {
  const s = Math.abs(v).toFixed(digits);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}%`;
}
