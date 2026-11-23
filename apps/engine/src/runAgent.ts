/**
 * Runs one agent through every hour it is owed, oldest first, and stores one
 * Decision per hour. Safe to run twice: a per-agent advisory lock serialises
 * writers and the (agentId, hour) unique key refuses duplicates.
 */
import {
  HOUR_MS,
  decide,
  initialState,
  requiredWarmup,
  type AgentParams,
  type Candle,
  type ExitKind,
  type Plan,
  type PositionState,
} from "@rationale/brain";
import { PAPER } from "@rationale/config";
import type { Prisma, PrismaClient } from "@rationale/db";
import type { Redis } from "ioredis";
import { env } from "./env";
import { log } from "./log";
import { loadCandles } from "./market/candles";
import { attachFunding, loadFunding, type FundingFeed } from "./market/funding";
import type { CandleFeed } from "./market/types";
import type { VaultChain } from "./vault/chain";

export interface EngineDeps {
  prisma: PrismaClient;
  redis?: Redis;
  feeds?: CandleFeed[];
  /** Funding source; omit to run on price signals only. */
  funding?: FundingFeed | null;
  /** Robinhood Chain access for live agents; omit and live agents are left alone. */
  chain?: VaultChain | null;
  now?: () => number;
}

export interface AgentRunResult {
  agentId: string;
  decided: number;
  late: number;
  skipped: boolean;
  reason?: string;
}

/** Thrown when the newest candle is not out yet; the job is retried shortly. */
export class FreshDataPendingError extends Error {}

/** A decision is "late" when stored more than this long after its hour. */
export const LATE_AFTER_MS = 30 * 60_000;
/** On-time runs wait (by retrying) this long for the newest candle. */
export const WAIT_FOR_CANDLE_MS = 15 * 60_000;

export const hourFloor = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

const EXIT_KINDS: readonly ExitKind[] = ["take profit", "stop loss", "trailing stop", "exit rule"];
export const isExitKind = (v: unknown): v is ExitKind => EXIT_KINDS.includes(v as ExitKind);

export function toState(s: {
  cash: number;
  qty: number;
  avgEntry: number | null;
  peak: number | null;
  peakSeenTo?: Date | null;
  exitPendingSince?: Date | null;
  exitPendingKind?: string | null;
  lastBuyAt: Date | null;
  dayStart: Date;
  dayStartEquity: number;
}): PositionState {
  return {
    cash: s.cash,
    qty: s.qty,
    avgEntry: s.avgEntry,
    peak: s.peak,
    peakSeenTo: s.peakSeenTo ? s.peakSeenTo.getTime() : null,
    exitPending: s.exitPendingSince && isExitKind(s.exitPendingKind) ? { since: s.exitPendingSince.getTime(), kind: s.exitPendingKind } : null,
    lastBuyAt: s.lastBuyAt ? s.lastBuyAt.getTime() : null,
    dayStart: s.dayStart.getTime(),
    dayStartEquity: s.dayStartEquity,
  };
}

export function stateRow(s: PositionState) {
  return {
    cash: s.cash,
    qty: s.qty,
    avgEntry: s.avgEntry,
    peak: s.peak,
    peakSeenTo: s.peakSeenTo == null ? null : new Date(s.peakSeenTo),
    exitPendingSince: s.exitPending ? new Date(s.exitPending.since) : null,
    exitPendingKind: s.exitPending ? s.exitPending.kind : null,
    lastBuyAt: s.lastBuyAt == null ? null : new Date(s.lastBuyAt),
    dayStart: new Date(s.dayStart),
    dayStartEquity: s.dayStartEquity,
  };
}

export async function runAgentHours(agentId: string, upToHour: number, deps: EngineDeps): Promise<AgentRunResult> {
  const { prisma } = deps;
  const now = (deps.now ?? Date.now)();
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { state: true } });
  if (!agent) return { agentId, decided: 0, late: 0, skipped: true, reason: "not found" };
  if (agent.status !== "active") return { agentId, decided: 0, late: 0, skipped: true, reason: agent.status };
  // Real money never goes through the paper path.
  if (agent.mode !== "paper") throw new Error(`Agent ${agentId} is not a paper agent`);

  const last = await prisma.decision.findFirst({ where: { agentId }, orderBy: { hour: "desc" }, select: { hour: true } });
  let start = Math.max(agent.owedFrom.getTime(), last ? last.hour.getTime() + HOUR_MS : 0);
  if (start > upToHour) return { agentId, decided: 0, late: 0, skipped: true, reason: "up to date" };
  const maxHours = env.maxCatchUpHours();
  if ((upToHour - start) / HOUR_MS + 1 > maxHours) {
    log("warn", "catch-up capped", { agentId, owedFrom: new Date(start).toISOString(), maxHours });
    start = upToHour - (maxHours - 1) * HOUR_MS;
  }

  const plan = agent.plan as unknown as Plan;
  const params = agent.params as unknown as AgentParams;
  const warmup = requiredWarmup(plan) + 24;
  const set = await loadCandles(agent.market, start - warmup * HOUR_MS, upToHour + HOUR_MS, deps);
  const funding = deps.funding ? await loadFunding(deps.funding, agent.market, start - warmup * HOUR_MS, upToHour + 2 * HOUR_MS, deps) : new Map<number, number>();
  const candles = attachFunding(set.candles, funding);
  const byTime = new Map<number, Candle>(candles.map((c) => [c.t, c]));

  const ctx = {
    agentId,
    plan,
    params,
    limits: { maxSizePct: agent.maxSizePct, dailyLossCapPct: agent.dailyLossCapPct },
    costPct: PAPER.costPct,
    market: agent.market,
    sources: funding.size && deps.funding ? { funding: deps.funding.label } : undefined,
  };
  let state: PositionState = agent.state ? toState(agent.state) : initialState(agent.startingCash, start);
  let holdEntry = agent.holdEntryPrice;
  // Running stats, written with each decision. `lastHour` doubles as a check
  // that no other worker moved this agent on since we read its state.
  let stats = {
    decisions: agent.state?.decisions ?? 0,
    peak: agent.state?.peakEquity ?? agent.startingCash,
    maxDd: agent.state?.maxDrawdownPct ?? 0,
    lastHour: agent.state?.lastHour?.getTime() ?? null,
  };
  let decided = 0;
  let late = 0;

  for (let h = start; h <= upToHour; h += HOUR_MS) {
    const fill = byTime.get(h);
    const fillPrice = fill ? fill.o : null;
    const lastClosed = byTime.get(h - HOUR_MS);
    const onTime = now - h < WAIT_FOR_CANDLE_MS;
    if ((!lastClosed || fillPrice == null) && onTime && h === upToHour) {
      throw new FreshDataPendingError(`Candle for ${new Date(h).toISOString()} not available yet (${agent.market})`);
    }

    const out = decide(ctx, { candles, hour: h, state, fillPrice });
    if (holdEntry == null) holdEntry = fillPrice ?? out.markPrice;
    const holdingEquity = agent.startingCash * (1 - PAPER.costPct / 100) * (out.markPrice / holdEntry);
    const closedBefore = candles.filter((c) => c.t + HOUR_MS <= h);
    const candleTime = closedBefore[closedBefore.length - 1]!.t;
    const isLate = now - h > LATE_AFTER_MS;
    const d = out.decision;

    const peak = Math.max(stats.peak, out.equity);
    const next = {
      decisions: stats.decisions + 1,
      peak,
      maxDd: Math.min(stats.maxDd, (out.equity / peak - 1) * 100),
      lastHour: h,
    };

    const stored = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`;
      const exists = await tx.decision.findUnique({ where: { agentId_hour: { agentId, hour: new Date(h) } }, select: { id: true } });
      if (exists) return false;
      // Our in-memory state must still be the stored one; otherwise another worker moved on.
      const current = await tx.agentState.findUnique({ where: { agentId }, select: { lastHour: true } });
      if ((current?.lastHour?.getTime() ?? null) !== stats.lastHour) return false;
      await tx.decision.create({
        data: {
          agentId,
          hour: new Date(h),
          action: d.action,
          confidence: d.confidence,
          regime: d.regime,
          evidence: d.evidence as unknown as Prisma.InputJsonValue,
          guard: d.guard as unknown as Prisma.InputJsonValue,
          explanation: d.explanation,
          late: isLate,
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
          candleTime: new Date(candleTime),
        },
      });
      const statRow = {
        decisions: next.decisions,
        lastHour: new Date(h),
        lastEquity: out.equity,
        lastHoldingEquity: holdingEquity,
        peakEquity: next.peak,
        maxDrawdownPct: next.maxDd,
      };
      await tx.agentState.upsert({
        where: { agentId },
        create: { agentId, ...stateRow(out.state), ...statRow },
        update: { ...stateRow(out.state), ...statRow },
      });
      if (agent.holdEntryPrice == null) await tx.agent.update({ where: { id: agentId }, data: { holdEntryPrice: holdEntry } });
      return true;
    });

    if (!stored) {
      // Another worker got here first; it owns the rest of this run.
      log("info", "agent moved on by another worker; stopping", { agentId, hour: new Date(h).toISOString() });
      break;
    }
    agent.holdEntryPrice = holdEntry;
    state = out.state;
    stats = next;
    decided++;
    if (isLate) late++;
  }

  log("info", "agent run", { agentId, decided, late, source: set.sourceLabel, upTo: new Date(upToHour).toISOString() });
  return { agentId, decided, late, skipped: false };
}

/**
 * Recompute every agent's running stats from its stored decisions. Use after
 * upgrading or to repair; the hourly run keeps them current otherwise.
 */
export async function recomputeStats(prisma: PrismaClient): Promise<number> {
  const agents = await prisma.agent.findMany({ where: { state: { isNot: null } }, select: { id: true, startingCash: true } });
  for (const a of agents) {
    const rows = await prisma.decision.findMany({
      where: { agentId: a.id },
      orderBy: { hour: "asc" },
      select: { hour: true, equityAfter: true, holdingEquityAfter: true, basisAfter: true },
    });
    // Measured per unit of base, so a live agent's deposits and withdrawals are neither peaks nor drops. A paper
    // agent's base never moves, which makes this the plain equity peak.
    let peakNav = 1;
    let maxDd = 0;
    for (const r of rows) {
      const base = r.basisAfter ?? a.startingCash;
      if (!(base > 0)) continue;
      const nav = r.equityAfter / base;
      peakNav = Math.max(peakNav, nav);
      maxDd = Math.min(maxDd, (nav / peakNav - 1) * 100);
    }
    const peak = peakNav * a.startingCash;
    const last = rows[rows.length - 1];
    await prisma.agentState.update({
      where: { agentId: a.id },
      data: {
        decisions: rows.length,
        lastHour: last?.hour ?? null,
        lastEquity: last?.equityAfter ?? null,
        lastHoldingEquity: last?.holdingEquityAfter ?? null,
        peakEquity: peak,
        maxDrawdownPct: maxDd,
      },
    });
  }
  return agents.length;
}
