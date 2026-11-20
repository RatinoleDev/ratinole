/**
 * One live agent, one hour, real money.
 *
 * The decision is made exactly as on paper. What differs is everything around it:
 *  - The position is read from the vault on-chain, never assumed. Money the owner moved in or out since the last
 *    decision is recorded as a flow and never counted as a gain or a loss.
 *  - A wanted trade becomes one order. The order is written down before it is sent, so a crash or a retry
 *    finishes that order instead of sending a second one.
 *  - The stored decision carries what really happened: the transaction, the real amounts, or why it failed.
 *  - Orders are only placed for the current hour, early in the hour. Hours missed while the engine was down are
 *    never traded after the fact.
 */
import { HOUR_MS, decide, requiredWarmup, type AgentParams, type Candle, type LiveFill, type Plan, type PositionState } from "@rationale/brain";
import { LIVE, LIVE_STABLE, LIVE_TOKENS, fromUnits, isMarketId, toUnits, type Address } from "@rationale/config";
import type { LiveOrder, Prisma } from "@rationale/db";
import type { Hex } from "viem";
import { log } from "../log";
import { loadCandles } from "../market/candles";
import { attachFunding, loadFunding } from "../market/funding";
import { FreshDataPendingError, LATE_AFTER_MS, WAIT_FOR_CANDLE_MS, stateRow, toState, type AgentRunResult, type EngineDeps } from "../runAgent";
import { OrderPendingError, type SwapOutcome, type SwapRequest, type VaultChain } from "./chain";

/** A token balance worth less than this is not a position: anyone can send a vault a speck of a token. */
const DUST_USD = 1;
/** A move of less than this between two decisions is rounding, not a deposit or a withdrawal. */
const FLOW_MIN_USD = 0.01;
/** An order recorded but without a transaction is given this long to show up before it counts as never sent. */
const UNSENT_GRACE_MS = 3 * 60_000;
/** A sent order the chain still does not know after this long counts as dropped. */
const DROPPED_AFTER_MS = 15 * 60_000;

const lower = (a: string) => a.toLowerCase() as Address;

function requestOf(o: Pick<LiveOrder, "vault" | "tokenIn" | "tokenOut" | "amountIn">, feeTier: number): SwapRequest {
  return { vault: lower(o.vault), tokenIn: lower(o.tokenIn), tokenOut: lower(o.tokenOut), feeTier, amountIn: BigInt(o.amountIn) };
}

/** Finish an order left open by an earlier attempt. Throws OrderPendingError while its fate is not known yet. */
async function settleOpenOrder(order: LiveOrder, feeTier: number, chain: VaultChain, now: number): Promise<SwapOutcome> {
  const age = now - order.createdAt.getTime();
  const req = requestOf(order, feeTier);
  if (order.txHash) {
    const known = await chain.outcomeOf(order.txHash as Hex, req.vault);
    if (known) return known;
    if (age < DROPPED_AFTER_MS) throw new OrderPendingError(`Order ${order.txHash} is not confirmed yet`);
  }
  // No transaction on record, or one the chain never saw: look for the swap itself.
  const found = await chain.findSwap(req, BigInt(order.fromBlock));
  if (found) return found;
  if (age < UNSENT_GRACE_MS) throw new OrderPendingError("An order may still be on its way");
  return { ok: false, reason: order.txHash ? "the chain never confirmed the order" : "the order was not sent", txHash: (order.txHash as Hex | null) ?? undefined };
}

async function closeOrder(prisma: EngineDeps["prisma"], id: string, out: SwapOutcome) {
  await prisma.liveOrder.update({
    where: { id },
    data: out.ok
      ? { status: "done", txHash: out.txHash, amountOut: out.amountOut.toString(), error: null }
      : { status: "failed", error: out.reason, ...(out.txHash ? { txHash: out.txHash } : {}) },
  });
}

/** The engine stops a live agent itself when its vault can no longer be traded, and says why. */
async function pause(prisma: EngineDeps["prisma"], agentId: string, reason: string): Promise<AgentRunResult> {
  await prisma.agent.update({ where: { id: agentId }, data: { status: "paused", pausedReason: reason } });
  log("warn", "live agent paused", { agentId, reason });
  return { agentId, decided: 0, late: 0, skipped: true, reason };
}

export async function runLiveAgentHour(
  agentId: string,
  hour: number,
  deps: EngineDeps & { chain: VaultChain },
  /** Finishing an order left open in an earlier hour: that hour is booked even if the agent was paused since. */
  settling = false,
): Promise<AgentRunResult> {
  const { prisma, chain } = deps;
  const now = (deps.now ?? Date.now)();
  const skip = (reason: string): AgentRunResult => ({ agentId, decided: 0, late: 0, skipped: true, reason });

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { state: true, user: { select: { address: true } } } });
  if (!agent) return skip("not found");
  if (agent.mode !== "live" || !agent.vault) throw new Error(`Agent ${agentId} is not a live agent`);
  if (agent.status !== "active") return skip(agent.status);
  if (!settling && agent.owedFrom.getTime() > hour) return skip("not owed yet");
  if (!agent.state) throw new Error(`Live agent ${agentId} has no stored position`);
  if (!isMarketId(agent.market)) throw new Error(`No live token for market ${agent.market}`);
  const token = LIVE_TOKENS[agent.market];
  const vault = lower(agent.vault);

  // An order left open in an earlier hour is finished and booked first, so its trade is never mistaken for a
  // deposit or a withdrawal.
  const stale = await prisma.liveOrder.findFirst({ where: { agentId, status: "pending", hour: { lt: new Date(hour) } }, orderBy: { hour: "asc" } });
  if (stale) await runLiveAgentHour(agentId, stale.hour.getTime(), deps, true);

  const already = await prisma.decision.findUnique({ where: { agentId_hour: { agentId, hour: new Date(hour) } }, select: { id: true } });
  if (already) return skip("up to date");
  const fresh = stale ? await prisma.agent.findUnique({ where: { id: agentId }, include: { state: true } }) : agent;
  if (!fresh?.state) throw new Error(`Live agent ${agentId} has no stored position`);
  const stored = fresh.state;

  const plan = agent.plan as unknown as Plan;
  const params = agent.params as unknown as AgentParams;
  const warmup = requiredWarmup(plan) + 24;
  const set = await loadCandles(agent.market, hour - warmup * HOUR_MS, hour + HOUR_MS, deps);
  const funding = deps.funding ? await loadFunding(deps.funding, agent.market, hour - warmup * HOUR_MS, hour + 2 * HOUR_MS, deps) : new Map<number, number>();
  const candles = attachFunding(set.candles, funding);
  const byTime = new Map<number, Candle>(candles.map((c) => [c.t, c]));
  const lastClosed = byTime.get(hour - HOUR_MS);
  const fillPrice = byTime.get(hour)?.o ?? null;
  if ((!lastClosed || fillPrice == null) && now - hour < WAIT_FOR_CANDLE_MS) {
    throw new FreshDataPendingError(`Candle for ${new Date(hour).toISOString()} not available yet (${agent.market})`);
  }
  const closedBefore = candles.filter((c) => c.t + HOUR_MS <= hour);
  const lastCandle = closedBefore[closedBefore.length - 1];
  if (!lastCandle) throw new Error(`No candles for ${agent.market}`);
  const mark = fillPrice ?? lastCandle.c;

  const snap = await chain.snapshot(vault, token.address);
  if (snap.owner !== lower(agent.user.address)) return pause(prisma, agentId, "The vault now belongs to another wallet, so this agent was stopped.");
  if (snap.operator !== chain.operator) {
    return pause(prisma, agentId, "The agent's access to the vault was revoked. Restore it on the Vault page, then resume this agent.");
  }
  if (!snap.tradable) return pause(prisma, agentId, `The vault no longer allows ${token.symbol} trades. Allow the token again, then resume this agent.`);

  // This hour's order, if an earlier attempt already recorded one.
  let order = await prisma.liveOrder.findUnique({ where: { agentId_hour: { agentId, hour: new Date(hour) } } });
  let outcome: SwapOutcome | null = null;
  if (order) {
    if (order.status === "pending") {
      outcome = await settleOpenOrder(order, snap.feeTier, chain, now);
      await closeOrder(prisma, order.id, outcome);
    } else if (order.status === "done" && order.txHash && order.amountOut) {
      outcome = { ok: true, txHash: order.txHash as Hex, amountIn: BigInt(order.amountIn), amountOut: BigInt(order.amountOut) };
    } else {
      outcome = { ok: false, reason: order.error ?? "the order failed", txHash: (order.txHash as Hex | null) ?? undefined };
    }
  }

  // The vault as it stood before this hour's order, if there was one.
  let stableRaw = snap.stable;
  let tokenRaw = snap.token;
  if (order && outcome?.ok) {
    if (order.side === "buy") {
      stableRaw += outcome.amountIn;
      tokenRaw -= outcome.amountOut;
    } else {
      tokenRaw += outcome.amountIn;
      stableRaw -= outcome.amountOut;
    }
  }
  const cash = fromUnits(stableRaw, LIVE_STABLE.decimals);
  const held = fromUnits(tokenRaw < 0n ? 0n : tokenRaw, token.decimals);
  const qty = held * mark < DUST_USD ? 0 : held;
  const equityNow = cash + qty * mark;
  if (!order && equityNow < DUST_USD) return pause(prisma, agentId, "The vault is empty, so this agent was stopped. Deposit, then resume it.");

  // Deposits and withdrawals since the last decision. The agent's base (startingCash) moves with them the way a
  // fund issues and redeems units, so the return is never changed by money coming in or going out.
  const before = toState(stored);
  const equityBefore = before.cash + before.qty * mark;
  const rawFlow = equityNow - equityBefore;
  const flowUsd = Math.abs(rawFlow) < FLOW_MIN_USD ? 0 : rawFlow;
  const basis = fresh.startingCash;
  let newBasis = basis;
  if (flowUsd !== 0) {
    const lastDecision = await prisma.decision.findFirst({ where: { agentId }, orderBy: { hour: "desc" }, select: { equityAfter: true, basisAfter: true } });
    const lastNav = lastDecision?.basisAfter && lastDecision.equityAfter > 0 ? lastDecision.equityAfter / lastDecision.basisAfter : 1;
    const nav = equityBefore >= DUST_USD && basis > 0 ? equityBefore / basis : lastNav;
    newBasis = Math.max(equityNow > 0 ? 1e-9 : 0, basis + flowUsd / nav);
    if (equityBefore < DUST_USD) newBasis = equityNow / nav;
  }
  const scale = basis > 0 ? newBasis / basis : 1;
  const state: PositionState = {
    ...before,
    cash,
    qty,
    avgEntry: qty === 0 ? null : before.qty === 0 ? mark : before.avgEntry,
    peak: qty === 0 ? null : before.qty === 0 ? mark : before.peak,
    dayStartEquity: before.dayStartEquity * scale,
  };

  const ctx = {
    agentId,
    plan,
    params,
    limits: { maxSizePct: agent.maxSizePct, dailyLossCapPct: agent.dailyLossCapPct },
    costPct: LIVE.costPct,
    market: agent.market,
    sources: funding.size && deps.funding ? { funding: deps.funding.label } : undefined,
  };
  const want = decide(ctx, { candles, hour, state, fillPrice });

  if (order && outcome?.ok && want.fill?.side !== order.side) {
    // An order went through that this decision no longer asks for. Do not guess: stop and let a person look.
    throw new Error(`Agent ${agentId}: order ${order.id} (${order.side}) does not match the decision for ${new Date(hour).toISOString()}`);
  }

  if (want.fill && !order) {
    if (now - hour > LIVE.orderWindowMs) {
      outcome = { ok: false, reason: `this run was late, and live orders are only placed in the first ${LIVE.orderWindowMs / 60_000} minutes of an hour` };
    } else {
      const buying = want.fill.side === "buy";
      const wanted = buying ? toUnits(want.fill.notional, LIVE_STABLE.decimals) : snap.token;
      const amountIn = buying && wanted > snap.stable ? snap.stable : wanted;
      if (amountIn <= 0n) {
        outcome = { ok: false, reason: "there was nothing to trade" };
      } else {
        const req: SwapRequest = {
          vault,
          tokenIn: buying ? LIVE_STABLE.address : token.address,
          tokenOut: buying ? token.address : LIVE_STABLE.address,
          feeTier: snap.feeTier,
          amountIn,
        };
        const fromBlock = await chain.blockNumber();
        order = await prisma.liveOrder.create({
          data: { agentId, hour: new Date(hour), side: want.fill.side, vault, tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: amountIn.toString(), fromBlock: fromBlock.toString() },
        });
        const orderId = order.id;
        outcome = await chain.swap(req, async (txHash) => {
          await prisma.liveOrder.update({ where: { id: orderId }, data: { txHash } });
        });
        await closeOrder(prisma, orderId, outcome);
        log(outcome.ok ? "info" : "warn", "live order", { agentId, side: want.fill.side, ok: outcome.ok, txHash: outcome.txHash, reason: outcome.ok ? undefined : outcome.reason });
      }
    }
  }

  // Book what really happened. The pool fee is taken from what goes in.
  const feeRate = snap.feeTier / 1_000_000;
  let liveFill: LiveFill | undefined;
  if (want.fill && outcome) {
    if (!outcome.ok) liveFill = { ok: false, reason: outcome.reason };
    else if (want.fill.side === "buy") {
      const notional = fromUnits(outcome.amountIn, LIVE_STABLE.decimals);
      liveFill = { ok: true, side: "buy", notional, qty: fromUnits(outcome.amountOut, token.decimals), fee: notional * feeRate };
    } else {
      const received = fromUnits(outcome.amountOut, LIVE_STABLE.decimals);
      const gross = received / (1 - feeRate);
      liveFill = { ok: true, side: "sell", qty: fromUnits(outcome.amountIn, token.decimals), notional: gross, fee: gross - received };
    }
  }
  const out = liveFill ? decide(ctx, { candles, hour, state, fillPrice, liveFill }) : want;
  const d = out.decision;

  const holdEntry = fresh.holdEntryPrice ?? mark;
  const holdingEquity = newBasis * (1 - LIVE.costPct / 100) * (out.markPrice / holdEntry);
  const isLate = now - hour > LATE_AFTER_MS;
  const lastHour = stored.lastHour?.getTime() ?? null;
  const peak = Math.max((stored.peakEquity ?? basis) * scale, out.equity);
  const maxDd = Math.min(stored.maxDrawdownPct, peak > 0 ? (out.equity / peak - 1) * 100 : 0);

  const saved = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`;
    const exists = await tx.decision.findUnique({ where: { agentId_hour: { agentId, hour: new Date(hour) } }, select: { id: true } });
    if (exists) return false;
    const current = await tx.agentState.findUnique({ where: { agentId }, select: { lastHour: true } });
    if ((current?.lastHour?.getTime() ?? null) !== lastHour) return false;
    await tx.decision.create({
      data: {
        agentId,
        hour: new Date(hour),
        action: d.action,
        confidence: d.confidence,
        regime: d.regime,
        evidence: d.evidence as unknown as Prisma.InputJsonValue,
        guard: d.guard as unknown as Prisma.InputJsonValue,
        explanation: d.explanation,
        late: isLate,
        txHash: outcome?.txHash ?? null,
        execError: outcome && !outcome.ok ? outcome.reason : null,
        flowUsd: flowUsd === 0 ? null : flowUsd,
        basisAfter: newBasis,
        fillSide: out.fill?.side ?? null,
        fillPrice: out.fill?.price ?? null,
        fillQty: out.fill?.qty ?? null,
        fillNotional: out.fill?.notional ?? null,
        fillFee: out.fill?.fee ?? null,
        cashAfter: out.state.cash,
        qtyAfter: out.state.qty,
        equityAfter: out.equity,
        holdingEquityAfter: holdingEquity,
        markPrice: out.markPrice,
        candleSource: set.sourceLabel,
        candleTime: new Date(lastCandle.t),
      },
    });
    await tx.agentState.update({
      where: { agentId },
      data: {
        ...stateRow(out.state),
        decisions: stored.decisions + 1,
        lastHour: new Date(hour),
        lastEquity: out.equity,
        lastHoldingEquity: holdingEquity,
        peakEquity: peak,
        maxDrawdownPct: maxDd,
      },
    });
    await tx.agent.update({ where: { id: agentId }, data: { startingCash: newBasis, holdEntryPrice: holdEntry } });
    return true;
  });
  if (!saved) {
    log("info", "live agent moved on by another worker", { agentId, hour: new Date(hour).toISOString() });
    return skip("moved on");
  }
  log("info", "live agent run", { agentId, action: d.action, txHash: outcome?.txHash, flowUsd: flowUsd || undefined, upTo: new Date(hour).toISOString() });
  return { agentId, decided: 1, late: isLate ? 1 : 0, skipped: false };
}
