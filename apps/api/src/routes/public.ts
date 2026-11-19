/** Public data: leaderboard, latest decisions, the landing example, health. */
import { HOUR_MS, describePlan, maxDrawdownPct, planChecks, type AgentParams } from "@rationale/brain";
import { EXAMPLE_STRATEGY, RISK_DEFAULTS, marketLabel, type ExampleDTO, type HealthDTO, type LeaderboardRowDTO } from "@rationale/config";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backtestDTO, decisionDTO } from "../dto";
import type { ApiDeps } from "../deps";

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
/** Missed-hour checks allow this long after the hour for the run to land. */
const GRACE_MS = 15 * 60_000;

export function publicRoutes(app: FastifyInstance, deps: ApiDeps) {
  const now = () => (deps.now ?? Date.now)();

  app.get("/leaderboard", async (): Promise<LeaderboardRowDTO[]> => {
    const agents = await deps.prisma.agent.findMany({ select: { id: true, name: true, market: true, startingCash: true, launchedAt: true } });
    if (!agents.length) return [];
    const rows = await deps.prisma.decision.findMany({
      where: { agentId: { in: agents.map((a) => a.id) } },
      orderBy: { hour: "asc" },
      select: { agentId: true, equityAfter: true, holdingEquityAfter: true },
    });
    const series = new Map<string, { e: number[]; lastHold: number }>();
    for (const r of rows) {
      const s = series.get(r.agentId) ?? { e: [], lastHold: 0 };
      s.e.push(r.equityAfter);
      s.lastHold = r.holdingEquityAfter;
      series.set(r.agentId, s);
    }
    const out: LeaderboardRowDTO[] = [];
    for (const a of agents) {
      const s = series.get(a.id);
      if (!s || !s.e.length) continue;
      const returnPct = (s.e[s.e.length - 1]! / a.startingCash - 1) * 100;
      const holdingPct = (s.lastHold / a.startingCash - 1) * 100;
      out.push({
        agentId: a.id,
        name: a.name,
        market: a.market,
        marketLabel: marketLabel(a.market),
        mode: "paper",
        returnPct,
        holdingPct,
        edgePct: returnPct - holdingPct,
        maxDrawdownPct: maxDrawdownPct(s.e, a.startingCash),
        daysLive: Math.floor((now() - a.launchedAt.getTime()) / (24 * HOUR_MS)),
        decisions: s.e.length,
      });
    }
    return out.sort((x, y) => y.edgePct - x.edgePct).slice(0, 100);
  });

  app.get<{ Querystring: Record<string, string> }>("/public/decisions", async (req) => {
    const q = LimitQuery.parse(req.query);
    const rows = await deps.prisma.decision.findMany({ orderBy: [{ hour: "desc" }, { createdAt: "desc" }], take: q.limit, include: { agent: { select: { name: true, market: true, sentence: true } } } });
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
