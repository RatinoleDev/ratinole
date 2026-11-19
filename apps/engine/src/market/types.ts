import type { Candle } from "@rationale/brain";

export interface CandleFeed {
  /** e.g. "binance" */
  name: string;
  /** The feed's symbol for a market, e.g. "ETHUSDT". */
  symbol(market: string): string;
  /**
   * Hourly candles with open time in [from, to), oldest first. May include the
   * candle that is still forming (open time = current hour).
   */
  fetch(market: string, from: number, to: number): Promise<Candle[]>;
}

export class FeedError extends Error {
  constructor(
    readonly feed: string,
    message: string,
  ) {
    super(`${feed}: ${message}`);
  }
}
