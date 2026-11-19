/** Paper agents: launch, list, pause/resume, decision log, and the wallet overview. */
import { HOUR_MS, maxDrawdownPct, type Plan } from "@rationale/brain";
import { PAPER, type CurvePointDTO, type OverviewDTO } from "@rationale/config";
import type { Prisma } from "@rationale/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentDTO, decisionDTO } from "../dto";
import { requireUser, sendError, type ApiDeps } from "../deps";
import { cleanName, pickName } from "../names";

const LaunchBody = z.object({ backtestId: z.string().min(1).max(64), name: z.string().max(64).optional() });
const PatchBody = z.object({ status: z.enum(["active", "paused"]) });
const DecisionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() });

const nextHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS + HOUR_MS;

export function agentRoutes(app: FastifyInstance, deps: ApiDeps) {
  const now = () => (deps.now ?? Date.now)();

  async function loadAgentDTO(id: string) {
    const a = await deps.prisma.agent.findUnique({ where: { id }, include: { state: true } });
    if (!a) return null;
    const [latest, count] = await Promise.all([
      deps.prisma.decision.findFirst({ where: { agentId: id }, orderBy: { hour: "desc" } }),
      deps.prisma.decision.count({ where: { agentId: id } }),
    ]);
    return { agent: a, dto: agentDTO(a, latest, count) };
  }

  app.post("/agents", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const body = LaunchBody.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, "bad_request", "Run a backtest before launching.");
    const bt = await deps.prisma.backtest.findUnique({ where: { id: body.data.backtestId } });
    if (!bt || bt.userId !== user.id) return sendError(reply, 404, "not_found", "No such backtest.");
    if (bt.status !== "done" || !bt.params) return sendError(reply, 409, "backtest_not_done", "Wait for the backtest to finish before launching.");
    const existing = await deps.prisma.agent.findMany({ where: { userId: user.id, status: { not: "archived" } }, select: { name: true } });
    if (existing.length >= PAPER.maxAgentsPerUser) {
      return sendError(reply, 409, "agent_limit", `Paper trading allows ${PAPER.maxAgentsPerUser} agents per wallet. Delete one in My agents to launch another.`);
    }
    let name = pickName(existing.map((e) => e.name));
    if (body.data.name != null && body.data.name.trim() !== "") {
      const clean = cleanName(body.data.name);
      if (!clean) return sendError(reply, 400, "bad_name", "Use up to 32 letters, numbers and spaces for the name.");
      name = clean;
    }
    const plan = bt.plan as unknown as Plan;
    const agent = await deps.prisma.agent.create({
      data: {
        userId: user.id,
        name,
        sentence: bt.sentence,
        plan: plan as unknown as Prisma.InputJsonValue,
        params: bt.params as Prisma.InputJsonValue,
        market: bt.market,
        startingCash: PAPER.startingCash,
        maxSizePct: user.maxSizePct,
        dailyLossCapPct: user.dailyLossCapPct,
        backtestId: bt.id,
        owedFrom: new Date(nextHour(now())),
      },
      include: { state: true },
    });
    return reply.code(201).send(agentDTO(agent, null, 0));
  });

  app.get("/agents", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const agents = await deps.prisma.agent.findMany({ where: { userId: user.id, status: { not: "archived" } }, orderBy: { launchedAt: "desc" }, select: { id: true } });
    const out = await Promise.all(agents.map((a) => loadAgentDTO(a.id)));
    return out.filter((x) => x).map((x) => x!.dto);
  });

  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const found = await loadAgentDTO(req.params.id);
    if (!found) return sendError(reply, 404, "not_found", "No such agent.");
    return found.dto;
  });

  app.patch<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const body = PatchBody.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, "bad_request", "Status must be active or paused.");
    const a = await deps.prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!a || a.userId !== user.id || a.status === "archived") return sendError(reply, 404, "not_found", "No such agent.");
    if (a.status !== body.data.status) {
      await deps.prisma.agent.update({
        where: { id: a.id },
        // Resuming owes decisions from the next hour; paused hours are never backfilled.
        data: body.data.status === "active" ? { status: "active", owedFrom: new Date(nextHour(now())) } : { status: "paused" },
      });
    }
    return (await loadAgentDTO(a.id))!.dto;
  });

  /** Delete = archive: the agent stops, leaves your list and the rankings, and frees a slot. Its decisions stay on record. */
  app.delete<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const a = await deps.prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!a || a.userId !== user.id || a.status === "archived") return sendError(reply, 404, "not_found", "No such agent.");
    await deps.prisma.agent.update({ where: { id: a.id }, data: { status: "archived", archivedAt: new Date(now()) } });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/agents/:id/decisions", async (req, reply) => {
    const q = DecisionsQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, "bad_request", "Bad query.");
    const a = await deps.prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, market: true, sentence: true } });
    if (!a) return sendError(reply, 404, "not_found", "No such agent.");
    const rows = await deps.prisma.decision.findMany({
      where: { agentId: a.id, ...(q.data.before ? { hour: { lt: new Date(q.data.before) } } : {}) },
      orderBy: { hour: "desc" },
      take: q.data.limit,
    });
    return rows.map((d) => decisionDTO(d, a));
  });

  app.get("/overview", async (req, reply): Promise<OverviewDTO | typeof reply> => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const agents = await deps.prisma.agent.findMany({
      where: { userId: user.id, status: { not: "archived" } },
      select: { id: true, name: true, market: true, sentence: true, startingCash: true },
    });
    const ids = agents.map((a) => a.id);
    const byId = new Map(agents.map((a) => [a.id, a]));
    const rows = ids.length
      ? await deps.prisma.decision.findMany({
          where: { agentId: { in: ids } },
          orderBy: { hour: "asc" },
          select: { agentId: true, hour: true, equityAfter: true, holdingEquityAfter: true },
        })
      : [];
    const latestRows = ids.length ? await deps.prisma.decision.findMany({ where: { agentId: { in: ids } }, orderBy: { hour: "desc" }, take: 10 }) : [];
    const latest = latestRows.map((d) => decisionDTO(d, byId.get(d.agentId)!));
    if (!rows.length) return { agentCount: agents.length, kpis: null, series: [], latest };

    // Combined equity per hour: each agent's latest value carried forward, starting cash before its first decision.
    const active = [...new Set(rows.map((r) => r.agentId))];
    const cash = active.reduce((s, id) => s + byId.get(id)!.startingCash, 0);
    const eq = new Map(active.map((id) => [id, byId.get(id)!.startingCash]));
    const hold = new Map(active.map((id) => [id, byId.get(id)!.startingCash]));
    const points: { t: number; e: number; h: number }[] = [];
    for (const r of rows) {
      eq.set(r.agentId, r.equityAfter);
      hold.set(r.agentId, r.holdingEquityAfter);
      const t = r.hour.getTime();
      const e = [...eq.values()].reduce((a, b) => a + b, 0);
      const h = [...hold.values()].reduce((a, b) => a + b, 0);
      if (points.length && points[points.length - 1]!.t === t) points[points.length - 1] = { t, e, h };
      else points.push({ t, e, h });
    }
    const last = points[points.length - 1]!;
    const since = now() - 30 * 24 * HOUR_MS;
    const series: CurvePointDTO[] = points
      .filter((p) => p.t >= since)
      .map((p) => ({ t: new Date(p.t).toISOString(), strategy: (p.e / cash) * 100, holding: (p.h / cash) * 100 }));
    return {
      agentCount: agents.length,
      kpis: {
        equity: last.e,
        returnPct: (last.e / cash - 1) * 100,
        holdingPct: (last.h / cash - 1) * 100,
        maxDrawdownPct: maxDrawdownPct(points.map((p) => p.e), cash),
      },
      series,
      latest,
    };
  });
}

