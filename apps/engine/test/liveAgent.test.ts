/**
 * Live agents against a pretend chain: a vault with balances, a price, and switches for everything that can go
 * wrong around an order. The database is real (the test database).
 */
import { HOUR_MS, type Plan } from "@rationale/brain";
import { LIVE_STABLE, LIVE_TOKENS, fromUnits, toUnits, type Address } from "@rationale/config";
import { prisma, type Prisma } from "@rationale/db";
import type { Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runAgentHours } from "../src/runAgent";
import { tick } from "../src/tick";
import { OrderPendingError, type SwapOutcome, type SwapRequest, type VaultChain, type VaultSnapshot } from "../src/vault/chain";
import { runLiveAgentHour } from "../src/vault/runLive";
import { fakeFeed, synthCandles } from "./fakes";

const hasDb = !!process.env.DATABASE_URL;
const H0 = Date.UTC(2026, 10, 10, 12);
const series = synthCandles(H0 - 1500 * HOUR_MS, H0 + 10 * HOUR_MS, 3);
const feeds = [fakeFeed("binance", series)];
const open = (hour: number) => series.find((c) => c.t === hour)!.o;

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const WETH = LIVE_TOKENS.ETH;
const usdg = (n: number) => toUnits(n, LIVE_STABLE.decimals);

class PretendChain implements VaultChain {
  operator = OPERATOR;
  owner = OWNER;
  vaultOperator = OPERATOR;
  paused = false;
  tradable = true;
  feeTier = 500;
  stable = usdg(1000);
  token = 0n;
  price = 2000;
  block = 100n;
  /** Every order that reached the chain. */
  done: { req: SwapRequest; out: Extract<SwapOutcome, { ok: true }> }[] = [];
  /** How many times an order was asked for. */
  asked = 0;
  refuse: string | null = null;
  /** "afterSend": the order lands, but the connection drops before the answer. "lost": it never reaches the chain. */
  drop: "afterSend" | "lost" | null = null;
  /** Runs after the order is prepared and before its hash is handed over, like a slow worker. */
  beforeSign: (() => Promise<void>) | null = null;
  /** The chain cannot be asked about transactions right now. */
  lookupDown = false;
  private nonce = 0;

  async blockNumber() {
    return this.block++;
  }
  async snapshot(): Promise<VaultSnapshot> {
    return { owner: this.owner, operator: this.vaultOperator, paused: this.paused, stable: this.stable, token: this.token, tradable: this.tradable, feeTier: this.feeTier };
  }
  private execute(req: SwapRequest, txHash: Hex): Extract<SwapOutcome, { ok: true }> {
    const fee = this.feeTier / 1_000_000;
    const buying = req.tokenIn === LIVE_STABLE.address;
    let amountOut: bigint;
    if (buying) {
      amountOut = toUnits((fromUnits(req.amountIn, 6) * (1 - fee)) / this.price, WETH.decimals);
      this.stable -= req.amountIn;
      this.token += amountOut;
    } else {
      amountOut = toUnits(fromUnits(req.amountIn, WETH.decimals) * this.price * (1 - fee), 6);
      this.token -= req.amountIn;
      this.stable += amountOut;
    }
    const out = { ok: true as const, txHash, amountIn: req.amountIn, amountOut };
    this.done.push({ req, out });
    return out;
  }
  /** Like the real client: the hash exists, and is handed over, before anything is sent. */
  async swap(req: SwapRequest, onSigned: (h: Hex) => Promise<void>): Promise<SwapOutcome> {
    this.asked++;
    if (this.refuse) return { ok: false, reason: this.refuse };
    const txHash = `0x${(++this.nonce).toString(16).padStart(64, "0")}` as Hex;
    await this.beforeSign?.();
    await onSigned(txHash);
    if (this.drop === "lost") throw new OrderPendingError("dropped");
    const out = this.execute(req, txHash);
    if (this.drop === "afterSend") throw new OrderPendingError("dropped");
    return out;
  }
  async outcomeOf(txHash: Hex): Promise<SwapOutcome | null> {
    if (this.lookupDown) throw new Error("rpc down");
    return this.done.find((d) => d.out.txHash === txHash)?.out ?? null;
  }
}

/** Buys a tenth of the cash on a schedule: the first hour is always a buy. */
const dca: Plan = { markets: ["ETH"], kind: "dca", entry: [], cadenceHours: 24, sizePctOfCash: 10, exit: { stopLossPct: 15 }, filters: [] };

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

/** A live agent as the API creates it at launch: the position is what the vault held at that moment. */
async function launch(chain: PretendChain, plan: Plan = dca) {
  const user = await prisma.user.create({ data: { address: OWNER } });
  const cash = fromUnits(chain.stable, 6);
  return prisma.agent.create({
    data: {
      userId: user.id,
      name: "Meridian",
      sentence: "test",
      plan: plan as unknown as Prisma.InputJsonValue,
      params: { confidenceThreshold: 0, windows: {} },
      market: "ETH",
      mode: "live",
      vault: VAULT,
      startingCash: cash,
      maxSizePct: 35,
      dailyLossCapPct: 3,
      owedFrom: new Date(H0),
      state: { create: { cash, qty: 0, dayStart: new Date(Date.UTC(2026, 10, 10)), dayStartEquity: cash } },
    },
  });
}

const at = (hour: number, minutes = 2) => () => hour + minutes * 60_000;
const run = (chain: PretendChain, agentId: string, hour: number, minutes = 2) => {
  chain.price = open(hour);
  return runLiveAgentHour(agentId, hour, { prisma, feeds, chain, now: at(hour, minutes) });
};
const decisions = (agentId: string) => prisma.decision.findMany({ where: { agentId }, orderBy: { hour: "asc" } });

describe.skipIf(!hasDb)("live agents", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("buys with real money: one order, and the decision carries what the chain did", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    expect(await run(chain, agent.id, H0)).toMatchObject({ decided: 1, skipped: false });

    expect(chain.done).toHaveLength(1);
    expect(chain.done[0]!.req).toMatchObject({ vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: WETH.address, feeTier: 500, amountIn: usdg(100) });
    const [d] = await decisions(agent.id);
    const got = fromUnits(chain.token, 18);
    expect(d).toMatchObject({ action: "buy", txHash: chain.done[0]!.out.txHash, execError: null, flowUsd: null, basisAfter: 1000, fillSide: "buy", fillNotional: 100 });
    expect(d!.fillQty).toBeCloseTo(got, 12);
    expect(d!.fillFee).toBeCloseTo(0.05, 9);
    expect(d!.fillPrice).toBeCloseTo((100 - 0.05) / got, 6);
    expect(d!.explanation).toMatch(/^Buy\. Scheduled purchase .* Bought \$100\.00 of ETH at \$/);
    expect(d!.cashAfter).toBeCloseTo(900, 9);
    // The stored position is the vault's.
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } });
    expect(state.cash).toBeCloseTo(fromUnits(chain.stable, 6), 9);
    expect(state.qty).toBeCloseTo(got, 12);
    expect(await prisma.liveOrder.findFirstOrThrow()).toMatchObject({ status: "done", side: "buy", amountIn: usdg(100).toString(), txHash: d!.txHash });

    // Next hour nothing is due: no order.
    await run(chain, agent.id, H0 + HOUR_MS);
    expect(chain.asked).toBe(1);
    expect((await decisions(agent.id))[1]).toMatchObject({ action: "hold", txHash: null });
  });

  it("running the same hour twice places one order and stores one decision", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    expect(await run(chain, agent.id, H0)).toMatchObject({ skipped: true, reason: "up to date" });
    expect(chain.asked).toBe(1);
    expect(await decisions(agent.id)).toHaveLength(1);
  });

  it("an order the vault refuses is a hold that says why, and nothing changes", async () => {
    const chain = new PretendChain();
    chain.refuse = "the vault's daily trading limit is used up";
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "hold", txHash: null, execError: "the vault's daily trading limit is used up", fillSide: null, cashAfter: 1000, qtyAfter: 0 });
    expect(d!.explanation).toMatch(/but the buy order did not go through: the vault's daily trading limit is used up\. Nothing changed\.$/);
    expect(chain.stable).toBe(usdg(1000));
    expect(await prisma.liveOrder.findFirstOrThrow()).toMatchObject({ status: "failed", error: "the vault's daily trading limit is used up" });
  });

  it("a crash after the order was sent finishes that order on retry and never sends a second one", async () => {
    const chain = new PretendChain();
    chain.drop = "afterSend";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    expect(await decisions(agent.id)).toHaveLength(0);
    expect(await prisma.liveOrder.findFirstOrThrow()).toMatchObject({ status: "pending", txHash: chain.done[0]!.out.txHash });
    // While the chain cannot be asked, nothing is concluded.
    chain.lookupDown = true;
    await expect(run(chain, agent.id, H0, 18)).rejects.toThrow(/rpc down/);
    expect(await prisma.liveOrder.findFirstOrThrow()).toMatchObject({ status: "pending" });
    chain.lookupDown = false;

    chain.drop = null;
    expect(await run(chain, agent.id, H0, 4)).toMatchObject({ decided: 1 });
    expect(chain.asked).toBe(1);
    expect(chain.done).toHaveLength(1);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "buy", txHash: chain.done[0]!.out.txHash, fillNotional: 100 });
    expect(d!.cashAfter).toBeCloseTo(900, 9);
    expect(d!.qtyAfter).toBeCloseTo(fromUnits(chain.token, 18), 12);
  });

  it("an order that was signed but never reached the chain is waited for, then recorded as never confirmed, and not sent again", async () => {
    const chain = new PretendChain();
    chain.drop = "lost";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    const open = await prisma.liveOrder.findFirstOrThrow();
    expect(open).toMatchObject({ status: "pending" });
    expect(open.txHash).toMatch(/^0x/);

    chain.drop = null;
    // Still inside the wait: nothing is concluded and nothing is sent.
    await expect(run(chain, agent.id, H0, 10)).rejects.toThrow(OrderPendingError);
    await run(chain, agent.id, H0, 18);
    expect(chain.asked).toBe(1);
    expect(chain.done).toHaveLength(0);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "hold", execError: "the chain never confirmed the order", cashAfter: 1000, qtyAfter: 0 });
    expect(await prisma.liveOrder.findFirstOrThrow()).toMatchObject({ status: "failed" });
  });

  it("an order another worker already closed as not sent is never sent", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    // While this worker is still preparing the order, another one gives up on it.
    chain.beforeSign = async () => {
      await prisma.liveOrder.updateMany({ where: { agentId: agent.id }, data: { status: "failed", error: "the order was not sent" } });
    };
    await run(chain, agent.id, H0);
    expect(chain.done).toHaveLength(0);
    expect(chain.stable).toBe(usdg(1000));
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "hold", execError: "the order was not sent", txHash: null });
  });

  it("an order that never reached the chain is waited for, then recorded as not sent, without a new order", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await prisma.liveOrder.create({
      data: { agentId: agent.id, hour: new Date(H0), side: "buy", vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: WETH.address, amountIn: usdg(100).toString(), fromBlock: "100", createdAt: new Date(H0 + 60_000) },
    });
    // Too early to tell.
    await expect(run(chain, agent.id, H0, 2)).rejects.toThrow(OrderPendingError);
    // Long enough: it was never sent.
    await run(chain, agent.id, H0, 6);
    expect(chain.asked).toBe(0);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "hold", execError: "the order was not sent", cashAfter: 1000 });
  });

  it("does not place orders late in the hour, and says so", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0, 25);
    expect(chain.asked).toBe(0);
    const [d] = await decisions(agent.id);
    expect(d!.action).toBe("hold");
    expect(d!.execError).toMatch(/this run was late/);
    expect(await prisma.liveOrder.count()).toBe(0);
  });

  it("a deposit is recorded as a flow and does not change the return", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const first = (await decisions(agent.id))[0]!;
    const navBefore = first.equityAfter / first.basisAfter!;

    chain.stable += usdg(2000); // the owner deposits
    await run(chain, agent.id, H0 + HOUR_MS);
    const second = (await decisions(agent.id))[1]!;
    expect(second.flowUsd).toBeCloseTo(2000, 6);
    expect(second.basisAfter!).toBeGreaterThan(2900);
    // Same return as if the deposit had not happened: only the price moved between the two hours.
    const priceMove = (fromUnits(chain.token, 18) * (open(H0 + HOUR_MS) - open(H0))) / first.equityAfter;
    expect(second.equityAfter / second.basisAfter!).toBeCloseTo(navBefore * (1 + priceMove), 6);
    const fresh = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(fresh.startingCash).toBeCloseTo(second.basisAfter!, 9);
    expect(second.equityAfter).toBeCloseTo(fromUnits(chain.stable, 6) + fromUnits(chain.token, 18) * open(H0 + HOUR_MS), 6);
  });

  it("a withdrawal is a negative flow and does not look like a loss", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    chain.stable -= usdg(450); // the owner takes half the cash out
    await run(chain, agent.id, H0 + HOUR_MS);
    const [first, second] = await decisions(agent.id);
    expect(second!.flowUsd).toBeCloseTo(-450, 6);
    expect(Math.abs(second!.equityAfter / second!.basisAfter! - first!.equityAfter / first!.basisAfter!)).toBeLessThan(0.002);
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } });
    expect(state.maxDrawdownPct).toBeGreaterThan(-1);
  });

  it("stops itself, with the reason, when the vault is emptied, the access is revoked or the owner changes", async () => {
    const cases: [(c: PretendChain) => void, RegExp][] = [
      [(c) => void ((c.stable = 0n), (c.token = 0n)), /vault is empty/],
      [(c) => void (c.vaultOperator = "0x0000000000000000000000000000000000000000"), /access to the vault was revoked/],
      [(c) => void (c.owner = "0x9999999999999999999999999999999999999999"), /belongs to another wallet/],
      [(c) => void (c.tradable = false), /no longer allows WETH/],
    ];
    for (const [breakIt, reason] of cases) {
      await wipe();
      const chain = new PretendChain();
      const agent = await launch(chain);
      breakIt(chain);
      expect(await run(chain, agent.id, H0)).toMatchObject({ skipped: true });
      const fresh = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(fresh.status).toBe("paused");
      expect(fresh.pausedReason).toMatch(reason);
      expect(chain.asked).toBe(0);
      expect(await decisions(agent.id)).toHaveLength(0);
    }
  });

  it("a speck of a token sent to the vault is not a position", async () => {
    const chain = new PretendChain();
    chain.token = 1000n; // a fraction of a cent of WETH from a stranger
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "buy", flowUsd: null });
  });

  it("sells the whole position when the stop is hit, and books the dollars that arrived", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const bought = chain.token;
    // Pretend the position was bought far higher, so the stop loss is hit now.
    await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: open(H0 + HOUR_MS) * 1.3 } });
    const cashBefore = fromUnits(chain.stable, 6);
    await run(chain, agent.id, H0 + HOUR_MS);

    expect(chain.done[1]!.req).toMatchObject({ tokenIn: WETH.address, tokenOut: LIVE_STABLE.address, amountIn: bought });
    expect(chain.token).toBe(0n);
    const d = (await decisions(agent.id))[1]!;
    expect(d).toMatchObject({ action: "sell", fillSide: "sell", qtyAfter: 0, txHash: chain.done[1]!.out.txHash });
    expect(d.explanation).toMatch(/^Sell\. Stop loss reached/);
    expect(d.cashAfter).toBeCloseTo(fromUnits(chain.stable, 6), 6);
    expect(d.fillNotional! - d.fillFee!).toBeCloseTo(fromUnits(chain.stable, 6) - cashBefore, 6);
  });

  it("an order left open in an earlier hour is booked for that hour before the next decision", async () => {
    const chain = new PretendChain();
    chain.drop = "afterSend";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    chain.drop = null;

    await run(chain, agent.id, H0 + HOUR_MS);
    const ds = await decisions(agent.id);
    expect(ds.map((d) => d.hour.getTime())).toEqual([H0, H0 + HOUR_MS]);
    expect(ds[0]).toMatchObject({ action: "buy", txHash: chain.done[0]!.out.txHash });
    // The earlier trade is a trade, not a deposit or a withdrawal.
    expect(ds[1]).toMatchObject({ action: "hold", flowUsd: null });
    expect(chain.asked).toBe(1);
  });

  it("the paper runner refuses a live agent, and the tick sends it to the live runner", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await expect(runAgentHours(agent.id, H0, { prisma, feeds, now: at(H0) })).rejects.toThrow(/not a paper agent/);

    // Without chain access the live agent is left alone.
    chain.price = open(H0);
    await tick({ prisma, feeds, now: at(H0) });
    expect(await decisions(agent.id)).toHaveLength(0);
    await tick({ prisma, feeds, chain, now: at(H0) });
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "buy" });
    expect(chain.asked).toBe(1);
  });
});

describe("token units", () => {
  it("never rounds an order up", () => {
    expect(toUnits(100, 6)).toBe(100_000_000n);
    expect(toUnits(0.1 + 0.2, 6)).toBe(300_000n);
    expect(toUnits(1.9999999, 6)).toBe(1_999_999n);
    expect(toUnits(0, 6)).toBe(0n);
    expect(toUnits(Number.NaN, 6)).toBe(0n);
    expect(fromUnits(1_234_567n, 6)).toBeCloseTo(1.234567, 12);
    expect(fromUnits(10n ** 18n + 5n * 10n ** 17n, 18)).toBeCloseTo(1.5, 12);
    for (const v of [0.000001, 12.345678, 999.999999, 123456.654321]) expect(fromUnits(toUnits(v, 6), 6)).toBeLessThanOrEqual(v);
  });
});
