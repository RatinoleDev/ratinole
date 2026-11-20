/**
 * The hourly tick: find every active agent owed a decision and queue one job
 * per agent. Each job catches the agent up to the current hour in order.
 */
import type { Queue } from "bullmq";
import { log } from "./log";
import { snapshotMarkets } from "./market/snapshot";
import { HOUR_MS } from "@rationale/brain";
import { hourFloor, runAgentHours, type AgentRunResult, type EngineDeps } from "./runAgent";
import { runLiveAgentHour } from "./vault/runLive";

export interface TickResult {
  hour: string;
  agents: number;
}

/**
 * How long a failed agent job waits before each further try, in seconds. Together they span about 33 minutes: past
 * the wait for a late candle (15 minutes) and past the moment an unconfirmed order's fate is known (its deadline,
 * 25 minutes into the hour, plus a margin).
 */
export const RETRY_DELAYS_S = [15, 30, 60, 120, 240, 300, 300, 300, 300, 300];
export const retryDelayMs = (attemptsMade: number) => RETRY_DELAYS_S[Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_S.length) - 1]! * 1000;

export async function tick(deps: EngineDeps & { queue?: Queue }): Promise<TickResult> {
  const { prisma } = deps;
  const hour = hourFloor((deps.now ?? Date.now)());
  const agents = await prisma.agent.findMany({
    where: { status: "active", owedFrom: { lte: new Date(hour) } },
    select: { id: true },
  });
  await prisma.engineRun.create({ data: { hour: new Date(hour), agents: agents.length } });
  if (deps.redis) await deps.redis.set("engine:lastTick", new Date().toISOString());

  // A live order that has no decision yet is real money waiting to be written down. Its agent is run for that
  // even if the owner has paused or deleted it since: the run books the order and places nothing new.
  const queued = new Set(agents.map((a) => a.id));
  const stranded = deps.chain
    ? await prisma.$queryRaw<{ agentId: string }[]>`
        SELECT DISTINCT o."agentId" FROM "LiveOrder" o
        JOIN "Agent" a ON a.id = o."agentId"
        LEFT JOIN "Decision" d ON d."agentId" = o."agentId" AND d.hour = o.hour
        WHERE d.id IS NULL AND a.status <> 'active' AND o.hour > ${new Date(hour - 72 * HOUR_MS)}`
    : [];
  const toRun = [...agents, ...stranded.filter((o) => !queued.has(o.agentId)).map((o) => ({ id: o.agentId }))];

  for (const a of toRun) {
    if (deps.queue) {
      await deps.queue.add(
        "agent",
        { agentId: a.id, upToHour: hour },
        {
          jobId: `agent-${a.id}-${hour}`,
          attempts: RETRY_DELAYS_S.length + 1,
          backoff: { type: "custom" },
          removeOnComplete: 2000,
          removeOnFail: 5000,
        },
      );
    } else {
      await runAgentAndRecord(a.id, hour, deps);
    }
  }
  const snapshots = await snapshotMarkets(deps);
  log("info", "tick", { hour: new Date(hour).toISOString(), agents: agents.length, snapshots, queued: !!deps.queue });
  return { hour: new Date(hour).toISOString(), agents: agents.length };
}

/** Run one agent and add its counts to this hour's EngineRun row. */
export async function runAgentAndRecord(agentId: string, upToHour: number, deps: EngineDeps) {
  const res = await runOne(agentId, upToHour, deps);
  await deps.prisma.engineRun.updateMany({
    where: { hour: new Date(upToHour) },
    data: { decisions: { increment: res.decided }, late: { increment: res.late }, finishedAt: new Date() },
  });
  return res;
}

/** Paper agents catch up every hour they are owed. Live agents decide the current hour only, on-chain. */
async function runOne(agentId: string, upToHour: number, deps: EngineDeps): Promise<AgentRunResult> {
  const agent = await deps.prisma.agent.findUnique({ where: { id: agentId }, select: { mode: true } });
  if (agent?.mode !== "live") return runAgentHours(agentId, upToHour, deps);
  if (!deps.chain) {
    log("warn", "live agent skipped: live trading is not configured on this engine", { agentId });
    return { agentId, decided: 0, late: 0, skipped: true, reason: "live trading is not configured" };
  }
  return runLiveAgentHour(agentId, upToHour, { ...deps, chain: deps.chain });
}
