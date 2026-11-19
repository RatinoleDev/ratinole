/**
 * House agents: a few paper agents run by the Ratinole team so visitors can see
 * real hourly decisions. They are flagged `house` and labelled everywhere.
 * Plans are written by hand (no LLM needed), backtested like any other, then
 * launched. Safe to run again: existing house agents are left alone.
 */
import { HOUR_MS, checkPlan, type Plan } from "@rationale/brain";
import { MARKET_IDS, PAPER, RISK_DEFAULTS } from "@rationale/config";
import type { Prisma } from "@rationale/db";
import { log } from "./log";
import type { EngineDeps } from "./runAgent";
import { runBacktest } from "./runBacktest";

export const HOUSE_ADDRESS = "house";

export const HOUSE_AGENTS: { name: string; sentence: string; plan: Plan }[] = [
  {
    name: "House ETH Dip",
    sentence: "Buy ETH on a 3% dip under its 20-hour average while the long trend is rising, take profit at 6%, stop at 4%, use 20% per trade",
    plan: {
      markets: ["ETH"],
      kind: "entry_exit",
      entry: [
        { signal: "price_vs_sma_pct", op: "<", value: -3, window: 20 },
        { signal: "trend_pct", op: ">", value: 0 },
      ],
      exit: { takeProfitPct: 6, stopLossPct: 4 },
      filters: [],
      sizePctOfCash: 20,
    },
  },
  {
    name: "House BTC Funding",
    sentence: "Buy BTC when funding is negative, stand aside if the market is stressed, take profit at 4%, stop at 3%, use 20% per trade",
    plan: {
      markets: ["BTC"],
      kind: "entry_exit",
      entry: [{ signal: "funding_rate", op: "<", value: 0 }],
      exit: { takeProfitPct: 4, stopLossPct: 3 },
      filters: ["stressed_regime"],
      sizePctOfCash: 20,
    },
  },
  {
    name: "House ETH Weekly",
    sentence: "Buy ETH with 10% of cash every week, stop at 15%",
    plan: {
      markets: ["ETH"],
      kind: "dca",
      entry: [],
      exit: { stopLossPct: 15 },
      filters: [],
      sizePctOfCash: 10,
      cadenceHours: 168,
    },
  },
];

export async function seedHouseAgents(deps: EngineDeps): Promise<{ name: string; result: string }[]> {
  const { prisma } = deps;
  const now = (deps.now ?? Date.now)();
  const user = await prisma.user.upsert({ where: { address: HOUSE_ADDRESS }, create: { address: HOUSE_ADDRESS }, update: {} });
  const out: { name: string; result: string }[] = [];
  for (const h of HOUSE_AGENTS) {
    const existing = await prisma.agent.findFirst({ where: { userId: user.id, name: h.name, status: { not: "archived" } } });
    if (existing) {
      out.push({ name: h.name, result: "already running" });
      continue;
    }
    const checked = checkPlan(h.plan, {
      supportedMarkets: MARKET_IDS,
      maxSizePct: RISK_DEFAULTS.maxSizePctOfCash,
      defaultSizePct: RISK_DEFAULTS.defaultSizePct,
      defaultStopLossPct: RISK_DEFAULTS.defaultStopLossPct,
    });
    if (!checked.ok) throw new Error(`House plan "${h.name}" is invalid: ${checked.message}`);
    const bt = await prisma.backtest.create({
      data: {
        userId: user.id,
        sentence: h.sentence,
        plan: checked.plan as unknown as Prisma.InputJsonValue,
        market: checked.plan.markets[0]!,
        maxSizePct: RISK_DEFAULTS.maxSizePctOfCash,
        dailyLossCapPct: RISK_DEFAULTS.dailyLossCapPct,
        costPct: PAPER.costPct,
        startCash: PAPER.startingCash,
      },
    });
    const res = await runBacktest(bt.id, deps);
    const done = await prisma.backtest.findUniqueOrThrow({ where: { id: bt.id } });
    if (res.status !== "done" || !done.params) {
      out.push({ name: h.name, result: `backtest ${res.status}` });
      continue;
    }
    await prisma.agent.create({
      data: {
        userId: user.id,
        name: h.name,
        house: true,
        sentence: h.sentence,
        plan: checked.plan as unknown as Prisma.InputJsonValue,
        params: done.params as Prisma.InputJsonValue,
        market: done.market,
        startingCash: PAPER.startingCash,
        maxSizePct: RISK_DEFAULTS.maxSizePctOfCash,
        dailyLossCapPct: RISK_DEFAULTS.dailyLossCapPct,
        backtestId: bt.id,
        owedFrom: new Date(Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS),
      },
    });
    log("info", "house agent launched", { name: h.name });
    out.push({ name: h.name, result: "launched" });
  }
  return out;
}
