/** Public data: leaderboard, latest decisions, the landing example, health. */
import { HOUR_MS, describePlan, planChecks, type AgentParams } from "@rationale/brain";
import { EXAMPLE_STRATEGY, LEADERBOARD, RISK_DEFAULTS, marketLabel, type ExampleDTO, type HealthDTO, type LeaderboardRowDTO } from "@rationale/config";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backtestDTO, decisionDTO } from "../dto";
import type { ApiDeps } from "../deps";

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
/** Missed-hour checks allow this long after the hour for the run to land. */
const GRACE_MS = 15 * 60_000;

export function publicRoutes(app: FastifyInstance, deps: ApiDeps) {
  const now = () => (deps.now ?? Date.now)();

  /**
   * Paper agents ranked by edge over holding, read from each agent's stored
   * running stats. Agents younger than LEADERBOARD.minDaysToRank are listed
   * after the ranked ones and marked unranked.
   */
  app.get("/leaderboard", async (): Promise<LeaderboardRowDTO[]> => {
    const agents = await deps.prisma.agent.findMany({
      where: { status: { not: "archived" }, state: { is: { decisions: { gt: 0 } } } },
      select: { id: true, name: true, market: true, startingCash: true, launchedAt: true, state: true },
    });
    const rows: LeaderboardRowDTO[] = agents.map((a) => {
      const s = a.state!;
      const returnPct = ((s.lastEquity ?? a.startingCash) / a.startingCash - 1) * 100;
      const holdingPct = ((s.lastHoldingEquity ?? a.startingCash) / a.startingCash - 1) * 100;
      const daysLive = Math.floor((now() - a.launchedAt.getTime()) / (24 * HOUR_MS));
      return {
        agentId: a.id,
        name: a.name,
        market: a.market,
        marketLabel: marketLabel(a.market),
        mode: "paper",
        returnPct,
        holdingPct,
        edgePct: returnPct - holdingPct,
        maxDrawdownPct: s.maxDrawdownPct,
        daysLive,
        decisions: s.decisions,
        ranked: daysLive >= LEADERBOARD.minDaysToRank,
      };
    });
    return rows.sort((x, y) => Number(y.ranked) - Number(x.ranked) || y.edgePct - x.edgePct).slice(0, 100);
  });

  app.get<{ Querystring: Record<string, string> }>("/public/decisions", async (req) => {
    const q = LimitQuery.parse(req.query);
    const rows = await deps.prisma.decision.findMany({
      where: { agent: { status: { not: "archived" } } },
      orderBy: [{ hour: "desc" }, { createdAt: "desc" }],
      take: q.limit,
      include: { agent: { select: { name: true, market: true, sentence: true } } },
    });
    return rows.map((d) => decisionDTO(d, d.agent));
  });

  app.get("/public/example", async (): Promise<ExampleDTO> => {
    const bt = await deps.prisma.backtest.findFirst({ where: { kind: "example", status: "done" }, orderBy: { createdAt: "desc" } });
    const windows = (bt?.params as AgentParams | null)?.windows;
    return {
      sentence: EXAMPLE_STRATEGY.sentence,
      rows: describePlan(EXAMPLE_STRATEGY.plan, { marketLabel, windows }),
      checks: planChecks(EXAMPLE_STRATEGY.plan, RISK_DEFAULTS.maxSizePctOfCash),
      backtest: bt ? backtestDTO(bt) : null,
    };
  });

  app.get("/health", async (): Promise<HealthDTO> => {
    const [heartbeat, lastTick] = await Promise.all([deps.redis.get("engine:heartbeat"), deps.redis.get("engine:lastTick")]);
    const lastDue = new Date(Math.floor((now() - GRACE_MS) / HOUR_MS) * HOUR_MS);
    const agents = await deps.prisma.agent.findMany({ where: { status: "active" }, select: { id: true, owedFrom: true } });
    let missedHours = 0;
    for (const a of agents) {
      if (a.owedFrom > lastDue) continue;
      const expected = Math.floor((lastDue.getTime() - a.owedFrom.getTime()) / HOUR_MS) + 1;
      const have = await deps.prisma.decision.count({ where: { agentId: a.id, hour: { gte: a.owedFrom, lte: lastDue } } });
      missedHours += Math.max(0, expected - have);
    }
    const lateDecisions = await deps.prisma.decision.count({ where: { late: true, agent: { status: "active" } } });
    const beatOk = !!heartbeat && now() - new Date(heartbeat).getTime() < 2 * 60_000;
    return { ok: beatOk && missedHours === 0, engine: { lastHeartbeat: heartbeat, lastTick }, activeAgents: agents.length, missedHours, lateDecisions };
  });
}
