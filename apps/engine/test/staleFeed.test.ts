/**
 * The first price feed stops, but keeps answering with the candles it has. Before, its answer was taken because it
 * answered, so an agent sat on "waiting for fresh data" and acted on no stop while the second feed was healthy.
 * Here the price falls 10% while the first feed is stuck: the agent's 4% stop sells in that hour, on the second
 * feed's prices, and the decision says which feed they came from.
 *
 * The runner, the brain and the database are real. The candles are scripted.
 */
import { HOUR_MS, type Candle, type Plan } from "@rationale/brain";
import { prisma, type Prisma } from "@rationale/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreshDataPendingError, runAgentHours } from "../src/runAgent";
import { fakeFeed } from "./fakes";

const hasDb = !!process.env.DATABASE_URL;
const H0 = Date.UTC(2026, 10, 10, 12);
const START = 2000;

/** Buys whenever it has no position (its one rule always holds), and sells at a 4% loss. */
const plan: Plan = { markets: ["ETH"], kind: "entry_exit", entry: [{ signal: "rsi", op: "<", value: 101 }], exit: { stopLossPct: 4 }, filters: [], sizePctOfCash: 25 };

/**
 * `moves[k - 1]` is the price change, in percent, between the decision of hour k - 1 and the decision of hour k.
 * Before H0 the price idles around 2000, long enough for every indicator. A decision at hour H0 + k sees the candle
 * that closed then, and fills at that same price.
 */
function scripted(moves: number[]): Candle[] {
  const prices = [START];
  for (const m of moves) prices.push(prices[prices.length - 1]! * (1 + m / 100));
  prices.push(prices[prices.length - 1]!);
  const candles: Candle[] = [];
  let p = START;
  for (let i = 600; i >= 1; i--) {
    const o = p;
    p = i === 1 ? START : START * (1 + 0.002 * Math.sin(i / 5));
    candles.push({ t: H0 - i * HOUR_MS, o, h: Math.max(o, p) * 1.0005, l: Math.min(o, p) * 0.9995, c: p, v: 120 });
  }
  for (let k = 0; k + 1 < prices.length; k++) {
    const o = prices[k]!;
    const c = prices[k + 1]!;
    candles.push({ t: H0 + k * HOUR_MS, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 120 });
  }
  return candles;
}

async function wipe() {
  await prisma.decision.deleteMany();
  await prisma.agentState.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.engineRun.deleteMany();
  await prisma.candle.deleteMany();
}

async function makeAgent() {
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
    },
  });
}

describe.skipIf(!hasDb)("a paper agent when the first price feed is stuck", () => {
  // Flat for two hours, then 10% down in the third.
  const path = scripted([0, 0, -10]);
  // The first feed stopped during hour 0: it has that hour's candle and nothing after, and still answers.
  const stuck = path.filter((c) => c.t <= H0);

  beforeEach(async () => {
    await wipe();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("acts on its 4% stop in the hour the price is 10% down, on the second feed's prices", async () => {
    const asked = { first: { n: 0 }, second: { n: 0 } };
    const feeds = [fakeFeed("binance", stuck, asked.first), fakeFeed("hyperliquid", path, asked.second)];
    const agent = await makeAgent();
    const hour = async (k: number) => {
      const h = H0 + k * HOUR_MS;
      // On time, two minutes into the hour: a missing candle is waited for, not decided without.
      await runAgentHours(agent.id, h, { prisma, feeds, now: () => h + 2 * 60_000 });
      return prisma.decision.findUniqueOrThrow({ where: { agentId_hour: { agentId: agent.id, hour: new Date(h) } } });
    };

    // Hour 0: the first feed is still current. It is the source, and the second is not asked.
    const buy = await hour(0);
    expect(buy).toMatchObject({ action: "buy", fillSide: "buy", fillPrice: START, candleSource: "binance:ETHUSDT" });
    expect(asked.second.n).toBe(0);

    // Hours 1 and 2: the first feed answers with what it has. The second is used and named.
    for (const k of [1, 2]) {
      const d = await hour(k);
      expect(d, `hour ${k}`).toMatchObject({ action: "hold", late: false, candleSource: "hyperliquid:ETHUSDT" });
      expect(d.candleTime.getTime()).toBe(H0 + (k - 1) * HOUR_MS);
      expect(d.qtyAfter).toBeCloseTo(buy.qtyAfter, 12);
    }

    // Hour 3: the price is 10% under the buy. The first feed is two hours behind by now and knows nothing of it.
    const sell = await hour(3);
    expect(sell).toMatchObject({ action: "sell", fillSide: "sell", fillPrice: START * 0.9, qtyAfter: 0, late: false, candleSource: "hyperliquid:ETHUSDT" });
    expect(sell.candleTime.getTime()).toBe(H0 + 2 * HOUR_MS);
    expect(sell.fillQty).toBeCloseTo(buy.qtyAfter, 12);
    expect(sell.explanation).toMatch(/stop/i);
    // The data was fresh: no check of the guard failed.
    expect((sell.guard as { check: string; pass: boolean }[]).filter((g) => !g.pass)).toEqual([]);
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } });
    expect(state.qty).toBe(0);
    expect(state.cash).toBeLessThan(10_000);
    // Each hour asked the first feed once, found it behind, and asked the second once.
    expect([asked.first.n, asked.second.n]).toEqual([4, 3]);
  });

  it("with no other feed to turn to, the same hour is waited for and nothing is decided", async () => {
    const agent = await makeAgent();
    // Bought and held for two hours while its one feed was healthy.
    await runAgentHours(agent.id, H0 + 2 * HOUR_MS, { prisma, feeds: [fakeFeed("binance", path)], now: () => H0 + 2 * HOUR_MS + 2 * 60_000 });
    const h = H0 + 3 * HOUR_MS;
    await expect(runAgentHours(agent.id, h, { prisma, feeds: [fakeFeed("binance", stuck)], now: () => h + 2 * 60_000 })).rejects.toBeInstanceOf(FreshDataPendingError);
    expect(await prisma.decision.count({ where: { agentId: agent.id, hour: new Date(h) } })).toBe(0);
    // The position is still open, 10% under water.
    expect((await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } })).qty).toBeGreaterThan(0);
  });
});
