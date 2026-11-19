/**
 * The market as the engine reads it each hour (ETH, BTC): price, 24-hour
 * change, regime, RSI, funding and volatility, plus a week of closes for a
 * chart. Stored per hour so the landing page only shows recorded readings.
 */
import { HOUR_MS, SeriesSource, classifyRegime } from "@rationale/brain";
import { MARKET_IDS } from "@rationale/config";
import type { Prisma } from "@rationale/db";
import { log } from "../log";
import type { EngineDeps } from "../runAgent";
import { loadCandles } from "./candles";
import { attachFunding, loadFunding } from "./funding";

const LOOKBACK_HOURS = 800;

export async function snapshotMarkets(deps: EngineDeps): Promise<number> {
  const { prisma } = deps;
  const now = (deps.now ?? Date.now)();
  const end = Math.floor(now / HOUR_MS) * HOUR_MS;
  let stored = 0;
  for (const market of MARKET_IDS) {
    try {
      const set = await loadCandles(market, end - LOOKBACK_HOURS * HOUR_MS, end, deps);
      const funding = deps.funding
        ? await loadFunding(deps.funding, market, end - LOOKBACK_HOURS * HOUR_MS, end + HOUR_MS, deps)
        : new Map<number, number>();
      const candles = attachFunding(set.candles, funding).filter((c) => c.t + HOUR_MS <= now);
      const src = new SeriesSource(candles);
      const i = candles.length - 1;
      const reading = i >= 24 ? classifyRegime(src, i) : null;
      if (!reading) throw new Error("not enough candles for a reading");
      const last = candles[i]!;
      const hour = new Date(last.t + HOUR_MS);
      const fr = src.signal("funding_rate", 8)[i] ?? null;
      const data = {
        price: last.c,
        change24Pct: (last.c / candles[i - 24]!.c - 1) * 100,
        regime: reading.regime,
        direction: reading.direction,
        reason: reading.reason,
        rsi: src.signal("rsi", 14)[i] ?? null,
        funding8hPct: fr,
        dailyVolPct: reading.dailyVolPct,
        closes7d: candles.slice(-168).map((c) => c.c) as unknown as Prisma.InputJsonValue,
        candleSource: set.sourceLabel,
        fundingSource: fr != null && deps.funding ? deps.funding.label : null,
      };
      await prisma.marketSnapshot.upsert({
        where: { market_hour: { market, hour } },
        create: { market, hour, ...data },
        update: data,
      });
      stored++;
    } catch (err) {
      log("warn", "market snapshot failed", { market, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return stored;
}
