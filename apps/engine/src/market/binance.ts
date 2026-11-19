/**
 * Binance public market data (no key). Uses data-api.binance.vision, the
 * market-data-only host; api.binance.com refuses some regions. Limits:
 * 1000 candles per request, weight-based rate limits (klines weight 2).
 */
import { HOUR_MS, type Candle } from "@rationale/brain";
import { MARKETS, isMarketId } from "@rationale/config";
import { FeedError, type CandleFeed } from "./types";

const BASE = process.env.BINANCE_DATA_URL ?? "https://data-api.binance.vision";

export const binance: CandleFeed = {
  name: "binance",
  symbol(market) {
    if (!isMarketId(market)) throw new FeedError("binance", `unknown market ${market}`);
    return MARKETS[market].binanceSymbol;
  },
  async fetch(market, from, to) {
    const symbol = this.symbol(market);
    const out: Candle[] = [];
    let start = from;
    for (let page = 0; page < 20 && start < to; page++) {
      const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${start}&endTime=${to - 1}&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new FeedError("binance", `HTTP ${res.status} for ${symbol}`);
      const rows = (await res.json()) as unknown[][];
      if (!Array.isArray(rows)) throw new FeedError("binance", "unexpected response");
      for (const k of rows) {
        out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
      }
      if (rows.length < 1000) break;
      start = Number(rows[rows.length - 1]![0]) + HOUR_MS;
    }
    return out;
  },
};
