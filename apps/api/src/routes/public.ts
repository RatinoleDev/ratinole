/** Public data: leaderboard, latest decisions, the landing example, health. */
import { HOUR_MS, describePlan, planChecks, type AgentParams } from "@rationale/brain";
import {
  EXAMPLE_STRATEGY,
  LEADERBOARD,
  MARKET_IDS,
  RISK_DEFAULTS,
  marketLabel,
  type ExampleDTO,
  type HealthDTO,
  type LeaderboardRowDTO,
  type LiveTickDTO,
  type MarketDTO,
} from "@rationale/config";
import type { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backtestDTO, decisionDTO, marketDTO } from "../dto";
import type { ApiDeps } from "../deps";

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
/** Missed-hour checks allow this long after the hour for the run to land. */
const GRACE_MS = 15 * 60_000;
/** Published by the engine (apps/engine/src/market/live.ts). */
const LIVE_CHANNEL = "market:live";
const MAX_STREAM_CLIENTS = 2000;

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
      select: { id: true, name: true, market: true, house: true, startingCash: true, launchedAt: true, state: true },
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
        house: a.house,
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
      include: { agent: { select: { name: true, market: true, sentence: true, house: true } } },
    });
    return rows.map((d) => decisionDTO(d, d.agent));
  });

  /** The latest stored reading of each market (no reading = left out). */
  app.get("/public/market", async (): Promise<MarketDTO[]> => {
    const rows = await Promise.all(
      MARKET_IDS.map((market) => deps.prisma.marketSnapshot.findFirst({ where: { market }, orderBy: { hour: "desc" } })),
    );
    return rows.filter((r) => r != null).map((r) => marketDTO(r!));
  });

  const readLive = async (): Promise<LiveTickDTO[]> => {
    const raw = await deps.redis.mget(...MARKET_IDS.map((m) => `market:live:${m}`)).catch(() => [] as (string | null)[]);
    return raw.filter((x): x is string => !!x).map((x) => JSON.parse(x) as LiveTickDTO);
  };

  /** Latest live price per market; empty when the engine's stream is not running. */
  app.get("/public/market/live", async (): Promise<LiveTickDTO[]> => readLive());

  // One Redis subscription shared by every browser connected to the stream.
  // Each client is its send function, mapped to the function that ends it.
  const clients = new Map<(msg: string) => void, () => void>();
  let subscriber: Redis | null = null;
  const ensureSubscriber = async () => {
    if (subscriber) return;
    subscriber = deps.redis.duplicate();
    subscriber.on("error", () => undefined);
    subscriber.on("message", (_channel, msg) => {
      for (const send of clients.keys()) send(msg);
    });
    await subscriber.subscribe(LIVE_CHANNEL);
  };
  // End open streams before the server waits for connections to finish, so a
  // reload is not held up by browsers that are still listening.
  app.addHook("preClose", async () => {
    for (const end of [...clients.values()]) end();
  });
  app.addHook("onClose", async () => {
    await subscriber?.quit().catch(() => undefined);
  });

  /** Server-sent events: one `data:` line per live tick. */
  app.get("/public/market/stream", async (_req, reply) => {
    if (clients.size >= MAX_STREAM_CLIENTS) return reply.code(503).send({ error: "busy", message: "Live prices are busy. Try again shortly." });
    await ensureSubscriber().catch(() => undefined);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell Nginx not to buffer the stream.
      "x-accel-buffering": "no",
    });
    const write = (chunk: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    const send = (msg: string) => write(`data: ${msg}\n\n`);
    const heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);
    const end = () => {
      clearInterval(heartbeat);
      clients.delete(send);
      if (!res.writableEnded) res.end();
    };
    // Registered before anything is awaited, so a visitor who leaves early is
    // always removed.
    res.on("close", end);
    clients.set(send, end);
    write("retry: 3000\n\n");
    for (const t of await readLive()) send(JSON.stringify(t));
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
    // If Redis is down, report "not ok" rather than failing the request.
    const [heartbeat, lastTick] = await Promise.all([deps.redis.get("engine:heartbeat"), deps.redis.get("engine:lastTick")]).catch(
      () => [null, null] as const,
    );
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
