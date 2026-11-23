/**
 * What an owner expects of a live agent, hour by hour, on a price path written out by hand: it buys when its rule
 * holds, sells the whole position at its take profit, at its stop loss or at its trailing stop, tries again the
 * next hour when the vault refused the sale, and stops buying for the day once its daily loss cap is passed.
 *
 * The runner, the brain and the database are real. The chain is the pretend one; the candles are scripted.
 */
import { HOUR_MS, type Candle, type Plan } from "@rationale/brain";
import { fromUnits } from "@rationale/config";
import { prisma, type Prisma } from "@rationale/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runLiveAgentHour } from "../src/vault/runLive";
import { fakeFeed } from "./fakes";
import { H0, OWNER, PretendChain, VAULT } from "./pretendChain";

const hasDb = !!process.env.DATABASE_URL;
const START = 2000;

/**
 * Candles for a scripted path. `moves[k - 1]` is the price change, in percent, between the decision of hour k - 1
 * and the decision of hour k. Before H0 the price idles around 2000, long enough for every indicator.
 * A decision at hour H0 + k sees the candle that closed then, and its order fills at that same price.
 */
function scripted(moves: number[]): { candles: Candle[]; price: (k: number) => number } {
  const prices = [START];
  for (const m of moves) prices.push(prices[prices.length - 1]! * (1 + m / 100));
  // One more hour at the last price, so the last decision has an opening price to fill at.
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
  return { candles, price: (k) => prices[k]! };
}

/** Buys whenever it has no position (its one rule always holds), with the exits under test. */
const plan = (exit: Plan["exit"], sizePctOfCash = 25): Plan => ({ markets: ["ETH"], kind: "entry_exit", entry: [{ signal: "rsi", op: "<", value: 101 }], exit, filters: [], sizePctOfCash });

async function wipe() {
  await prisma.liveOrder.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.agentState.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await prisma.engineRun.deleteMany();
  await prisma.candle.deleteMany();
}

/** A live agent on a vault holding $1,000 of USDG, and a way to run its hours on the scripted path. */
async function setup(p: Plan, moves: number[]) {
  const path = scripted(moves);
  const feeds = [fakeFeed("binance", path.candles)];
  const chain = new PretendChain();
  const user = await prisma.user.create({ data: { address: OWNER } });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      name: "Meridian",
      sentence: "test",
      plan: p as unknown as Prisma.InputJsonValue,
      params: { confidenceThreshold: 0, windows: {} },
      market: "ETH",
      mode: "live",
      vault: VAULT,
      startingCash: 1000,
      maxSizePct: 35,
      dailyLossCapPct: 3,
      owedFrom: new Date(H0),
      state: { create: { cash: 1000, qty: 0, dayStart: new Date(Date.UTC(2026, 10, 10)), dayStartEquity: 1000 } },
    },
  });
  const hour = async (k: number) => {
    const h = H0 + k * HOUR_MS;
    chain.price = path.price(k);
    chain.clock = Math.floor((h + 120_000) / 1000);
    await runLiveAgentHour(agent.id, h, { prisma, feeds, chain, now: () => h + 120_000 });
    const d = await prisma.decision.findUniqueOrThrow({ where: { agentId_hour: { agentId: agent.id, hour: new Date(h) } } });
    // Whatever was decided, the stored position is the vault's.
    expect(d.cashAfter, `hour ${k} cash`).toBeCloseTo(fromUnits(chain.stable, 6), 5);
    expect(d.qtyAfter, `hour ${k} tokens`).toBeCloseTo(fromUnits(chain.token, 18), 10);
    expect(d.equityAfter, `hour ${k} equity`).toBeCloseTo(d.cashAfter + d.qtyAfter * path.price(k), 5);
    return d;
  };
  /** The same run with nothing assumed about how it ends: for hours that end without a decision. */
  const attempt = (k: number) => {
    const h = H0 + k * HOUR_MS;
    chain.price = path.price(k);
    chain.clock = Math.floor((h + 120_000) / 1000);
    return runLiveAgentHour(agent.id, h, { prisma, feeds, chain, now: () => h + 120_000 });
  };
  return { chain, agent, hour, attempt, price: path.price };
}

describe.skipIf(!hasDb)("a live agent on a scripted price path", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("buys, holds while the gain is under its target, and sells everything at its take profit", async () => {
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [3, 3, 3, 0]);
    const buy = await s.hour(0);
    expect(buy).toMatchObject({ action: "buy", fillSide: "buy", fillNotional: 250, execError: null });
    expect(buy.explanation).toMatch(/^Buy\. .*Bought \$250\.00 of ETH at \$2,00\d\.\d\d, 25% of cash\.$/);
    const bought = s.chain.token;
    expect(bought).toBeGreaterThan(0n);

    const h1 = await s.hour(1);
    expect(h1.action).toBe("hold");
    expect(h1.explanation).toBe("Hold. In position at +2.9% since buying. Take profit at +8%, stop at −4%.");
    expect(s.chain.token).toBe(bought);
    const h2 = await s.hour(2);
    expect(h2.action).toBe("hold");
    expect(h2.explanation).toMatch(/^Hold\. In position at \+6\.0% since buying\./);

    // +9.2% since buying: past the +8% target. Everything is sold in this hour.
    const sell = await s.hour(3);
    expect(sell).toMatchObject({ action: "sell", fillSide: "sell", execError: null, qtyAfter: 0 });
    expect(sell.txHash).toMatch(/^0x/);
    expect(s.chain.token).toBe(0n);
    expect(sell.fillQty).toBeCloseTo(fromUnits(bought, 18), 10);
    expect(sell.explanation).toMatch(/^Sell\. Take profit reached: \+9\.2% since buying, target \+8%\. Sold 0\.1249 ETH at \$2,185\.45, \+9\.2% on the trade after costs\.$/);
    // The dollars are really there: what was paid, plus the gain, less the pool's fee on both trades.
    expect(sell.cashAfter).toBeCloseTo(750 + fromUnits(bought, 18) * s.price(3) * (1 - 0.0005), 4);
    expect(sell.cashAfter).toBeGreaterThan(1022);
    expect(await prisma.liveOrder.count({ where: { status: "done" } })).toBe(2);

    // Flat again, so its rule can buy again: with a quarter of the cash it has now.
    const again = await s.hour(4);
    expect(again.action).toBe("buy");
    expect(again.fillNotional).toBeCloseTo(sell.cashAfter * 0.25, 4);
  });

  it("sells everything at its stop loss, in the first hour the loss is past it", async () => {
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [-2.5, -2.5, 0]);
    await s.hour(0);
    const bought = s.chain.token;
    const h1 = await s.hour(1);
    expect(h1.action).toBe("hold");
    expect(h1.explanation).toBe("Hold. In position at −2.5% since buying. Take profit at +8%, stop at −4%.");
    const sell = await s.hour(2);
    expect(sell).toMatchObject({ action: "sell", fillSide: "sell", qtyAfter: 0, execError: null });
    expect(s.chain.token).toBe(0n);
    expect(sell.explanation).toMatch(/^Sell\. Stop loss reached: −5\.0% since buying, stop at −4%\. Sold 0\.1249 ETH at \$1,901\.25, −5\.0% on the trade after costs\.$/);
    expect(sell.cashAfter).toBeCloseTo(750 + fromUnits(bought, 18) * s.price(2) * (1 - 0.0005), 4);
    expect(sell.cashAfter).toBeLessThan(1000);
  });

  it("follows the price up with a trailing stop, and sells when it falls back by that much from its high", async () => {
    const s = await setup(plan({ trailingStopPct: 5 }), [5, 5, -3, -3, 0]);
    await s.hour(0);
    expect((await s.hour(1)).action).toBe("hold");
    expect((await s.hour(2)).action).toBe("hold"); // the high: +10.25%
    const h3 = await s.hour(3);
    expect(h3.action).toBe("hold"); // 3% under the high
    expect((h3.evidence as { name: string; value: string }[]).find((e) => e.name === "Trailing stop")?.value).toBe("−3.0% from the high since buying (stop 5% under it)");
    const sell = await s.hour(4);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0 });
    expect(sell.explanation).toMatch(/^Sell\. Trailing stop reached: 5\.9% under the high since buying, stop at 5%\. Sold 0\.1249 ETH at \$2,074\.6\d, \+3\.\d% on the trade after costs\.$/);
    expect(s.chain.token).toBe(0n);
    // After the sale the high is forgotten: a new position starts its own.
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } });
    expect(state).toMatchObject({ qty: 0, peak: null, avgEntry: null, peakSeenTo: null });
  });

  it("a high made in hours the engine did not run still counts for the trailing stop", async () => {
    const s = await setup(plan({ trailingStopPct: 5 }), [5, 5, -6, 0]);
    await s.hour(0);
    // The engine is down for two hours, while the price rises 10%. When it is back the price is 6% under a high
    // it never looked at, and still above what it paid.
    const sell = await s.hour(3);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0 });
    expect(sell.explanation).toMatch(/^Sell\. Trailing stop reached: 6\.0% under the high since buying, stop at 5%\. Sold 0\.1249 ETH at \$2,072\.7\d, \+3\.\d% on the trade after costs\.$/);
    expect(s.chain.token).toBe(0n);
  });

  it("when the vault refuses the sale, says the position is still open, and sells the next hour", async () => {
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [3, 3, 3, 0, 0]);
    await s.hour(0);
    await s.hour(1);
    await s.hour(2);
    const bought = s.chain.token;
    s.chain.refuse = "the vault is paused";
    const refused = await s.hour(3);
    expect(refused).toMatchObject({ action: "hold", fillSide: null, txHash: null, execError: "the vault is paused" });
    expect(refused.explanation).toBe(
      "Hold. Take profit reached: +9.2% since buying, target +8%, but the position was not sold: the vault is paused. It is still open, and the agent sells in the next hour its target is still reached.",
    );
    expect(s.chain.token).toBe(bought);
    // The owner resumes the vault. The target is still reached, so the agent sells now.
    s.chain.refuse = null;
    const sell = await s.hour(4);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0 });
    expect(sell.explanation).toMatch(/^Sell\. Take profit reached: \+9\.2% since buying, target \+8%\. Sold /);
    expect(s.chain.token).toBe(0n);
  });

  it("a take profit that could not be sold is never sold under its target: after the price falls back, the agent holds", async () => {
    // +9.2% at hour 3, and the vault is paused. Two hours later the owner unpauses it, with the price under what was paid.
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 10 }), [3, 3, 3, -6, -5, 0]);
    await s.hour(0);
    await s.hour(1);
    await s.hour(2);
    const bought = s.chain.token;
    s.chain.refuse = "the vault is paused";
    expect((await s.hour(3)).explanation).toMatch(/^Hold\. Take profit reached: \+9\.2% since buying, target \+8%, but the position was not sold: the vault is paused\./);
    expect(await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } })).toMatchObject({ exitPendingSince: null, exitPendingKind: null });
    await s.hour(4);
    s.chain.refuse = null;
    const after = await s.hour(5);
    expect(after.action).toBe("hold");
    expect(after.explanation).toBe("Hold. In position at −2.5% since buying. Take profit at +8%, stop at −10%.");
    expect(s.chain.token).toBe(bought);
    // The buy, and the one refused sale. Once the target was no longer reached, no sale was tried again.
    expect(s.chain.asked).toBe(2);
  });

  it("a position built by several scheduled buys never grows past what the vault's daily limit can still sell", async () => {
    // $1,000, a buy of 25% of the cash every hour, a 4% stop. The vault lets $600 be traded today.
    const hourly: Plan = { markets: ["ETH"], kind: "dca", entry: [], cadenceHours: 1, sizePctOfCash: 25, exit: { stopLossPct: 4 }, filters: [] };
    const s = await setup(hourly, [0, 0, -6, 0]);
    s.chain.remainingUsd = 600;
    expect((await s.hour(0)).fillNotional).toBe(250);
    // The second buy is cut to what still leaves room to sell both.
    const second = await s.hour(1);
    expect(second.action).toBe("buy");
    expect(second.fillNotional).toBeGreaterThan(15);
    expect(second.fillNotional).toBeLessThan(25);
    expect(second.explanation).toMatch(/The order is smaller than the 25% the plan asks for, so that the sale of this position still fits in the vault's daily trading limit\.$/);
    // A third would leave a position the limit could not sell today. It is not placed.
    const third = await s.hour(2);
    expect(third).toMatchObject({ action: "hold", execError: "the vault's daily trading limit has too little left for a buy and the sale that would follow it" });
    const held = fromUnits(s.chain.token, 18) * s.price(2);
    expect(s.chain.remainingUsd * 0.98).toBeGreaterThan(held);
    // The stop is hit. All of it is sold, in the same day's limit.
    const sell = await s.hour(3);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0, execError: null });
    expect(sell.explanation).toMatch(/^Sell\. Stop loss reached: −6\.\d% since buying, stop at −4%\./);
    expect(sell.explanation).not.toMatch(/still held/);
    expect(s.chain.token).toBe(0n);
  });

  it("a stop reached in an hour when the chain could not be reached at all is still sold the next hour", async () => {
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [-5, 4.2, 0]);
    await s.hour(0);
    // −5%: the agent wants to sell, and cannot reach the chain to place the order. The hour ends with no decision.
    s.chain.unreachable = 1;
    await expect(s.attempt(1)).rejects.toThrow(/fetch failed/);
    expect(await prisma.decision.count({ where: { agentId: s.agent.id } })).toBe(1);
    expect(await prisma.liveOrder.count({ where: { side: "sell" } })).toBe(0);
    // What it wanted is on the record all the same.
    expect(await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } })).toMatchObject({ exitPendingSince: new Date(H0 + HOUR_MS), exitPendingKind: "stop loss" });
    // An hour later the price is back inside the stop. The position is sold.
    const sell = await s.hour(2);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0 });
    expect(sell.explanation).toMatch(/^Sell\. Finishing the sale from \d\d:00 UTC on \d{1,2} [A-Z][a-z]{2} \(stop loss reached\)\. Now −1\.1% since buying\./);
    expect(s.chain.token).toBe(0n);
  });

  it("tokens the owner sends right after a sale are a new position, not the rest of the old one", async () => {
    const s = await setup(plan({ stopLossPct: 4 }), [-5, 0, 0]);
    await s.hour(0);
    const bought = s.chain.token;
    // The stop-loss sale of the whole position lands, and the run dies before it writes the hour down.
    s.chain.drop = "afterSend";
    await expect(s.attempt(1)).rejects.toThrow();
    expect(s.chain.token).toBe(0n);
    s.chain.drop = null;
    // Before the retry, the owner sends twice as many tokens to the vault.
    s.chain.token = bought * 2n;
    const booked = await s.hour(1);
    expect(booked).toMatchObject({ action: "sell", fillSide: "sell" });
    expect(booked.fillQty).toBeCloseTo(fromUnits(bought, 18), 10);
    expect(booked.explanation).toMatch(/Sold 0\.1249 ETH at \$[\d,.]+\. 0\.2499 ETH that came into the vault since is now held\.$/);
    // No exit is open on it, and it is counted as bought at this hour's price.
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } });
    expect(state).toMatchObject({ exitPendingSince: null, exitPendingKind: null });
    expect(state.avgEntry).toBeCloseTo(s.price(1), 6);
    const next = await s.hour(2);
    expect(next.action).toBe("hold");
    expect(next.explanation).toBe("Hold. In position at 0.0% since buying. Stop at −4%.");
    expect(s.chain.token).toBe(bought * 2n);
  });

  it("an exit that was reached stays an order to sell: refused at the stop, it is sold the next hour although the price is back", async () => {
    // −5% takes it past the 4% stop. The sale is refused. An hour later the price is back at −1%.
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [-5, 4.2, 0]);
    await s.hour(0);
    const bought = s.chain.token;
    s.chain.refuse = "the pool price was worse than the vault's slippage limit";
    const refused = await s.hour(1);
    expect(refused).toMatchObject({ action: "hold", execError: "the pool price was worse than the vault's slippage limit" });
    expect(refused.explanation).toBe(
      "Hold. Stop loss reached: −5.0% since buying, stop at −4%, but the position was not sold: the pool price was worse than the vault's slippage limit. It is still open, and the agent tries again next hour.",
    );
    expect(await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } })).toMatchObject({ exitPendingSince: new Date(H0 + HOUR_MS), exitPendingKind: "stop loss" });

    // Refused again: it says it is still trying, and keeps the hour the stop was first reached.
    const again = await s.hour(2);
    expect(again.action).toBe("hold");
    expect(again.explanation).toMatch(
      /^Hold\. The agent is still trying to finish the sale from \d\d:00 UTC on \d{1,2} [A-Z][a-z]{2} \(stop loss reached\), but the position was not sold: the pool price was worse than the vault's slippage limit\. It is still open, and the agent tries again next hour\.$/,
    );
    expect(s.chain.token).toBe(bought);
    expect(await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } })).toMatchObject({ exitPendingSince: new Date(H0 + HOUR_MS) });

    // The pool is back in range. −1.1% is inside the stop, and the position is sold all the same.
    s.chain.refuse = null;
    const sell = await s.hour(3);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0, execError: null });
    expect(sell.explanation).toMatch(/^Sell\. Finishing the sale from \d\d:00 UTC on \d{1,2} [A-Z][a-z]{2} \(stop loss reached\)\. Now −1\.1% since buying\. Sold 0\.1249 ETH at \$1,979\.8\d, −1\.1% on the trade after costs\.$/);
    expect(s.chain.token).toBe(0n);
    expect(await prisma.agentState.findUniqueOrThrow({ where: { agentId: s.agent.id } })).toMatchObject({ qty: 0, exitPendingSince: null, exitPendingKind: null });
  });

  it("with a small daily limit the buy is sized so that its own stop-loss sale fits in the same day", async () => {
    // The vault lets $300 be traded today, buys and sales together. The plan asks for a $250 buy.
    const s = await setup(plan({ takeProfitPct: 8, stopLossPct: 4 }), [-5, 0]);
    s.chain.remainingUsd = 300;
    const buy = await s.hour(0);
    expect(buy.fillNotional).toBeCloseTo((300 * 0.98) / 2.2, 4);
    expect(buy.explanation).toMatch(/Bought \$133\.64 of ETH at \$[\d,.]+, 13\.4% of cash\. The order is smaller than the 25% the plan asks for, so that the sale of this position still fits in the vault's daily trading limit\.$/);
    // The stop is hit the next hour, with the same day's limit. All of it is sold.
    const sell = await s.hour(1);
    expect(sell).toMatchObject({ action: "sell", qtyAfter: 0, execError: null });
    expect(sell.explanation).toMatch(/^Sell\. Stop loss reached: −5\.0% since buying, stop at −4%\./);
    expect(sell.explanation).not.toMatch(/still held/);
    expect(s.chain.token).toBe(0n);
  });

  it("a fall straight through the stop is sold at the price it finds, and the daily loss cap then stops new buys until the next day", async () => {
    // 35% of the cash in the position; the price falls 9% in one hour, far past the 4% stop.
    const s = await setup(plan({ stopLossPct: 4 }, 35), [-9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect((await s.hour(0)).fillNotional).toBe(350);
    const sell = await s.hour(1);
    expect(sell.action).toBe("sell");
    // It says what the loss really was, not what the stop was set to.
    expect(sell.explanation).toMatch(/^Sell\. Stop loss reached: −9\.0% since buying, stop at −4%\. Sold 0\.1749 ETH at \$1,820\.00, −9\.1% on the trade after costs\.$/);
    expect(sell.equityAfter).toBeCloseTo(968.19, 1);

    // Down 3.2% on the day, past the 3% cap: its rule holds, but no new buy today.
    const h2 = await s.hour(2);
    expect(h2.action).toBe("hold");
    expect(h2.explanation).toMatch(/^Hold\. The entry rules are met \(confidence \d+%\), but the guard said no: down 3\.2% today, past your 3% cap\. No new buys until the next UTC day\.$/);
    expect(s.chain.asked).toBe(2);
    expect((await s.hour(11)).action).toBe("hold");
    // 00:00 UTC: a new day. It may buy again.
    const next = await s.hour(12);
    expect(next.action).toBe("buy");
    expect(next.fillNotional).toBeCloseTo(sell.cashAfter * 0.35, 4);
  });
});
