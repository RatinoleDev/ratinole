/**
 * Hourly funding rates from Hyperliquid's public info API (no key), saved to
 * Postgres and cached briefly in Redis. Funding is optional evidence: if it
 * cannot be fetched, agents carry on with price signals and any plan rule that
 * needs funding simply does not hold.
 */
import { HOUR_MS, type Candle } from "@rationale/brain";
import { MARKETS, isMarketId } from "@rationale/config";
import type { PrismaClient } from "@rationale/db";
import type { Redis } from "ioredis";
import { log } from "../log";

const URL = process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";

/** Rates keyed by settlement hour (ms), fraction per hour. */
export type FundingMap = Map<number, number>;

export interface FundingFeed {
  name: string;
  /** Display name stored next to the evidence, e.g. "Hyperliquid". */
  label: string;
  fetch(market: string, from: number, to: number): Promise<FundingMap>;
}

export const hyperliquidFunding: FundingFeed = {
  name: "hyperliquid",
  label: "Hyperliquid",
  async fetch(market, from, to) {
    if (!isMarketId(market)) throw new Error(`unknown market ${market}`);
    const coin = MARKETS[market].hyperliquidCoin;
    const out: FundingMap = new Map();
    let start = from;
    for (let page = 0; page < 40 && start < to; page++) {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fundingHistory", coin, startTime: start, endTime: to - 1 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${coin} funding`);
      const rows = (await res.json()) as { fundingRate: string; time: number }[];
      if (!Array.isArray(rows)) throw new Error("unexpected funding response");
      for (const r of rows) {
        const rate = Number(r.fundingRate);
        if (Number.isFinite(rate)) out.set(Math.floor(r.time / HOUR_MS) * HOUR_MS, rate);
      }
      if (rows.length < 500) break;
      start = rows[rows.length - 1]!.time + 1;
    }
    return out;
  },
};

export interface FundingDeps {
  prisma?: PrismaClient;
  redis?: Redis;
}

/** Funding settled in [from, to). Never throws; returns an empty map when unavailable. */
export async function loadFunding(feed: FundingFeed, market: string, from: number, to: number, deps: FundingDeps = {}): Promise<FundingMap> {
  const key = `funding:${feed.name}:${market}:${from}:${to}`;
  try {
    if (deps.redis) {
      const hit = await deps.redis.get(key);
      if (hit) return new Map(JSON.parse(hit) as [number, number][]);
    }
    const map = await feed.fetch(market, from, to);
    if (deps.redis) await deps.redis.set(key, JSON.stringify([...map]), "EX", 120);
    if (deps.prisma && map.size) {
      await deps.prisma.fundingRate.createMany({
        data: [...map].map(([hour, rate]) => ({ market, source: feed.name, hour: new Date(hour), rate })),
        skipDuplicates: true,
      });
    }
    return map;
  } catch (err) {
    log("warn", "funding feed failed", { market, feed: feed.name, error: err instanceof Error ? err.message : String(err) });
    if (!deps.prisma) return new Map();
    const rows = await deps.prisma.fundingRate.findMany({
      where: { market, source: feed.name, hour: { gte: new Date(from), lt: new Date(to) } },
    });
    return new Map(rows.map((r) => [r.hour.getTime(), r.rate]));
  }
}

/** Attach to each candle the funding settled at its close (t + 1 hour). */
export function attachFunding(candles: Candle[], funding: FundingMap): Candle[] {
  if (!funding.size) return candles;
  return candles.map((c) => {
    const f = funding.get(c.t + HOUR_MS);
    return f == null ? c : { ...c, f };
  });
}
