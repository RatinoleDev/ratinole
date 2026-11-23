/**
 * One live agent, one hour, real money.
 *
 * The decision is made exactly as on paper. What differs is everything around it:
 *  - The position is read from the vault on-chain, never assumed. Money the owner moved in or out since the last
 *    decision is recorded as a flow and never counted as a gain or a loss.
 *  - A wanted trade becomes one order. The order is written down before it is signed, and its transaction hash
 *    before it is sent, so a crash or a retry finishes that order instead of sending a second one.
 *  - An order that exists is always booked, whatever happened to the run that placed it.
 *  - The stored decision carries what really happened: the transaction, the real amounts, or why it failed.
 *  - Orders are only placed for the current hour, early in the hour. Hours missed while the engine was down are
 *    never traded after the fact. Every order carries a deadline the vault itself enforces, so a signed order
 *    cannot trade later than that either, whatever happens to it on the way.
 *  - One run at a time per agent.
 */
import {
  HOUR_MS,
  decide,
  equityOf,
  hasExit,
  qtyText,
  requiredWarmup,
  settleBuy,
  settleSell,
  staysOpen,
  usd,
  type AgentParams,
  type Candle,
  type LiveFill,
  type Plan,
  type PositionState,
  type StepOutput,
} from "@rationale/brain";
import { LIVE, LIVE_STABLE, LIVE_TOKENS, fromUnits, isMarketId, orderDeadline, strayTokensArePosition, toUnits, type Address } from "@rationale/config";
import type { LiveOrder, Prisma } from "@rationale/db";
import type { Hex } from "viem";
import { log } from "../log";
import { loadCandles } from "../market/candles";
import { attachFunding, loadFunding } from "../market/funding";
import { FreshDataPendingError, LATE_AFTER_MS, WAIT_FOR_CANDLE_MS, isExitKind, stateRow, toState, type AgentRunResult, type EngineDeps } from "../runAgent";
import { OrderPendingError, type SwapOutcome, type SwapRequest, type VaultChain } from "./chain";

/** A vault worth less than this is empty. */
const EMPTY_USD = 1;
/** A move of less than this between two decisions is rounding, not a deposit or a withdrawal. */
const FLOW_MIN_USD = 0.01;
/**
 * An order with no transaction on record was never signed, so nothing was sent. It is given this long before it
 * is closed as "not sent", in case another worker is in the middle of signing it; closing it stops that worker.
 */
const UNSENT_GRACE_MS = 3 * 60_000;
/**
 * A signed order the chain does not know is only written off once the chain's own clock is this many seconds past
 * the order's deadline. From then on the vault refuses it, so "it never happened" is a fact, not a guess.
 */
const DEAD_MARGIN_S = 120;

/** Another worker closed the order while this one was preparing it. Nothing was sent. */
class OrderWithdrawnError extends Error {}
/** The order was ready to send only after its window had closed. Nothing was sent. */
class OrderLateError extends Error {}
const LATE = `this run was late, and live orders are only placed in the first ${LIVE.orderWindowMs / 60_000} minutes of an hour`;

const lower = (a: string) => a.toLowerCase() as Address;
type Deps = EngineDeps & {
  chain: VaultChain;
  /**
   * When an order placed for an hour stops being valid (unix seconds). Left out everywhere but in rehearsals on a
   * copy of the chain, whose clock is today's while the hours being replayed are already over.
   */
  orderDeadline?: (hourMs: number) => number;
};

/** One run at a time per agent in this process, so two hours of the same agent can never overlap. */
const turns = new Map<string, Promise<unknown>>();
function oneAtATime<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const run = (turns.get(agentId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  turns.set(agentId, tail);
  void tail.then(() => {
    if (turns.get(agentId) === tail) turns.delete(agentId);
  });
  return run;
}

/**
 * Finish an order left open by an earlier attempt. A transaction's hash is always written down before it is sent,
 * so the hash alone says what happened. Throws OrderPendingError while that is not known yet.
 */
async function settleOpenOrder(order: LiveOrder, chain: VaultChain, now: number, deadline: number): Promise<SwapOutcome> {
  const age = now - order.createdAt.getTime();
  if (!order.txHash) {
    if (age < UNSENT_GRACE_MS) throw new OrderPendingError("An order is still being prepared");
    return { ok: false, reason: "the order was not sent" };
  }
  const hash = order.txHash as Hex;
  const known = await chain.outcomeOf(hash, lower(order.vault));
  if (known) return known;
  // Not known to the chain. It may still be on its way, and until its deadline it could still trade. Only the
  // chain's own clock can say that the deadline is behind us.
  if ((await chain.chainTime()) <= deadline + DEAD_MARGIN_S) throw new OrderPendingError(`Order ${hash} is not confirmed yet`);
  // Past its deadline: it can no longer trade. One more look, in case the first answer came from a node that was
  // behind the others.
  const again = await chain.outcomeOf(hash, lower(order.vault));
  if (again) return again;
  log("warn", "live order never confirmed", { agentId: order.agentId, orderId: order.id, txHash: hash });
  return { ok: false, reason: "the chain never confirmed the order", txHash: hash };
}

/**
 * Closes an order that is still open. False when another worker got there first. An order may only be closed as
 * never signed (`unsigned`) while it still has no transaction: a worker that has just signed it wins.
 */
async function closeOrder(prisma: EngineDeps["prisma"], id: string, out: SwapOutcome, unsigned = false): Promise<boolean> {
  const done = await prisma.liveOrder.updateMany({
    where: { id, status: "pending", ...(unsigned ? { txHash: null } : {}) },
    data: out.ok
      ? { status: "done", txHash: out.txHash, amountOut: out.amountOut.toString(), minedBlock: out.block.toString(), error: null }
      : { status: "failed", error: out.reason, ...(out.txHash ? { txHash: out.txHash } : {}) },
  });
  return done.count === 1;
}

/** The engine stops a live agent itself when its vault can no longer be traded, and says why. Never undoes a delete. */
async function pause(prisma: EngineDeps["prisma"], agentId: string, reason: string): Promise<AgentRunResult> {
  const done = await prisma.agent.updateMany({ where: { id: agentId, status: "active" }, data: { status: "paused", pausedReason: reason } });
  if (done.count) log("warn", "live agent paused", { agentId, reason });
  return { agentId, decided: 0, late: 0, skipped: true, reason };
}

export function runLiveAgentHour(agentId: string, hour: number, deps: Deps): Promise<AgentRunResult> {
  return oneAtATime(agentId, () => runHour(agentId, hour, deps, false));
}

/** `booking`: this hour has an order from an earlier run that was never booked. It is booked even if the agent was paused since. */
async function runHour(agentId: string, hour: number, deps: Deps, booking: boolean): Promise<AgentRunResult> {
  const { prisma, chain } = deps;
  const deadlineOf = deps.orderDeadline ?? orderDeadline;
  const clock = () => (deps.now ?? Date.now)();
  const now = clock();
  const skip = (reason: string): AgentRunResult => ({ agentId, decided: 0, late: 0, skipped: true, reason });

  const first = await prisma.agent.findUnique({ where: { id: agentId }, select: { mode: true, vault: true, status: true, owedFrom: true } });
  if (!first) return skip("not found");
  if (first.mode !== "live" || !first.vault) throw new Error(`Agent ${agentId} is not a live agent`);
  if (!booking) {
    const active = first.status === "active";
    // An order that never got its decision is booked first, oldest first, so its trade is on record and is never
    // mistaken for a deposit or a withdrawal. For an agent its owner has paused or deleted since, that includes
    // this hour's order: nothing new is placed for it, but what it already placed is real.
    for (let guard = 0; guard < 48; guard++) {
      const last = await prisma.decision.findFirst({ where: { agentId }, orderBy: { hour: "desc" }, select: { hour: true } });
      const unbooked = await prisma.liveOrder.findFirst({
        where: { agentId, hour: { ...(active ? { lt: new Date(hour) } : { lte: new Date(hour) }), ...(last ? { gt: last.hour } : {}) } },
        orderBy: { hour: "asc" },
      });
      if (!unbooked) break;
      const booked = await runHour(agentId, unbooked.hour.getTime(), deps, true);
      if (booked.decided === 0) throw new Error(`Agent ${agentId}: the order for ${unbooked.hour.toISOString()} could not be booked (${booked.reason ?? "unknown"})`);
    }
    if (!active) return skip(first.status);
    if (first.owedFrom.getTime() > hour) return skip("not owed yet");
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { state: true, user: { select: { address: true } } } });
  if (!agent?.state || !agent.vault) throw new Error(`Live agent ${agentId} has no stored position`);
  const stored = agent.state;
  if (await prisma.decision.findUnique({ where: { agentId_hour: { agentId, hour: new Date(hour) } }, select: { id: true } })) return skip("up to date");
  // Decisions are stored in order. An hour older than the last one decided is never gone back to.
  if (stored.lastHour && hour <= stored.lastHour.getTime()) return skip("older than the last decision");
  if (!isMarketId(agent.market)) throw new Error(`No live token for market ${agent.market}`);
  const token = LIVE_TOKENS[agent.market];
  const vault = lower(agent.vault);

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

  // This hour's order, if an earlier attempt already recorded one. It is settled BEFORE the vault is read, so the
  // reading that follows is known to include it.
  let order = await prisma.liveOrder.findUnique({ where: { agentId_hour: { agentId, hour: new Date(hour) } } });
  if (booking && !order) return skip("no order to book");
  /** Why the order was smaller than the plan asked for, if it was. Kept with the order, so a later run still says so. */
  let note: string | undefined = order?.note ?? undefined;
  let outcome: SwapOutcome | null = null;
  if (order) {
    if (order.status === "pending") {
      outcome = await settleOpenOrder(order, chain, now, deadlineOf(order.hour.getTime()));
      // If another worker closed it in the meantime, its verdict stands: start this hour again from the record.
      if (!(await closeOrder(prisma, order.id, outcome, !order.txHash))) throw new OrderPendingError("The order was settled by another worker");
    } else if (order.status === "done" && order.txHash && order.amountOut) {
      // The block it landed in is kept with the order, so that this read, too, waits for a connection that has seen it.
      outcome = { ok: true, txHash: order.txHash as Hex, amountIn: BigInt(order.amountIn), amountOut: BigInt(order.amountOut), block: BigInt(order.minedBlock ?? "0") };
    } else {
      outcome = { ok: false, reason: order.error ?? "the order failed", txHash: (order.txHash as Hex | null) ?? undefined };
    }
  }

  const snap = await chain.snapshot(vault, token, outcome?.ok && outcome.block > 0n ? outcome.block : undefined);
  // Reasons this vault may not be traded any more. With no order to book, the agent simply stops here.
  const stop =
    snap.owner !== lower(agent.user.address)
      ? "The vault now belongs to another wallet, so this agent was stopped."
      : snap.operator !== chain.operator
        ? "The agent's access to the vault was revoked. Restore it on the Vault page, then resume this agent."
        : !snap.tradable
          ? `The vault's settings for ${token.symbol} were changed (the token, its pool or its price feed), so this agent was stopped.`
          : null;
  if (stop && !order) return pause(prisma, agentId, stop);

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
  // If the owner moved money right after the order, these can dip below zero; that move is next hour's flow.
  if (stableRaw < 0n) stableRaw = 0n;
  if (tokenRaw < 0n) tokenRaw = 0n;
  let cash = fromUnits(stableRaw, LIVE_STABLE.decimals);
  const held = fromUnits(tokenRaw, token.decimals);
  const before = toState(stored);
  // What counts as the agent's position:
  //  - It has one on record: whatever of the token is in the vault now, unless so little is left that it could
  //    not be sold. (The owner may have added to it or taken from it; that is a flow, below.)
  //  - It has none on record: tokens in the vault are not its doing. They only count when they are worth one of
  //    the plan's own orders. Anything less is left alone until the agent next buys, so nobody can stop an agent
  //    from buying by sending its vault a few cents of the token.
  const heldUsd = held * mark;
  let qty = before.qty > 0 ? (heldUsd >= LIVE.positionFloorUsd ? held : 0) : strayTokensArePosition(heldUsd, cash, plan.sizePctOfCash) ? held : 0;
  let equityNow = cash + qty * mark;
  const EMPTY = "The vault is empty, so this agent was stopped. Deposit, then resume it.";
  // The vault was seen empty at this hour. That is written down (the stored position is zeroed): if the owner
  // deposits and resumes later, the money that left is then valued as of now, not at whatever the price is on the
  // day they come back.
  const zeroStored = () => prisma.agentState.update({ where: { agentId }, data: { cash: 0, qty: 0, avgEntry: null, peak: null, peakSeenTo: null, exitPendingSince: null, exitPendingKind: null } });
  const emptied = equityNow < EMPTY_USD;
  if (emptied && !order) {
    await zeroStored();
    return pause(prisma, agentId, EMPTY);
  }
  if (emptied) {
    // Empty, and there is an order to write down (the owner took everything out in the same hour). Measured
    // against an empty vault the hour would end on a base of zero, and every figure after it would be divided by
    // nothing. So the hour is booked on what the agent held before, with no flow, and the agent stops right after.
    cash = before.cash;
    qty = before.qty;
    equityNow = before.cash + before.qty * mark;
  }

  // Deposits and withdrawals since the last decision. The agent's base (startingCash) moves with them the way a
  // fund issues and redeems units, so the return is never changed by money coming in or going out.
  const equityBefore = before.cash + before.qty * mark;
  const rawFlow = equityNow - equityBefore;
  const flowUsd = Math.abs(rawFlow) < FLOW_MIN_USD ? 0 : rawFlow;
  const basis = agent.startingCash;
  let newBasis = basis;
  if (flowUsd !== 0) {
    // The last value per unit that means something: from a decision made with money in the vault.
    const lastDecision = await prisma.decision.findFirst({
      where: { agentId, equityAfter: { gte: EMPTY_USD }, basisAfter: { gt: 0 } },
      orderBy: { hour: "desc" },
      select: { equityAfter: true, basisAfter: true },
    });
    const lastNav = lastDecision?.basisAfter ? lastDecision.equityAfter / lastDecision.basisAfter : 1;
    const nav = equityBefore >= EMPTY_USD && basis > 0 ? equityBefore / basis : lastNav;
    newBasis = equityBefore < EMPTY_USD ? equityNow / nav : basis + flowUsd / nav;
    // Whatever happened, the base stays a positive, finite number: everything shown is divided by it.
    if (!Number.isFinite(newBasis) || newBasis <= 0) newBasis = basis > 0 ? basis : 1;
  }
  const scale = basis > 0 ? newBasis / basis : 1;
  // Tokens the owner added count as bought at this hour's price; tokens taken out leave the cost per token alone.
  const added = qty - before.qty;
  const state: PositionState = {
    ...before,
    cash,
    qty,
    avgEntry: qty === 0 ? null : before.qty === 0 || before.avgEntry == null ? mark : added > 0 ? (before.avgEntry * before.qty + mark * added) / qty : before.avgEntry,
    // Tokens the owner adds do not move the high the trailing stop follows: it stays the high since the agent's
    // own buy. A position the agent finds (it had none) starts its high at this hour's price.
    peak: qty === 0 ? null : before.qty === 0 ? mark : before.peak,
    // A position found now starts looking with the next close, also when this hour's prices are old.
    peakSeenTo: qty === 0 ? null : before.qty === 0 ? hour - HOUR_MS : before.peakSeenTo,
    // An open exit belongs to the position. With no position left there is nothing to sell.
    exitPending: qty === 0 ? null : before.exitPending,
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

  if (want.fill && !order) {
    // The chain was just read, which takes time. Look again: the owner may have paused or deleted the agent.
    const still = await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } });
    if (still?.status !== "active") return skip(still?.status ?? "not found");
    const buying = want.fill.side === "buy";
    const least = LIVE.minOrderUsd;
    const room = snap.remainingUsd * LIVE.limitMargin;
    const limitUsedUp = "the vault's daily trading limit is used up";
    let amountIn = 0n;
    if (clock() - hour > LIVE.orderWindowMs) {
      outcome = { ok: false, reason: LATE };
    } else if (buying) {
      // The limit counts buys and sales together. After a buy there must still be room in it to sell everything
      // the vault then holds of the token (what it already held and what this buy adds), valued 20% higher. So
      // the position can always be sold in the window it was bought in, stop loss included, however many buys
      // built it. A plan with no exit never sells, and may use all the room there is.
      const sells = hasExit(plan);
      const heldUsd = fromUnits(snap.token, token.decimals) * (snap.priceUsd ?? mark);
      const buyRoom = sells ? (room - (LIVE.exitRoomFactor - 1) * heldUsd) / LIVE.exitRoomFactor : room;
      const dollars = Math.min(want.fill.notional, buyRoom, fromUnits(snap.stable, LIVE_STABLE.decimals));
      if (room < least) outcome = { ok: false, reason: limitUsedUp };
      else if (buyRoom < least) outcome = { ok: false, reason: "the vault's daily trading limit has too little left for a buy and the sale that would follow it" };
      else if (dollars < least) outcome = { ok: false, reason: `the order would be smaller than the ${usd(least)} minimum` };
      else {
        amountIn = toUnits(dollars, LIVE_STABLE.decimals);
        if (dollars < want.fill.notional - 0.01) {
          note = sells
            ? `The order is smaller than the ${plan.sizePctOfCash}% the plan asks for, so that the sale of this position still fits in the vault's daily trading limit.`
            : `The vault's daily trading limit made this order smaller than the ${plan.sizePctOfCash}% the plan asks for.`;
        }
      }
    } else {
      // A sale is the whole position, whatever its size, or as much of it as the vault's daily limit still allows.
      const price = snap.priceUsd ?? mark;
      const value = fromUnits(snap.token, token.decimals) * price;
      if (value <= room) amountIn = snap.token;
      else {
        // Part of it. What stays behind must itself be big enough to sell later: a remainder too small to sell
        // would sit in the vault for good.
        const sellUsd = value - room < least ? value - least : room;
        if (sellUsd < least) outcome = { ok: false, reason: limitUsedUp };
        else {
          const part = toUnits(sellUsd / price, token.decimals);
          amountIn = part < snap.token ? part : snap.token;
          note = "The vault's daily trading limit allowed only part of the position to be sold.";
        }
      }
      if (!outcome && amountIn <= 0n) outcome = { ok: false, reason: "there was nothing to trade" };
    }
    if (!outcome) {
      const req: SwapRequest = {
        vault,
        tokenIn: buying ? LIVE_STABLE.address : token.address,
        tokenOut: buying ? token.address : LIVE_STABLE.address,
        feeTier: snap.feeTier,
        amountIn,
        deadline: deadlineOf(hour),
      };
      const fromBlock = await chain.blockNumber();
      order = await prisma.liveOrder.create({
        // Stamped with the engine's own clock, the one every later check of this order's age uses.
        data: { agentId, hour: new Date(hour), side: want.fill.side, vault, tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: amountIn.toString(), fromBlock: fromBlock.toString(), note: note ?? null, exitKind: buying ? null : want.exitKind, createdAt: new Date(now) },
      });
      const orderId = order.id;
      try {
        outcome = await chain.swap(req, async (txHash) => {
          // Checking the order and waiting behind other orders takes time. One that is only ready after the
          // window has closed is not sent. (The vault would refuse it a few minutes later in any case.)
          if (clock() - hour > LIVE.orderWindowMs) throw new OrderLateError();
          // Only an order that is still open and has no transaction yet may be sent. If someone closed it as
          // "not sent" while this worker was slow, sending now would put a trade behind a failed record.
          const mine = await prisma.liveOrder.updateMany({ where: { id: orderId, status: "pending", txHash: null }, data: { txHash } });
          if (mine.count !== 1) throw new OrderWithdrawnError(`Order ${orderId} was closed before it was sent`);
        });
      } catch (err) {
        if (err instanceof OrderPendingError) throw err;
        if (err instanceof OrderLateError) outcome = { ok: false, reason: LATE };
        else if (err instanceof OrderWithdrawnError) {
          const closed = await prisma.liveOrder.findUniqueOrThrow({ where: { id: orderId } });
          outcome = { ok: false, reason: closed.error ?? "the order was not sent" };
        } else {
          // The chain could not be reached before anything was signed. Nothing happened: take the unsigned order
          // back, and let the retry place it afresh.
          await prisma.liveOrder.deleteMany({ where: { id: orderId, status: "pending", txHash: null } });
          // If every retry of this hour ends here, the hour has no decision to carry what the agent wanted. A stop
          // or an exit rule that was reached is therefore put on the record now: next hour it is still an order
          // to sell, whatever the price has done.
          if (!buying && want.exitKind && staysOpen(want.exitKind)) {
            await prisma.agentState.updateMany({ where: { agentId, exitPendingSince: null }, data: { exitPendingSince: new Date(hour), exitPendingKind: want.exitKind } });
          }
          throw err;
        }
      }
      await closeOrder(prisma, orderId, outcome);
      log(outcome.ok ? "info" : "warn", "live order", { agentId, side: want.fill.side, ok: outcome.ok, txHash: outcome.txHash, reason: outcome.ok ? undefined : outcome.reason });
    }
  }

  // Book what really happened. The pool fee is taken from what goes in.
  const feeRate = snap.feeTier / 1_000_000;
  const side = order && outcome?.ok ? (order.side as "buy" | "sell") : want.fill?.side;
  let liveFill: LiveFill | undefined;
  if (outcome && side) {
    if (!outcome.ok) liveFill = { ok: false, reason: outcome.reason };
    else if (side === "buy") {
      const notional = fromUnits(outcome.amountIn, LIVE_STABLE.decimals);
      liveFill = { ok: true, side, notional, qty: fromUnits(outcome.amountOut, token.decimals), fee: notional * feeRate, note };
    } else {
      const received = fromUnits(outcome.amountOut, LIVE_STABLE.decimals);
      const gross = received / (1 - feeRate);
      liveFill = { ok: true, side, qty: fromUnits(outcome.amountIn, token.decimals), notional: gross, fee: gross - received, note };
    }
  }
  let out: StepOutput;
  if (liveFill?.ok && want.fill?.side !== liveFill.side) {
    // The order went through in a run that was interrupted, and the decision worked out now is not the one that
    // placed it (the inputs can differ a little minutes later). The trade is real, so it is booked as it happened,
    // and the record says plainly that its reasons were not kept and that the readings beside it are later ones.
    const res = liveFill.side === "buy" ? settleBuy(state, liveFill, hour) : settleSell(state, liveFill);
    if (!res) throw new Error(`Agent ${agentId}: order ${order?.id} has no amounts to book`);
    let booked = res.state;
    let tail = "";
    if (liveFill.side === "buy") {
      // A buy starts the trailing-stop high at its own price.
      booked = { ...booked, peakSeenTo: hour - HOUR_MS };
      if (note) tail = ` ${note}`;
    } else if (booked.qty > 0) {
      // Tokens are left after the sale. Either the sale was cut short (it sold less than the position on record),
      // or it sold all of it and what is here now came into the vault afterwards.
      const kind = isExitKind(order?.exitKind) ? order.exitKind : null;
      if (liveFill.qty < before.qty * (1 - 1e-9)) {
        // Cut short. The exit that asked for the sale decides what happens to the rest, as in any other hour.
        const open = kind != null && staysOpen(kind);
        if (open) booked = { ...booked, exitPending: state.exitPending ?? { since: hour, kind } };
        tail = ` ${qtyText(booked.qty)} ${agent.market} is still held.${note ? ` ${note}` : ""}${open ? " The agent tries to sell the rest every hour." : kind === "take profit" ? " The rest is sold in the next hour the target is still reached." : ""}`;
      } else {
        // The whole position was sold. What the vault holds now is not the rest of it: the owner added it since.
        // It is a new position, counted as bought at this hour's price, with no exit open.
        booked = { ...booked, avgEntry: mark, peak: mark, peakSeenTo: hour - HOUR_MS, exitPending: null };
        tail = ` ${qtyText(booked.qty)} ${agent.market} that came into the vault since is now held.`;
      }
    }
    const what = liveFill.side === "buy" ? `Bought ${usd(res.fill.notional)} of ${agent.market} at ${usd(res.fill.price)}` : `Sold ${qtyText(res.fill.qty)} ${agent.market} at ${usd(res.fill.price)}`;
    out = {
      decision: {
        ...want.decision,
        action: liveFill.side,
        explanation: `${liveFill.side === "buy" ? "Buy" : "Sell"}. This order was placed earlier in the hour by a run that was interrupted before it could write down its reasons. The readings shown with it were taken afterwards. ${what}.${tail}`,
      },
      fill: res.fill,
      state: booked,
      equity: equityOf(booked, mark),
      markPrice: mark,
      exitKind: null,
    };
    log("warn", "live order booked without its reasons", { agentId, orderId: order?.id, hour: new Date(hour).toISOString() });
  } else {
    out = liveFill && want.fill ? decide(ctx, { candles, hour, state, fillPrice, liveFill }) : want;
  }
  const d = out.decision;

  const holdEntry = agent.holdEntryPrice ?? mark;
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
    await tx.agent.update({
      where: { id: agentId },
      data: {
        startingCash: newBasis,
        holdEntryPrice: holdEntry,
        // Hours missed while the engine was down are never traded or filled in later, so they stop being owed.
        ...(!booking && agent.owedFrom.getTime() < hour && lastHour !== hour - HOUR_MS ? { owedFrom: new Date(hour) } : {}),
      },
    });
    return true;
  });
  if (!saved) {
    // Runs of one agent never overlap in this process, so this means a second engine is running. Say so loudly:
    // if an order went through, the next run books it.
    log("error", "live agent decided elsewhere; is a second engine running?", { agentId, hour: new Date(hour).toISOString(), orderId: order?.id });
    return skip("moved on");
  }
  log("info", "live agent run", { agentId, action: d.action, txHash: outcome?.txHash, flowUsd: flowUsd || undefined, upTo: new Date(hour).toISOString() });
  // The order is on record. If the vault may no longer be traded, or was found empty, the agent stops now.
  if (stop) await pause(prisma, agentId, stop);
  else if (emptied) {
    await zeroStored();
    await pause(prisma, agentId, EMPTY);
  }
  return { agentId, decided: 1, late: isLate ? 1 : 0, skipped: false };
}
