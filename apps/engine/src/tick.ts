/**
 * The hourly tick: find every active agent owed a decision and queue one job
 * per agent. Each job catches the agent up to the current hour in order.
 */
import type { Queue } from "bullmq";
import { log } from "./log";
import { snapshotMarkets } from "./market/snapshot";
import { hourFloor, runAgentHours, type AgentRunResult, type EngineDeps } from "./runAgent";
import { runLiveAgentHour } from "./vault/runLive";

export interface TickResult {
  hour: string;
  agents: number;
}

export async function tick(deps: EngineDeps & { queue?: Queue }): Promise<TickResult> {
  const { prisma } = deps;
  const hour = hourFloor((deps.now ?? Date.now)());
  const agents = await prisma.agent.findMany({
    where: { status: "active", owedFrom: { lte: new Date(hour) } },
    select: { id: true },
  });
  await prisma.engineRun.create({ data: { hour: new Date(hour), agents: agents.length } });
  if (deps.redis) await deps.redis.set("engine:lastTick", new Date().toISOString());

  for (const a of agents) {
    if (deps.queue) {
      await deps.queue.add(
        "agent",
        { agentId: a.id, upToHour: hour },
        {
          jobId: `agent-${a.id}-${hour}`,
          attempts: 6,
          backoff: { type: "exponential", delay: 15_000 },
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
