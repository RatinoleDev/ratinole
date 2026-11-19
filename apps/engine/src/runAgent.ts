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
  type Plan,
  type PositionState,
} from "@rationale/brain";
import { PAPER } from "@rationale/config";
import type { Prisma, PrismaClient } from "@rationale/db";
import type { Redis } from "ioredis";
import { env } from "./env";
import { log } from "./log";
import { loadCandles } from "./market/candles";
import type { CandleFeed } from "./market/types";

export interface EngineDeps {
  prisma: PrismaClient;
  redis?: Redis;
  feeds?: CandleFeed[];
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
const LATE_AFTER_MS = 30 * 60_000;
/** On-time runs wait (by retrying) this long for the newest candle. */
const WAIT_FOR_CANDLE_MS = 15 * 60_000;

export const hourFloor = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

function toState(s: {
  cash: number;
  qty: number;
  avgEntry: number | null;
  peak: number | null;
  lastBuyAt: Date | null;
  dayStart: Date;
  dayStartEquity: number;
}): PositionState {
  return {
    cash: s.cash,
    qty: s.qty,
    avgEntry: s.avgEntry,
    peak: s.peak,
    lastBuyAt: s.lastBuyAt ? s.lastBuyAt.getTime() : null,
    dayStart: s.dayStart.getTime(),
    dayStartEquity: s.dayStartEquity,
  };
}

function stateRow(s: PositionState) {
  return {
    cash: s.cash,
    qty: s.qty,
    avgEntry: s.avgEntry,
    peak: s.peak,
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
  const byTime = new Map<number, Candle>(set.candles.map((c) => [c.t, c]));

  const ctx = {
    agentId,
    plan,
    params,
    limits: { maxSizePct: agent.maxSizePct, dailyLossCapPct: agent.dailyLossCapPct },
    costPct: PAPER.costPct,
    market: agent.market,
  };
  let state: PositionState = agent.state ? toState(agent.state) : initialState(agent.startingCash, start);
  let holdEntry = agent.holdEntryPrice;
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

    const out = decide(ctx, { candles: set.candles, hour: h, state, fillPrice });
    if (holdEntry == null) holdEntry = fillPrice ?? out.markPrice;
    const holdingEquity = agent.startingCash * (1 - PAPER.costPct / 100) * (out.markPrice / holdEntry);
    const closedBefore = set.candles.filter((c) => c.t + HOUR_MS <= h);
    const candleTime = closedBefore[closedBefore.length - 1]!.t;
    const isLate = now - h > LATE_AFTER_MS;
    const d = out.decision;

    const stored = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`;
      const exists = await tx.decision.findUnique({ where: { agentId_hour: { agentId, hour: new Date(h) } }, select: { id: true } });
      if (exists) return false;
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
      await tx.agentState.upsert({
        where: { agentId },
        create: { agentId, ...stateRow(out.state) },
        update: stateRow(out.state),
      });
      if (agent.holdEntryPrice == null) await tx.agent.update({ where: { id: agentId }, data: { holdEntryPrice: holdEntry } });
      return true;
    });

    if (!stored) {
      // Another worker got here first; it owns the rest of this run.
      log("info", "decision already stored; stopping", { agentId, hour: new Date(h).toISOString() });
      break;
    }
    agent.holdEntryPrice = holdEntry;
    state = out.state;
    decided++;
    if (isLate) late++;
  }

  log("info", "agent run", { agentId, decided, late, source: set.sourceLabel, upTo: new Date(upToHour).toISOString() });
  return { agentId, decided, late, skipped: false };
}
