/**
 * The signals a Plan condition may name. Phase 1 computes price and volume
 * signals from hourly candles. Signals that need other data (funding, flows,
 * news) are listed so the intake can say exactly what is missing, but they are
 * marked unavailable and a plan using them is refused.
 */
import {
  logReturns,
  pctChange,
  rollingMax,
  rollingStd,
  rsi,
  sma,
  trailingMeanExcl,
  type Series,
} from "./indicators";
import type { Candle, Condition, Op } from "./types";

export type SignalId =
  | "rsi"
  | "price_vs_sma_pct"
  | "trend_pct"
  | "change_pct"
  | "from_high_pct"
  | "volume_ratio"
  | "volatility_pct"
  | "funding_rate"
  | "open_interest_change_pct"
  | "liquidations_usd"
  | "wallet_net_flow_usd"
  | "news_sentiment";

export interface SignalSpec {
  id: SignalId;
  /** Short name used in evidence, e.g. "RSI". */
  name: string;
  /** What the number means, for the LLM prompt and docs. */
  meaning: string;
  unit: "" | "%" | "x" | "USD";
  available: boolean;
  /** For unavailable signals: the data we do not collect yet. */
  needs?: string;
  defaultWindow?: number;
  /** Windows the tuner may try when the sentence gives none. */
  windowChoices?: number[];
  /** One "unit of margin" when scoring how strongly a condition holds. */
  scale: number;
  /** Allowed range for a condition value. */
  range: [number, number];
  compute?: (s: SeriesSource, window: number) => Series;
}

/** Candle columns plus a memo so each (signal, window) series is computed once. */
export class SeriesSource {
  readonly closes: number[];
  readonly volumes: number[];
  private memo = new Map<string, Series>();
  constructor(readonly candles: readonly Candle[]) {
    this.closes = candles.map((c) => c.c);
    this.volumes = candles.map((c) => c.v);
  }
  memoize(key: string, make: () => Series): Series {
    let s = this.memo.get(key);
    if (!s) {
      s = make();
      this.memo.set(key, s);
    }
    return s;
  }
  get length(): number {
    return this.candles.length;
  }
  /** Series for a signal at a window (defaults applied). */
  signal(id: SignalId, window?: number): Series {
    const spec = SIGNALS[id];
    if (!spec.compute) throw new Error(`Signal ${id} is not available`);
    const w = window ?? spec.defaultWindow ?? 1;
    return this.memoize(`${id}:${w}`, () => spec.compute!(this, w));
  }
}

const returnsOf = (s: SeriesSource) => s.memoize("logret", () => logReturns(s.closes));
const smaOf = (s: SeriesSource, w: number) => s.memoize(`sma:${w}`, () => sma(s.closes, w));

export const SIGNALS: Record<SignalId, SignalSpec> = {
  rsi: {
    id: "rsi",
    name: "RSI",
    meaning: "Relative strength index of hourly closes, 0 to 100. Below 30 is oversold, above 70 overbought.",
    unit: "",
    available: true,
    defaultWindow: 14,
    windowChoices: [14],
    scale: 10,
    range: [0, 100],
    compute: (s, w) => rsi(s.closes, w),
  },
  price_vs_sma_pct: {
    id: "price_vs_sma_pct",
    name: "Price vs average",
    meaning:
      "Percent the latest close is above (+) or below (-) its moving average over `window` hours. A 3% dip under the 20-hour average is value -3, window 20.",
    unit: "%",
    available: true,
    defaultWindow: 20,
    windowChoices: [20, 50],
    scale: 2,
    range: [-50, 50],
    compute: (s, w) => {
      const avg = smaOf(s, w);
      return s.closes.map((c, i) => {
        const a = avg[i];
        return a == null ? null : (c / a - 1) * 100;
      });
    },
  },
  trend_pct: {
    id: "trend_pct",
    name: "Trend",
    meaning:
      "Percent change over the last 24 hours of the moving average over `window` hours. Above 0 means the long trend is rising (an uptrend), below 0 falling.",
    unit: "%",
    available: true,
    defaultWindow: 200,
    windowChoices: [100, 200],
    scale: 0.5,
    range: [-20, 20],
    compute: (s, w) => pctChange(smaOf(s, w), 24),
  },
  change_pct: {
    id: "change_pct",
    name: "Price change",
    meaning: "Percent change of the close over the last `window` hours.",
    unit: "%",
    available: true,
    defaultWindow: 24,
    windowChoices: [24],
    scale: 3,
    range: [-90, 500],
    compute: (s, w) => pctChange(s.closes, w),
  },
  from_high_pct: {
    id: "from_high_pct",
    name: "Below recent high",
    meaning:
      "Percent the latest close is below the highest close of the last `window` hours (0 or negative). A 5% drop from the 3-day high is value -5, window 72.",
    unit: "%",
    available: true,
    defaultWindow: 72,
    windowChoices: [24, 72],
    scale: 3,
    range: [-90, 0],
    compute: (s, w) => {
      const hi = rollingMax(s.closes, w);
      return s.closes.map((c, i) => {
        const h = hi[i];
        return h == null ? null : (c / h - 1) * 100;
      });
    },
  },
  volume_ratio: {
    id: "volume_ratio",
    name: "Volume",
    meaning: "Volume of the latest hour divided by the average hourly volume of the previous `window` hours. 2 means twice normal.",
    unit: "x",
    available: true,
    defaultWindow: 24,
    windowChoices: [24],
    scale: 0.5,
    range: [0, 100],
    compute: (s, w) => {
      const avg = trailingMeanExcl(s.volumes, w);
      return s.volumes.map((v, i) => {
        const a = avg[i];
        return a == null || a === 0 ? null : v / a;
      });
    },
  },
  volatility_pct: {
    id: "volatility_pct",
    name: "Volatility",
    meaning: "Typical daily move in percent, from the spread of hourly returns over the last `window` hours.",
    unit: "%",
    available: true,
    defaultWindow: 24,
    windowChoices: [24],
    scale: 1,
    range: [0, 100],
    compute: (s, w) => rollingStd(returnsOf(s), w).map((v) => (v == null ? null : v * Math.sqrt(24) * 100)),
  },
  funding_rate: {
    id: "funding_rate",
    name: "Funding rate",
    meaning: "Perpetual futures funding rate.",
    unit: "%",
    available: false,
    needs: "funding rates",
    scale: 0.01,
    range: [-10, 10],
  },
  open_interest_change_pct: {
    id: "open_interest_change_pct",
    name: "Open interest",
    meaning: "Change in futures open interest.",
    unit: "%",
    available: false,
    needs: "open interest",
    scale: 2,
    range: [-100, 1000],
  },
  liquidations_usd: {
    id: "liquidations_usd",
    name: "Liquidations",
    meaning: "Value of futures positions liquidated recently.",
    unit: "USD",
    available: false,
    needs: "liquidation data",
    scale: 1e7,
    range: [0, 1e12],
  },
  wallet_net_flow_usd: {
    id: "wallet_net_flow_usd",
    name: "Wallet flow",
    meaning: "Net buying (+) or selling (-) by large wallets ('whales').",
    unit: "USD",
    available: false,
    needs: "large-wallet flows",
    scale: 1e6,
    range: [-1e12, 1e12],
  },
  news_sentiment: {
    id: "news_sentiment",
    name: "News sentiment",
    meaning: "Headline sentiment from -100 to 100.",
    unit: "",
    available: false,
    needs: "news headlines",
    scale: 20,
    range: [-100, 100],
  },
};

export const SIGNAL_IDS = Object.keys(SIGNALS) as SignalId[];

export function isSignalId(v: string): v is SignalId {
  return v in SIGNALS;
}

/** The window a condition uses, given tuned overrides keyed by condition path. */
export function windowFor(cond: Condition, tuned?: number): number {
  const spec = SIGNALS[cond.signal as SignalId];
  return cond.window ?? tuned ?? spec?.defaultWindow ?? 1;
}

/** Whether a condition holds at index i. Crossing ops compare i-1 and i. */
export function conditionHolds(op: Op, value: number, current: number, previous: number | null): boolean {
  switch (op) {
    case "<":
      return current < value;
    case ">":
      return current > value;
    case "crosses_above":
      return previous != null && previous <= value && current > value;
    case "crosses_below":
      return previous != null && previous >= value && current < value;
  }
}

export function formatSignalValue(id: SignalId, v: number): string {
  const spec = SIGNALS[id];
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const n = v.toFixed(digits).replace(/^-/, "−");
  if (spec.unit === "%") return `${v > 0 ? "+" : ""}${n}%`;
  if (spec.unit === "x") return `${n}×`;
  return n;
}
