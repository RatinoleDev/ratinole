/**
 * Loads hourly candles for a market: Binance first, Hyperliquid if Binance
 * fails, and the Postgres cache if both fail. Closed candles are saved so any
 * decision or backtest can be reproduced from stored data. Responses are cached
 * briefly in Redis so many agents on one market share one request per hour.
 */
import { HOUR_MS, type Candle } from "@rationale/brain";
import type { PrismaClient } from "@rationale/db";
import type { Redis } from "ioredis";
import { log } from "../log";
import { binance } from "./binance";
import { hyperliquid } from "./hyperliquid";
import type { CandleFeed } from "./types";

export interface CandleSet {
  /** Feed name, e.g. "binance". */
  source: string;
  /** Feed and symbol, e.g. "binance:ETHUSDT". Stored with every decision. */
  sourceLabel: string;
  /** Oldest first, deduplicated; may end with the forming candle. */
  candles: Candle[];
  /** True when served from the Postgres cache because every feed failed. */
  fromCache: boolean;
}

export interface CandleDeps {
  prisma?: PrismaClient;
  redis?: Redis;
  feeds?: CandleFeed[];
  now?: () => number;
  /** Redis cache lifetime, seconds. */
  cacheSeconds?: number;
}

export const DEFAULT_FEEDS: CandleFeed[] = [binance, hyperliquid];

/** Sort, drop duplicates and malformed rows. */
export function cleanCandles(rows: Candle[]): Candle[] {
  const ok = rows.filter(
    (c) =>
      Number.isFinite(c.t) &&
      c.t % HOUR_MS === 0 &&
      [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0) &&
      Number.isFinite(c.v) &&
      c.v >= 0,
  );
  ok.sort((a, b) => a.t - b.t);
  const out: Candle[] = [];
  for (const c of ok) if (!out.length || out[out.length - 1]!.t !== c.t) out.push(c);
  return out;
}

export function countGaps(candles: Candle[]): number {
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i]!.t - candles[i - 1]!.t !== HOUR_MS) gaps++;
  return gaps;
}

async function persist(prisma: PrismaClient, market: string, source: string, candles: Candle[], now: number): Promise<void> {
  const closed = candles.filter((c) => c.t + HOUR_MS <= now);
  if (!closed.length) return;
  await prisma.candle.createMany({
    data: closed.map((c) => ({
      market,
      source,
      openTime: new Date(c.t),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    })),
    skipDuplicates: true,
  });
}

async function fromDb(prisma: PrismaClient, market: string, from: number, to: number, sources: string[]): Promise<{ source: string; candles: Candle[] } | null> {
  for (const source of sources) {
    const rows = await prisma.candle.findMany({
      where: { market, source, openTime: { gte: new Date(from), lt: new Date(to) } },
      orderBy: { openTime: "asc" },
    });
    if (rows.length) {
      return {
        source,
        candles: rows.map((r) => ({ t: r.openTime.getTime(), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume })),
      };
    }
  }
  return null;
}

/** Candles with open time in [from, to). */
export async function loadCandles(market: string, from: number, to: number, deps: CandleDeps = {}): Promise<CandleSet> {
  const feeds = deps.feeds ?? DEFAULT_FEEDS;
  const now = (deps.now ?? Date.now)();
  const errors: string[] = [];

  for (const feed of feeds) {
    const key = `candles:${feed.name}:${market}:${from}:${to}`;
    try {
      let candles: Candle[] | null = null;
      if (deps.redis) {
        const hit = await deps.redis.get(key);
        if (hit) candles = JSON.parse(hit) as Candle[];
      }
      if (!candles) {
        candles = cleanCandles(await feed.fetch(market, from, to));
        if (!candles.length) throw new Error("no candles returned");
        if (deps.redis) await deps.redis.set(key, JSON.stringify(candles), "EX", deps.cacheSeconds ?? 120);
        if (deps.prisma) await persist(deps.prisma, market, feed.name, candles, now);
      }
      const gaps = countGaps(candles);
      if (gaps) log("warn", "candle gaps", { market, feed: feed.name, gaps });
      return { source: feed.name, sourceLabel: `${feed.name}:${feed.symbol(market)}`, candles, fromCache: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.name}: ${message}`);
      log("warn", "candle feed failed", { market, feed: feed.name, error: message });
    }
  }

  if (deps.prisma) {
    const cached = await fromDb(deps.prisma, market, from, to, feeds.map((f) => f.name));
    if (cached) {
      const feed = feeds.find((f) => f.name === cached.source)!;
      log("warn", "serving candles from database cache", { market, source: cached.source });
      return { source: cached.source, sourceLabel: `${cached.source}:${feed.symbol(market)}`, candles: cached.candles, fromCache: true };
    }
  }
  throw new Error(`No candles for ${market}: ${errors.join("; ")}`);
}
