/**
 * Loads hourly candles for a market: Binance first, Hyperliquid if Binance
 * fails or its candles stop short of the hour asked for, and the Postgres cache
 * if both fail. A series is always one feed's own: candles of two feeds are
 * never joined, and the label names the feed they came from. Closed candles are
 * saved so any decision or backtest can be reproduced from stored data.
 * Responses are cached briefly in Redis so many agents on one market share one
 * request per hour.
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

/** An answer that is behind stays in Redis only this long, so a retry a few seconds later asks the feed again. */
export const BEHIND_CACHE_SECONDS = 10;

export interface FeedLag {
  /** Closed hours missing at the end of the answer. 0 when its newest closed candle is the last closed hour asked for. */
  hours: number;
  /** The range reaches into the hour in progress and the answer has no candle for it, so no opening price. */
  noOpen: boolean;
  /** Open time of the newest closed candle in the answer, if it has one. */
  newest: number | null;
}

/**
 * How far an answer for [from, to) stops short of what a healthy feed has at `now`.
 *
 * A decision for hour H reads the candle that closed at H and fills at the open of the hour that starts at H. A feed
 * that answers without them is no better than one that does not answer: the agent waits for fresh data, and acts on
 * no stop, for as long as that feed is the one listened to.
 */
export function feedLag(candles: Candle[], from: number, to: number, now: number): FeedLag {
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  // The newest candle of the range that has closed by now.
  const wanted = Math.min(to, thisHour) - HOUR_MS;
  let newest: number | null = null;
  for (let i = candles.length - 1; i >= 0 && newest == null; i--) if (candles[i]!.t <= wanted) newest = candles[i]!.t;
  const hours = wanted < from ? 0 : Math.ceil((wanted - (newest ?? from - HOUR_MS)) / HOUR_MS);
  const noOpen = thisHour >= from && thisHour < to && !candles.some((c) => c.t === thisHour);
  return { hours, noOpen, newest };
}

/** Nothing a decision needs is missing. */
export const isCurrent = (lag: FeedLag): boolean => lag.hours === 0 && !lag.noOpen;

/** Fewer closed hours missing; between two that miss the same, the one that has the hour's opening price. */
const fresher = (a: FeedLag, b: FeedLag): boolean => a.hours < b.hours || (a.hours === b.hours && !a.noOpen && b.noOpen);

const lagFields = (lag: FeedLag) => ({
  hoursBehind: lag.hours,
  newestCandle: lag.newest == null ? null : new Date(lag.newest).toISOString(),
  // Only worth saying when it is the one thing missing.
  ...(lag.hours === 0 && lag.noOpen ? { noOpeningPrice: true } : {}),
});

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

/**
 * Candles with open time in [from, to).
 *
 * Feeds are asked in order, and the first whose answer is current is used. One that answers with candles that stop
 * short (see `feedLag`) is passed over for the next. When none is current, the answer that is least behind is used,
 * the earlier feed on a tie, so a caller always gets the best single series there is.
 */
export async function loadCandles(market: string, from: number, to: number, deps: CandleDeps = {}): Promise<CandleSet> {
  const feeds = deps.feeds ?? DEFAULT_FEEDS;
  const now = (deps.now ?? Date.now)();
  const ttl = deps.cacheSeconds ?? 120;
  const errors: string[] = [];
  let best: { source: string; sourceLabel: string; candles: Candle[]; lag: FeedLag } | null = null;

  for (const feed of feeds) {
    const key = `candles:${feed.name}:${market}:${from}:${to}`;
    try {
      let candles: Candle[] | null = null;
      if (deps.redis) {
        const hit = await deps.redis.get(key);
        if (hit) candles = JSON.parse(hit) as Candle[];
      }
      const cached = candles != null;
      if (!candles) {
        candles = cleanCandles(await feed.fetch(market, from, to));
        if (!candles.length) throw new Error("no candles returned");
      }
      const lag = feedLag(candles, from, to, now);
      if (!cached) {
        if (deps.redis) await deps.redis.set(key, JSON.stringify(candles), "EX", isCurrent(lag) ? ttl : Math.min(ttl, BEHIND_CACHE_SECONDS));
        if (deps.prisma) await persist(deps.prisma, market, feed.name, candles, now);
      }
      const sourceLabel = `${feed.name}:${feed.symbol(market)}`;
      if (!best || fresher(lag, best.lag)) best = { source: feed.name, sourceLabel, candles, lag };
      if (isCurrent(lag)) break;
      log("warn", "candle feed is behind", { market, feed: feed.name, ...lagFields(lag) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.name}: ${message}`);
      log("warn", "candle feed failed", { market, feed: feed.name, error: message });
    }
  }

  if (best) {
    if (!isCurrent(best.lag)) log("warn", "no candle feed is current; using the least behind", { market, feed: best.source, ...lagFields(best.lag) });
    const gaps = countGaps(best.candles);
    if (gaps) log("warn", "candle gaps", { market, feed: best.source, gaps });
    return { source: best.source, sourceLabel: best.sourceLabel, candles: best.candles, fromCache: false };
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
