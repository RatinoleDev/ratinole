/**
 * Runs a stored Backtest on real hourly candles and saves the result. The
 * example strategy shown on the landing page is a Backtest of kind "example",
 * refreshed daily.
 */
import { HOUR_MS, paramsText, requiredWarmup, walkForward, type Plan } from "@rationale/brain";
import { BACKTEST, EXAMPLE_STRATEGY, PAPER, RISK_DEFAULTS } from "@rationale/config";
import type { Prisma } from "@rationale/db";
import { log } from "./log";
import { loadCandles } from "./market/candles";
import { hourFloor, type EngineDeps } from "./runAgent";

export async function runBacktest(backtestId: string, deps: EngineDeps): Promise<{ status: string }> {
  const { prisma } = deps;
  const bt = await prisma.backtest.findUnique({ where: { id: backtestId } });
  if (!bt) return { status: "missing" };
  if (bt.status === "done") return { status: "done" };
  await prisma.backtest.update({ where: { id: bt.id }, data: { status: "running" } });

  try {
    const plan = bt.plan as unknown as Plan;
    const now = (deps.now ?? Date.now)();
    const endHour = hourFloor(now); // candles with open time < endHour are closed
    const warmup = requiredWarmup(plan);
    const days = BACKTEST.days;
    const want = warmup + days * 24 + 2;
    const set = await loadCandles(bt.market, endHour - want * HOUR_MS, endHour, deps);
    const candles = set.candles.filter((c) => c.t + HOUR_MS <= now);
    const evalStart = Math.max(warmup, candles.length - 1 - days * 24);
    const res = walkForward({
      plan,
      candles,
      evalStart,
      tuneFraction: BACKTEST.tuneFraction,
      startCash: bt.startCash,
      costPct: bt.costPct,
      limits: { maxSizePct: bt.maxSizePct, dailyLossCapPct: bt.dailyLossCapPct },
    });

    await prisma.backtest.update({
      where: { id: bt.id },
      data: {
        status: "done",
        source: `${set.source === "binance" ? "Binance" : "Hyperliquid"} ${set.sourceLabel.split(":")[1]} hourly${set.fromCache ? " (cached)" : ""}`,
        params: res.params as unknown as Prisma.InputJsonValue,
        fromTime: new Date(res.tune.from),
        splitTime: new Date(res.splitHour),
        toTime: new Date(res.unseen.to),
        candles: candles.length,
        tunedReturnPct: res.tune.returnPct,
        unseenReturnPct: res.unseen.returnPct,
        holdingTunedPct: res.tune.holdingPct,
        holdingUnseenPct: res.unseen.holdingPct,
        maxDrawdownPct: res.unseen.maxDrawdownPct,
        tunedTrades: res.tune.trades,
        unseenTrades: res.unseen.trades,
        curve: res.curve.map((p) => ({ t: new Date(p.t).toISOString(), strategy: round(p.strategy), holding: round(p.holding) })),
        detail: {
          gridSize: res.gridSize,
          evalStart,
          tune: res.tune,
          unseen: res.unseen,
          folds: res.folds,
          paramsText: paramsText(plan, res.params),
          candleSource: set.sourceLabel,
          firstCandle: new Date(candles[0]!.t).toISOString(),
          lastCandle: new Date(candles[candles.length - 1]!.t).toISOString(),
        } as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    log("info", "backtest done", { backtestId, unseen: res.unseen.returnPct, trades: res.unseen.trades });
    return { status: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "backtest failed", { backtestId, error: message });
    await prisma.backtest.update({ where: { id: bt.id }, data: { status: "failed", error: "The backtest could not run: price data was unavailable. Try again in a few minutes." } });
    return { status: "failed" };
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Make sure a fresh example backtest exists (at most one per day). */
export async function ensureExample(deps: EngineDeps): Promise<{ status: string; id?: string }> {
  const { prisma } = deps;
  const since = new Date((deps.now ?? Date.now)() - 24 * HOUR_MS);
  const recent = await prisma.backtest.findFirst({
    where: { kind: "example", status: { in: ["done", "running", "queued"] }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });
  if (recent?.status === "done") return { status: "fresh", id: recent.id };
  const bt =
    recent ??
    (await prisma.backtest.create({
      data: {
        kind: "example",
        sentence: EXAMPLE_STRATEGY.sentence,
        plan: EXAMPLE_STRATEGY.plan as unknown as Prisma.InputJsonValue,
        market: EXAMPLE_STRATEGY.plan.markets[0]!,
        maxSizePct: RISK_DEFAULTS.maxSizePctOfCash,
        dailyLossCapPct: RISK_DEFAULTS.dailyLossCapPct,
        costPct: PAPER.costPct,
        startCash: PAPER.startingCash,
      },
    }));
  const out = await runBacktest(bt.id, deps);
  return { status: out.status, id: bt.id };
}
