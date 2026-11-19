/**
 * Hyperliquid info API (no key), used when Binance fails. Prices are perpetual
 * futures marks, close to but not identical to spot. Returns at most the 5000
 * most recent candles.
 */
import type { Candle } from "@rationale/brain";
import { MARKETS, isMarketId } from "@rationale/config";
import { FeedError, type CandleFeed } from "./types";

const URL = process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";

export const hyperliquid: CandleFeed = {
  name: "hyperliquid",
  symbol(market) {
    if (!isMarketId(market)) throw new FeedError("hyperliquid", `unknown market ${market}`);
    return MARKETS[market].hyperliquidCoin;
  },
  async fetch(market, from, to) {
    const coin = this.symbol(market);
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: from, endTime: to - 1 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new FeedError("hyperliquid", `HTTP ${res.status} for ${coin}`);
    const rows = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
    if (!Array.isArray(rows)) throw new FeedError("hyperliquid", "unexpected response");
    return rows
      .map((k) => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v) }))
      .filter((c) => c.t >= from && c.t < to);
  },
};
