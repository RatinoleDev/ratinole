import { HOUR_MS, type Plan } from "@rationale/brain";
import { prisma, type Prisma } from "@rationale/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FreshDataPendingError, runAgentHours } from "../src/runAgent";
import { ensureExample, runBacktest } from "../src/runBacktest";
import { tick } from "../src/tick";
import { fakeFeed, synthCandles } from "./fakes";

const hasDb = !!process.env.DATABASE_URL;
const H0 = Date.UTC(2026, 10, 10, 12);

const plan: Plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [{ signal: "rsi", op: "<", value: 45 }],
  exit: { takeProfitPct: 2, stopLossPct: 2 },
  filters: [],
  sizePctOfCash: 25,
};

async function wipe() {
  await prisma.decision.deleteMany();
  await prisma.agentState.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.backtest.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.engineRun.deleteMany();
  await prisma.candle.deleteMany();
}

async function makeAgent(over: Partial<Prisma.AgentUncheckedCreateInput> = {}) {
  const user = await prisma.user.create({ data: { address: `0x${Math.random().toString(16).slice(2).padEnd(40, "0")}` } });
  return prisma.agent.create({
    data: {
      userId: user.id,
      name: "Meridian",
      sentence: "test",
      plan: plan as unknown as Prisma.InputJsonValue,
      params: { confidenceThreshold: 0, windows: {} },
      market: "ETH",
      startingCash: 10_000,
      maxSizePct: 35,
      dailyLossCapPct: 3,
      owedFrom: new Date(H0),
      ...over,
    },
  });
}

const series = synthCandles(H0 - 1500 * HOUR_MS, H0 + 10 * HOUR_MS, 3);
const feeds = [fakeFeed("binance", series)];

describe.skipIf(!hasDb)("runAgentHours", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("stores one decision per owed hour, in order, and marks catch-up hours late", async () => {
    const agent = await makeAgent();
    const now = H0 + 3 * HOUR_MS + 2 * 60_000;
    const res = await runAgentHours(agent.id, H0 + 3 * HOUR_MS, { prisma, feeds, now: () => now });
    expect(res).toMatchObject({ decided: 4, late: 3, skipped: false });

    const ds = await prisma.decision.findMany({ where: { agentId: agent.id }, orderBy: { hour: "asc" } });
    expect(ds.map((d) => d.hour.getTime())).toEqual([0, 1, 2, 3].map((k) => H0 + k * HOUR_MS));
    expect(ds.map((d) => d.late)).toEqual([true, true, true, false]);
    for (const d of ds) {
      expect(["buy", "sell", "hold"]).toContain(d.action);
      expect(d.candleSource).toBe("binance:ETHUSDT");
      expect(d.candleTime.getTime()).toBe(d.hour.getTime() - HOUR_MS);
      expect((d.evidence as unknown[]).length).toBeGreaterThan(0);
      expect(d.explanation.length).toBeGreaterThan(10);
      expect(Number.isFinite(d.equityAfter) && Number.isFinite(d.holdingEquityAfter)).toBe(true);
    }
    const state = await prisma.agentState.findUnique({ where: { agentId: agent.id } });
    expect(state!.cash).toBeCloseTo(ds[3]!.cashAfter, 6);
    const fresh = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(fresh!.holdEntryPrice).toBeCloseTo(series.find((c) => c.t === H0)!.o, 6);
    // Warmup plus owed hours were fetched; only closed candles are saved (the forming one is not).
    expect(await prisma.candle.count()).toBe(748);
    expect(await prisma.candle.count({ where: { openTime: { gte: new Date(H0 + 3 * HOUR_MS) } } })).toBe(0);
  });

  it("is idempotent and safe to run twice at once", async () => {
    const agent = await makeAgent();
    const now = () => H0 + 5 * HOUR_MS + 60_000;
    await Promise.all([
      runAgentHours(agent.id, H0 + 5 * HOUR_MS, { prisma, feeds, now }),
      runAgentHours(agent.id, H0 + 5 * HOUR_MS, { prisma, feeds, now }),
    ]);
    expect(await prisma.decision.count({ where: { agentId: agent.id } })).toBe(6);
    const again = await runAgentHours(agent.id, H0 + 5 * HOUR_MS, { prisma, feeds, now });
    expect(again).toMatchObject({ decided: 0, skipped: true, reason: "up to date" });
  });

  it("skips paused agents and never backfills hours from before owedFrom", async () => {
    const paused = await makeAgent({ status: "paused" });
    expect(await runAgentHours(paused.id, H0 + 2 * HOUR_MS, { prisma, feeds, now: () => H0 + 2 * HOUR_MS })).toMatchObject({ skipped: true, reason: "paused" });
    const resumed = await makeAgent({ owedFrom: new Date(H0 + 2 * HOUR_MS) });
    await runAgentHours(resumed.id, H0 + 3 * HOUR_MS, { prisma, feeds, now: () => H0 + 3 * HOUR_MS + 60_000 });
    const hours = (await prisma.decision.findMany({ where: { agentId: resumed.id } })).map((d) => d.hour.getTime()).sort();
    expect(hours).toEqual([H0 + 2 * HOUR_MS, H0 + 3 * HOUR_MS]);
  });

  it("waits (retries) for the newest candle on time, but records a stale hold when catching up", async () => {
    const agent = await makeAgent();
    const short = [fakeFeed("binance", series.filter((c) => c.t < H0))]; // no candle for the hour starting at H0
    await expect(runAgentHours(agent.id, H0, { prisma, feeds: short, now: () => H0 + 60_000 })).rejects.toBeInstanceOf(FreshDataPendingError);
    expect(await prisma.decision.count()).toBe(0);
    await runAgentHours(agent.id, H0, { prisma, feeds: short, now: () => H0 + 40 * 60_000 });
    const d = await prisma.decision.findFirstOrThrow({ where: { agentId: agent.id } });
    expect(d.action).toBe("hold");
    expect((d.guard as { check: string; pass: boolean }[])[0]).toMatchObject({ check: "Fresh data", pass: false });
  });
});

describe.skipIf(!hasDb)("tick", () => {
  beforeEach(wipe);
  it("runs every active owed agent and records the run", async () => {
    await makeAgent();
    await makeAgent({ status: "paused" });
    await makeAgent({ owedFrom: new Date(H0 + 50 * HOUR_MS) });
    const now = () => H0 + 60_000;
    const res = await tick({ prisma, feeds, now });
    expect(res.agents).toBe(1);
    const run = await prisma.engineRun.findFirstOrThrow({ where: { hour: new Date(H0) } });
    expect(run).toMatchObject({ agents: 1, decisions: 1, late: 0 });
  });
});

describe.skipIf(!hasDb)("runBacktest", () => {
  beforeEach(wipe);
  const now = Date.UTC(2026, 10, 18, 0, 30);
  const long = synthCandles(Date.UTC(2026, 6, 1), Date.UTC(2026, 10, 18, 1), 9);

  it("runs a stored backtest on candles and saves results the UI can show", async () => {
    const bt = await prisma.backtest.create({
      data: { sentence: "s", plan: plan as unknown as Prisma.InputJsonValue, market: "ETH", maxSizePct: 35, dailyLossCapPct: 3, costPct: 0.1, startCash: 10_000 },
    });
    const out = await runBacktest(bt.id, { prisma, feeds: [fakeFeed("binance", long)], now: () => now });
    expect(out.status).toBe("done");
    const r = await prisma.backtest.findUniqueOrThrow({ where: { id: bt.id } });
    expect(r.status).toBe("done");
    expect(r.source).toBe("Binance ETHUSDT hourly");
    for (const v of [r.tunedReturnPct, r.unseenReturnPct, r.holdingUnseenPct, r.maxDrawdownPct]) expect(Number.isFinite(v)).toBe(true);
    expect((r.toTime!.getTime() - r.splitTime!.getTime()) / HOUR_MS).toBe(719);
    expect((r.curve as unknown[]).length).toBeLessThanOrEqual(361);
    expect(r.params).toBeTruthy();
  });

  it("marks the backtest failed with a plain message when there is no data", async () => {
    const bt = await prisma.backtest.create({
      data: { sentence: "s", plan: plan as unknown as Prisma.InputJsonValue, market: "ETH", maxSizePct: 35, dailyLossCapPct: 3, costPct: 0.1, startCash: 10_000 },
    });
    const dead = fakeFeed("binance", () => {
      throw new Error("down");
    });
    expect((await runBacktest(bt.id, { prisma, feeds: [dead], now: () => now })).status).toBe("failed");
    expect((await prisma.backtest.findUniqueOrThrow({ where: { id: bt.id } })).error).toMatch(/price data was unavailable/);
  });

  it("keeps one example backtest per day", async () => {
    const deps = { prisma, feeds: [fakeFeed("binance", long)], now: () => now };
    const first = await ensureExample(deps);
    expect(first.status).toBe("done");
    expect((await ensureExample(deps)).status).toBe("fresh");
    expect(await prisma.backtest.count({ where: { kind: "example" } })).toBe(1);
  });
});
