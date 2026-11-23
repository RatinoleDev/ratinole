import type { Plan } from "@rationale/brain";

/** Robinhood Chain (HANDOFF section 4). Re-verify on-chain before any live use. */
export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpcUrl: "https://robinhood.drpc.org",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

/**
 * Markets available in Phase 1 paper trading. Prices come from Binance public
 * market data (ETHUSDT, BTCUSDT) with Hyperliquid as a fallback; USDT and USDG
 * are both dollar stablecoins, so the USDT price stands in for the USDG pair.
 */
export const MARKETS = {
  ETH: { id: "ETH", label: "ETH / USDG", binanceSymbol: "ETHUSDT", hyperliquidCoin: "ETH" },
  BTC: { id: "BTC", label: "BTC / USDG", binanceSymbol: "BTCUSDT", hyperliquidCoin: "BTC" },
} as const;
export type MarketId = keyof typeof MARKETS;
export const MARKET_IDS = Object.keys(MARKETS) as MarketId[];
export function isMarketId(v: string): v is MarketId {
  return v in MARKETS;
}
export function marketLabel(id: string): string {
  return isMarketId(id) ? MARKETS[id].label : `${id} / USDG`;
}

export const PAPER = {
  /** Virtual cash each paper agent starts with, in USD. */
  startingCash: 10_000,
  /** Paper agents per wallet. Pricing is undecided (HANDOFF section 9); this is the prototype's proposal. */
  maxAgentsPerUser: 3,
  /** Fee plus slippage charged on every simulated trade, in percent (HANDOFF 5.4). */
  costPct: 0.1,
} as const;

/** Defaults for each wallet's own limits. */
export const RISK_DEFAULTS = {
  maxSizePctOfCash: 35,
  dailyLossCapPct: 3,
  /** Added when a plan has no loss limit (HANDOFF 5.1). */
  defaultStopLossPct: 5,
  /** Used when the sentence gives no size. */
  defaultSizePct: 25,
} as const;

/** Bounds a wallet may set for its own limits (settings page). */
export const RISK_LIMITS = {
  maxSizePct: { min: 1, max: 100 },
  dailyLossCapPct: { min: 0.5, max: 20 },
} as const;

export const LEADERBOARD = {
  /** Agents appear in the ranking only after this many days live. */
  minDaysToRank: 7,
} as const;

export const BACKTEST = {
  /** Length of the scored window, in days of hourly candles. */
  days: 90,
  /** Fraction of the window the tuner may see; the rest is scored unseen. */
  tuneFraction: 2 / 3,
} as const;

/**
 * The example strategies offered in Agent Studio. Each is a complete strategy: a buy rule, a way out with a loss
 * limit, a reason to stand aside and a size, so every row of the plan check passes. Each is read exactly as
 * written by the built-in reader (a test pins the reading), and uses only signals that are always available:
 * none depends on the funding feed. They are starting points to edit, not recommendations to trade.
 */
export const STUDIO_EXAMPLES: readonly { label: string; sentence: string }[] = [
  {
    label: "Trend dip on ETH",
    sentence: "Buy ETH on a 3% dip under its 20-hour average while the long trend is rising, stay out when the market is stressed, take profit at 6%, stop at 4%, use 20% per trade",
  },
  {
    label: "RSI rebound on BTC",
    sentence: "Buy BTC when RSI crosses back above 30, sell when RSI goes above 70, stay out when the market is stressed, stop at 5%, use 25% per trade",
  },
  {
    label: "Drop rebound on ETH",
    sentence:
      "Buy ETH when price falls more than 5% in the last 24 hours and RSI is below 35, sell when price crosses back above its 20-hour average, stay out when the market is stressed, stop at 5%, use 20% per trade",
  },
  {
    label: "Momentum on ETH",
    sentence: "Buy ETH when price rises more than 3% in the last 24 hours and volume is above 1.5x its average, stay out when the market is stressed, trailing stop 4%, use 20% per trade",
  },
  {
    label: "Uptrend pullback on BTC",
    sentence: "Buy BTC when the long trend is rising and RSI is below 45, stay out when the market is stressed, take profit at 5%, trailing stop 3%, use 20% per trade",
  },
  {
    label: "Weekly ETH buyer",
    sentence: "Buy ETH with 10% of cash every week, stay out when the market is stressed, stop at 15%",
  },
];

/**
 * The strategy shown in the landing page's product preview. The plan is our own
 * translation of the sentence, written by hand; its backtest runs on real
 * candles in the engine and is stored like any other backtest.
 */
export const EXAMPLE_STRATEGY: { sentence: string; plan: Plan } = {
  sentence:
    "Buy ETH when RSI drops below 30 in an uptrend, skip if there is bad news, take profit at 8% and stop at 4%",
  plan: {
    markets: ["ETH"],
    kind: "entry_exit",
    entry: [
      { signal: "rsi", op: "<", value: 30 },
      { signal: "trend_pct", op: ">", value: 0 },
    ],
    exit: { takeProfitPct: 8, stopLossPct: 4 },
    filters: ["negative_news"],
    sizePctOfCash: 25,
  },
};

/** BullMQ queue shared by the API (producer) and the engine (worker). */
export const ENGINE_QUEUE = "rationale-engine";
