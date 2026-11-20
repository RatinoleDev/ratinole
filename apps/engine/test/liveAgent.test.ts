/**
 * Live agents against a pretend chain: a vault with balances, a price, and switches for everything that can go
 * wrong around an order. The database is real (the test database).
 */
import { HOUR_MS, type Plan } from "@rationale/brain";
import { LIVE_STABLE, LIVE_TOKENS, fromUnits, toUnits, type Address, type LiveToken } from "@rationale/config";
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
  /** What the vault still lets the operator trade today, in dollars. */
  remainingUsd = 100_000;
  block = 100n;
  /** Every order that reached the chain. */
  done: { req: SwapRequest; out: Extract<SwapOutcome, { ok: true }> }[] = [];
  /** How many times an order was asked for. */
  asked = 0;
  refuse: string | null = null;
  /** The chain cannot be reached while the order is being prepared: nothing is signed. */
  unreachable = 0;
  /** "afterSend": the order lands, but the connection drops before the answer. "lost": it never reaches the chain. */
  drop: "afterSend" | "lost" | null = null;
  /** Runs after the order is prepared and before its hash is handed over, like a slow worker. */
  beforeSign: (() => Promise<void>) | null = null;
  /** Runs while the vault is being read, like an owner acting at that moment. */
  duringRead: (() => Promise<void>) | null = null;
  /** The chain cannot be asked about transactions right now. */
  lookupDown = false;
  /** This connection has not seen the latest blocks yet. */
  behind = false;
  private nonce = 0;

  async blockNumber() {
    return this.block;
  }
  async snapshot(_vault: Address, _token: LiveToken, atLeastBlock?: bigint): Promise<VaultSnapshot> {
    if (this.behind && atLeastBlock != null) throw new OrderPendingError("behind");
    await this.duringRead?.();
    return {
      block: this.block,
      owner: this.owner,
      operator: this.vaultOperator,
      paused: this.paused,
      stable: this.stable,
      token: this.token,
      tradable: this.tradable,
      feeTier: this.feeTier,
      remainingUsd: this.remainingUsd,
      priceUsd: this.price,
    };
  }
  private execute(req: SwapRequest, txHash: Hex): Extract<SwapOutcome, { ok: true }> {
    const fee = this.feeTier / 1_000_000;
    const buying = req.tokenIn === LIVE_STABLE.address;
    let amountOut: bigint;
    if (buying) {
      amountOut = toUnits((fromUnits(req.amountIn, 6) * (1 - fee)) / this.price, WETH.decimals);
      this.stable -= req.amountIn;
      this.token += amountOut;
      this.remainingUsd -= fromUnits(req.amountIn, 6);
    } else {
      amountOut = toUnits(fromUnits(req.amountIn, WETH.decimals) * this.price * (1 - fee), 6);
      this.token -= req.amountIn;
      this.stable += amountOut;
      this.remainingUsd -= fromUnits(req.amountIn, WETH.decimals) * this.price;
    }
    const out = { ok: true as const, txHash, amountIn: req.amountIn, amountOut, block: ++this.block };
    this.done.push({ req, out });
    return out;
  }
  /** Like the real client: the hash exists, and is handed over, before anything is sent. */
  async swap(req: SwapRequest, onSigned: (h: Hex) => Promise<void>): Promise<SwapOutcome> {
    this.asked++;
    if (this.unreachable > 0) {
      this.unreachable--;
      throw new Error("fetch failed");
    }
    if (this.refuse) return { ok: false, reason: this.refuse };
    // The vault itself refuses an order worth more than what is left of its daily limit.
    const value = req.tokenIn === LIVE_STABLE.address ? fromUnits(req.amountIn, 6) : fromUnits(req.amountIn, WETH.decimals) * this.price;
    if (value > this.remainingUsd) return { ok: false, reason: "the vault's daily trading limit is used up" };
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
      [(c) => void (c.tradable = false), /settings for WETH were changed/],
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

  it("books an order that went through even if the run that placed it never wrote its decision, and does not buy again", async () => {
    const chain = new PretendChain();
    chain.drop = "afterSend";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    chain.drop = null;
    // A later attempt found the receipt and closed the order, then died before storing the decision.
    const open = await prisma.liveOrder.findFirstOrThrow();
    await prisma.liveOrder.update({ where: { id: open.id }, data: { status: "done", amountOut: chain.done[0]!.out.amountOut.toString() } });

    await run(chain, agent.id, H0 + HOUR_MS);
    const ds = await decisions(agent.id);
    expect(ds.map((d) => d.hour.getTime())).toEqual([H0, H0 + HOUR_MS]);
    expect(ds[0]).toMatchObject({ action: "buy", txHash: chain.done[0]!.out.txHash, fillNotional: 100 });
    expect(ds[1]).toMatchObject({ action: "hold", flowUsd: null });
    // The second hour sees the position the first order bought: it holds, and does not buy a second time.
    expect(ds[1]!.explanation).toMatch(/^Hold\. In position/);
    expect(ds[1]!.qtyAfter).toBeCloseTo(fromUnits(chain.done[0]!.out.amountOut, 18), 12);
    expect(chain.asked).toBe(1);
  });

  it("books an interrupted order as it happened when the decision worked out later no longer asks for it", async () => {
    const chain = new PretendChain();
    // No buy is due: the plan bought an hour ago. An order of this hour went through all the same.
    const agent = await launch(chain);
    await prisma.agentState.update({ where: { agentId: agent.id }, data: { lastBuyAt: new Date(H0 - HOUR_MS) } });
    chain.price = open(H0);
    const amountIn = usdg(100);
    const txHash = `0x${"7".repeat(64)}` as Hex;
    const amountOut = toUnits((100 * (1 - 0.0005)) / chain.price, 18);
    chain.stable -= amountIn;
    chain.token += amountOut;
    chain.done.push({ req: { vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: WETH.address, feeTier: 500, amountIn }, out: { ok: true, txHash, amountIn, amountOut, block: 101n } });
    await prisma.liveOrder.create({
      data: { agentId: agent.id, hour: new Date(H0), side: "buy", vault: VAULT, tokenIn: LIVE_STABLE.address, tokenOut: WETH.address, amountIn: amountIn.toString(), fromBlock: "100", txHash, status: "pending", createdAt: new Date(H0 + 60_000) },
    });
    await run(chain, agent.id, H0, 4);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "buy", txHash, fillNotional: 100 });
    expect(d!.explanation).toMatch(/^Buy\. This order was placed earlier in the hour by a run that was interrupted/);
    expect(d!.cashAfter).toBeCloseTo(900, 6);
    expect(d!.qtyAfter).toBeCloseTo(fromUnits(amountOut, 18), 12);
    expect(chain.asked).toBe(0);
  });

  it("sells as much as the vault's daily limit allows when the whole position is over it, and the rest later", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const bought = chain.token;
    await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: open(H0 + HOUR_MS) * 1.3 } });
    chain.remainingUsd = 40; // the position is worth about $100
    await run(chain, agent.id, H0 + HOUR_MS);
    const d = (await decisions(agent.id))[1]!;
    expect(d.action).toBe("sell");
    expect(chain.done[1]!.req.amountIn).toBeLessThan(bought);
    expect(fromUnits(chain.done[1]!.req.amountIn, 18) * open(H0 + HOUR_MS)).toBeLessThanOrEqual(40);
    expect(d.qtyAfter).toBeGreaterThan(0);
    expect(d.explanation).toMatch(/allowed only part of the position to be sold/);
    // Next hour the limit has room again: the rest goes.
    chain.remainingUsd = 100_000;
    await prisma.agentState.update({ where: { agentId: agent.id }, data: { avgEntry: open(H0 + 2 * HOUR_MS) * 1.3 } });
    await run(chain, agent.id, H0 + 2 * HOUR_MS);
    expect((await decisions(agent.id))[2]).toMatchObject({ action: "sell", qtyAfter: 0 });
    expect(chain.token).toBe(0n);
  });

  it("makes a buy smaller to fit the daily limit, and says so; with no room left it does not send at all", async () => {
    const chain = new PretendChain();
    chain.remainingUsd = 50;
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const [d] = await decisions(agent.id);
    expect(d!.action).toBe("buy");
    expect(d!.fillNotional).toBeCloseTo(49, 6);
    expect(d!.explanation).toMatch(/Bought \$49\.00 of ETH at \$[\d,.]+\. The vault's daily trading limit made this order smaller than planned\.$/);

    await wipe();
    const none = new PretendChain();
    none.remainingUsd = 0.5;
    const second = await launch(none);
    await run(none, second.id, H0);
    expect(none.asked).toBe(0);
    expect((await decisions(second.id))[0]).toMatchObject({ action: "hold", execError: "the vault's daily trading limit is used up" });
  });

  it("when the chain cannot be reached before anything is signed, the hour is tried again, not written off", async () => {
    const chain = new PretendChain();
    chain.unreachable = 1;
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(/fetch failed/);
    expect(await decisions(agent.id)).toHaveLength(0);
    expect(await prisma.liveOrder.count()).toBe(0);
    await run(chain, agent.id, H0, 3);
    expect(chain.done).toHaveLength(1);
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "buy", execError: null });
  });

  it("does not place an order smaller than its minimum, so a buy can never fall under the dust line", async () => {
    const chain = new PretendChain();
    chain.stable = usdg(8); // a tenth of it would be 80 cents
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    expect(chain.asked).toBe(0);
    const [d] = await decisions(agent.id);
    expect(d).toMatchObject({ action: "hold", execError: "the order would be smaller than the $1.00 minimum" });
  });

  it("tokens the owner deposits count as bought at that hour's price", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    const own = fromUnits(chain.token, 18);
    const entry = (await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } })).avgEntry!;
    chain.token += toUnits(1, 18); // the owner sends a whole ETH to the vault
    await run(chain, agent.id, H0 + HOUR_MS);
    const d = (await decisions(agent.id))[1]!;
    const mark = open(H0 + HOUR_MS);
    expect(d.flowUsd).toBeCloseTo(mark, 4);
    const state = await prisma.agentState.findUniqueOrThrow({ where: { agentId: agent.id } });
    expect(state.avgEntry).toBeCloseTo((entry * own + mark * 1) / (own + 1), 6);
    // No stop or target is hit by the deposit itself.
    expect(d.action).toBe("hold");
  });

  it("does not send an order if the owner paused or deleted the agent while the vault was being read", async () => {
    for (const status of ["paused", "archived"]) {
      await wipe();
      const chain = new PretendChain();
      const agent = await launch(chain);
      chain.duringRead = async () => void (await prisma.agent.update({ where: { id: agent.id }, data: { status } }));
      expect(await run(chain, agent.id, H0)).toMatchObject({ skipped: true, reason: status });
      expect(chain.asked).toBe(0);
      expect(await decisions(agent.id)).toHaveLength(0);
    }
  });

  it("stopping an agent never brings a deleted one back", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    chain.stable = 0n;
    chain.duringRead = async () => void (await prisma.agent.update({ where: { id: agent.id }, data: { status: "archived" } }));
    await run(chain, agent.id, H0);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ status: "archived", pausedReason: null });
  });

  it("books an order first, then stops, when the agent's access was revoked right after the order", async () => {
    const chain = new PretendChain();
    chain.drop = "afterSend";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    chain.drop = null;
    chain.vaultOperator = "0x0000000000000000000000000000000000000000";
    await run(chain, agent.id, H0, 4);
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "buy", txHash: chain.done[0]!.out.txHash });
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ status: "paused", pausedReason: expect.stringMatching(/access to the vault was revoked/) });
  });

  it("waits for a connection that has not caught up with the order's block instead of reading an old vault", async () => {
    const chain = new PretendChain();
    chain.drop = "afterSend";
    const agent = await launch(chain);
    await expect(run(chain, agent.id, H0)).rejects.toThrow(OrderPendingError);
    chain.drop = null;
    chain.behind = true;
    await expect(run(chain, agent.id, H0, 3)).rejects.toThrow(OrderPendingError);
    expect(await decisions(agent.id)).toHaveLength(0);
    chain.behind = false;
    await run(chain, agent.id, H0, 4);
    expect((await decisions(agent.id))[0]).toMatchObject({ action: "buy", flowUsd: null });
  });

  it("two runs of the same agent at once place one order", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    chain.price = open(H0);
    const deps = { prisma, feeds, chain, now: at(H0) };
    const both = await Promise.all([runLiveAgentHour(agent.id, H0, deps), runLiveAgentHour(agent.id, H0, deps)]);
    expect(both.filter((r) => r.decided === 1)).toHaveLength(1);
    expect(chain.asked).toBe(1);
    expect(await decisions(agent.id)).toHaveLength(1);
  });

  it("never goes back to an hour older than the last one decided", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0 + HOUR_MS);
    expect(await run(chain, agent.id, H0)).toMatchObject({ skipped: true, reason: "not owed yet" });
    // Even if the record of what is owed were wrong, the stored position refuses the older hour.
    await prisma.agent.update({ where: { id: agent.id }, data: { owedFrom: new Date(H0) } });
    expect(await run(chain, agent.id, H0)).toMatchObject({ skipped: true, reason: "older than the last decision" });
    expect(chain.asked).toBe(1);
    expect(await decisions(agent.id)).toHaveLength(1);
  });

  it("stops counting hours it will never trade as owed", async () => {
    const chain = new PretendChain();
    const agent = await launch(chain);
    await run(chain, agent.id, H0);
    // The engine was down for three hours.
    await run(chain, agent.id, H0 + 4 * HOUR_MS);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).owedFrom.getTime()).toBe(H0 + 4 * HOUR_MS);
    expect(await decisions(agent.id)).toHaveLength(2);
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
