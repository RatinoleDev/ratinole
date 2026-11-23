/** Agents, paper and live: launch, list, pause/resume, decision log, and the wallet overview. */
import { HOUR_MS, maxDrawdownPct, type Plan } from "@rationale/brain";
import { LIVE, LIVE_TOKENS, PAPER, couldBeWorthADollar, isMarketId, strayTokensArePosition, type CurvePointDTO, type OverviewDTO } from "@rationale/config";
import type { Prisma, User } from "@rationale/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentDTO, decisionDTO } from "../dto";
import { currentUser } from "../auth";
import { allow, requireUser, sendError, type ApiDeps } from "../deps";
import { cleanName, pickName } from "../names";

const Mode = z.enum(["paper", "live"]);
const LaunchBody = z.object({ backtestId: z.string().min(1).max(64), name: z.string().max(64).optional(), mode: Mode.default("paper") });
const PatchBody = z.object({ status: z.enum(["active", "paused"]) });
const ModeQuery = z.object({ mode: Mode.optional() });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type LiveCheck =
  | {
      ok: true;
      vault: string;
      cash: number;
      /** Every unit of the market token in the vault, and what the oracle says it is worth (null: no price now). */
      tokenQty: number;
      tokenUsd: number | null;
      price: number | null;
    }
  | { ok: false; status: number; error: string; message: string };
const DecisionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() });

const nextHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS + HOUR_MS;

export function agentRoutes(app: FastifyInstance, deps: ApiDeps) {
  const now = () => (deps.now ?? Date.now)();

  /**
   * Is this wallet's vault ready for a live agent on this market? Read from the chain every time: the vault is the
   * owner's, and they can change it whenever they like.
   */
  async function checkVault(user: User, market: string, launching: boolean, launchedOn?: string | null): Promise<LiveCheck> {
    const no = (status: number, error: string, message: string): LiveCheck => ({ ok: false, status, error, message });
    if (!deps.vaults) return no(409, "live_off", "Live trading is not open yet.");
    // Every check reads the chain; one wallet may not use up the server's share of it.
    if (!(await allow(deps.redis, `vaultcheck:${user.id}`, 12, 60))) return no(429, "rate_limited", "Too many tries. Wait a minute, then try again.");
    if (deps.env.liveTradingPaused) return no(409, "live_paused", "Live trading is paused for now. Your vault is still yours: you can withdraw at any time on the Vault page.");
    if (!isMarketId(market)) return no(409, "unsupported_market", "This market cannot be traded live yet.");
    let info;
    let operator;
    try {
      const vault = await deps.vaults.vaultOf(user.address);
      if (!vault) return no(409, "no_vault", "Create your vault on the Vault page first.");
      [info, operator] = await Promise.all([deps.vaults.read(vault, market), deps.vaults.defaultOperator()]);
    } catch {
      return no(503, "chain_unavailable", "Robinhood Chain could not be reached. Try again in a moment.");
    }
    if (info.owner !== user.address.toLowerCase()) return no(409, "not_your_vault", "This vault belongs to another wallet now.");
    // An agent only ever trades the vault it was launched on. A wallet that has moved to a new vault launches a new agent.
    if (launchedOn && launchedOn.toLowerCase() !== info.vault) {
      return no(409, "other_vault", "This agent was launched on a vault you no longer use. Delete it and launch a new one on your current vault.");
    }
    // "No operator" on both sides is not a match: a vault nobody may trade has its access off.
    if (operator === ZERO_ADDRESS || info.operator !== operator) return no(409, "agent_access", "The agent's access to your vault is switched off. Restore it on the Vault page.");
    if (info.paused) return no(409, "vault_paused", "Your vault is paused. Resume it on the Vault page.");
    if (!info.token.tradable) return no(409, "token_not_allowed", `Your vault does not allow ${LIVE_TOKENS[market].symbol} trades.`);
    // The token is only counted when the oracle has a price for it; cash always counts.
    const price = info.token.priceUsd;
    const tokenUsd = price == null ? null : info.token.qty * price;
    const equity = info.cash + (tokenUsd ?? 0);
    if (equity < LIVE.minVaultUsd) {
      return no(
        409,
        "vault_empty",
        price == null && info.token.qty > 0
          ? `Your vault holds less than $${LIVE.minVaultUsd} of USDG, and its ${LIVE_TOKENS[market].symbol} has no oracle price right now. Deposit USDG, or try again in a moment.`
          : `Deposit at least $${LIVE.minVaultUsd} of USDG into your vault first.`,
      );
    }
    // The cap counts everything in the vault that the agent's key could trade, not just this agent's market.
    const total = equity + info.otherUsd;
    const cap = deps.env.liveMaxVaultUsd;
    if (launching && cap != null) {
      // The cap is a statement about how much is at stake. A balance the oracle cannot price right now makes that
      // unknown, and unknown is not "under the cap".
      if ((price == null && couldBeWorthADollar(info.token.qty)) || info.otherUnpriced) {
        return no(409, "cap_unpriced", "Your vault holds a token the price oracle has no fresh price for right now, so its value cannot be checked against the launch limit. Try again in a moment.");
      }
      if (total > cap) {
        return no(409, "beta_cap", `While the contracts have not been audited, a vault may hold at most $${cap.toLocaleString("en-US")} when a live agent starts. Yours holds about $${Math.floor(total).toLocaleString("en-US")}.`);
      }
    }
    return { ok: true, vault: info.vault, cash: info.cash, tokenQty: info.token.qty, tokenUsd, price };
  }

  /**
   * While an agent is stopped nobody watches its vault. Most of what can happen meanwhile needs nothing here:
   * dollars that came or went are counted exactly when the engine next looks, and tokens that were ADDED count as
   * bought at the hour it sees them. Tokens that were TAKEN OUT are the one thing that cannot be valued later:
   * priced at the day the agent comes back, the market's moves since they left would be booked as the agent's
   * doing. Only the vault's owner can take tokens out, and the fair reading is that they left when the agent
   * stopped. So they are taken off the agent's record at the price of its last decision: its base shrinks by
   * that much and nothing else changes. What is left keeps its entry price, its stop, and its gain or loss over
   * the pause.
   */
  async function settleTokensTakenOutWhileStopped(a: { id: string; startingCash: number }, vault: Extract<LiveCheck, { ok: true }>) {
    const state = await deps.prisma.agentState.findUnique({ where: { agentId: a.id } });
    if (!state || state.qty <= 0) return;
    const last = await deps.prisma.decision.findFirst({ where: { agentId: a.id }, orderBy: { hour: "desc" }, select: { markPrice: true } });
    const price = last?.markPrice ?? state.avgEntry ?? vault.price;
    if (price == null || !(price > 0)) return;
    // Less than an order's worth gone is left to the engine's own bookkeeping.
    if ((state.qty - vault.tokenQty) * price < LIVE.minOrderUsd) return;
    const remaining = vault.tokenQty * price >= LIVE.positionFloorUsd ? vault.tokenQty : 0;
    const then = state.cash + state.qty * price;
    const left = then - (state.qty - remaining) * price;
    // If nothing measurable is left on the record, the base stays as it is: the engine starts again from the
    // last value per unit when it next finds money in the vault.
    const basis = left >= 1 && then > 0 ? a.startingCash * (left / then) : a.startingCash;
    if (!Number.isFinite(basis) || basis <= 0) return;
    const scale = a.startingCash > 0 ? basis / a.startingCash : 1;
    await deps.prisma.$transaction([
      deps.prisma.agentState.update({
        where: { agentId: a.id },
        data: {
          qty: remaining,
          ...(remaining === 0 ? { avgEntry: null, peak: null } : {}),
          dayStartEquity: state.dayStartEquity * scale,
          lastEquity: left,
          ...(state.peakEquity != null ? { peakEquity: state.peakEquity * scale } : {}),
        },
      }),
      deps.prisma.agent.update({ where: { id: a.id }, data: { startingCash: basis } }),
    ]);
  }

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
    // The size cap may have been lowered in Settings since the backtest. An agent launched over its own cap would
    // have every buy vetoed, hour after hour, and never trade.
    const size = (bt.plan as unknown as Plan).sizePctOfCash;
    if (size > user.maxSizePct) {
      return sendError(reply, 409, "size_over_cap", `This strategy uses ${size}% of cash per trade, over your ${user.maxSizePct}% cap. Raise the cap in Settings, or write the strategy with a smaller size.`);
    }
    const live = body.data.mode === "live";
    // One launch at a time per wallet: two requests sent together must not both pass the limits below. The lock
    // is held in Redis for the length of this request and released at the end.
    const lockKey = `lock:launch:${user.id}`;
    // Held for longer than the slowest launch can take (the chain reads time out well inside a minute).
    if ((await deps.redis.set(lockKey, "1", "EX", 90, "NX")) !== "OK") {
      return sendError(reply, 409, "busy", "Another launch from this wallet is still in progress. Try again in a moment.");
    }
    const launch = async () => {
    const existing = await deps.prisma.agent.findMany({ where: { userId: user.id, status: { not: "archived" } }, select: { name: true, mode: true } });
    const sameMode = existing.filter((e) => (e.mode === "live") === live).length;
    if (live && sameMode >= LIVE.maxAgentsPerVault) {
      return sendError(reply, 409, "live_limit", "A vault runs one live agent at a time. Delete the current one in My agents to launch another.");
    }
    if (!live && sameMode >= PAPER.maxAgentsPerUser) {
      return sendError(reply, 409, "agent_limit", `Paper trading allows ${PAPER.maxAgentsPerUser} agents per wallet. Delete one in My agents to launch another.`);
    }
    const vault = live ? await checkVault(user, bt.market, true) : null;
    if (vault && !vault.ok) return sendError(reply, vault.status, vault.error, vault.message);
    let name = pickName(existing.map((e) => e.name));
    if (body.data.name != null && body.data.name.trim() !== "") {
      const clean = cleanName(body.data.name);
      if (!clean) return sendError(reply, 400, "bad_name", "Use up to 32 letters, numbers and spaces for the name.");
      name = clean;
    }
    const plan = bt.plan as unknown as Plan;
    // Tokens already in the vault are the agent's starting position only when they are worth one of its own
    // orders (the rule the engine uses every hour). Less than that is left alone, and the agent starts flat.
    const start = vault?.ok
      ? (() => {
          const qty = vault.tokenUsd != null && strayTokensArePosition(vault.tokenUsd, vault.cash, plan.sizePctOfCash) ? vault.tokenQty : 0;
          return { cash: vault.cash, qty, price: vault.price, equity: vault.cash + qty * (vault.price ?? 0) };
        })()
      : null;
    if (start && start.equity < LIVE.minVaultUsd) {
      return sendError(reply, 409, "vault_empty", `Deposit at least $${LIVE.minVaultUsd} of USDG into your vault first.`);
    }
    const agent = await deps.prisma.agent.create({
      data: {
        userId: user.id,
        name,
        sentence: bt.sentence,
        plan: plan as unknown as Prisma.InputJsonValue,
        params: bt.params as Prisma.InputJsonValue,
        market: bt.market,
        maxSizePct: user.maxSizePct,
        dailyLossCapPct: user.dailyLossCapPct,
        backtestId: bt.id,
        owedFrom: new Date(nextHour(now())),
        ...(vault?.ok && start
          ? {
              mode: "live",
              vault: vault.vault,
              // Results are measured against what the vault held at launch. The engine reads the vault again
              // before every decision, so this is a starting point, never a claim about later balances.
              startingCash: start.equity,
              state: {
                create: {
                  cash: start.cash,
                  qty: start.qty,
                  avgEntry: start.qty > 0 ? start.price : null,
                  peak: start.qty > 0 ? start.price : null,
                  dayStart: new Date(Math.floor(now() / (24 * HOUR_MS)) * 24 * HOUR_MS),
                  dayStartEquity: start.equity,
                },
              },
            }
          : { startingCash: PAPER.startingCash }),
      },
      include: { state: true },
    });
    return reply.code(201).send(agentDTO(agent, null, 0));
    };
    try {
      return await launch();
    } finally {
      await deps.redis.del(lockKey).catch(() => undefined);
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/agents", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const q = ModeQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, "bad_request", "Mode must be paper or live.");
    const agents = await deps.prisma.agent.findMany({
      where: { userId: user.id, status: { not: "archived" }, ...(q.data.mode ? { mode: q.data.mode } : {}) },
      orderBy: { launchedAt: "desc" },
      select: { id: true },
    });
    const out = await Promise.all(agents.map((a) => loadAgentDTO(a.id)));
    return out.filter((x) => x).map((x) => x!.dto);
  });

  /** A paper agent runs in the open. A live agent shows a wallet's real money, so only its owner may read it. */
  async function mayRead(req: FastifyRequest, agent: { mode: string; userId: string }): Promise<boolean> {
    if (agent.mode !== "live") return true;
    const user = await currentUser(deps.prisma, req);
    return user?.id === agent.userId;
  }

  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const found = await loadAgentDTO(req.params.id);
    if (!found || !(await mayRead(req, found.agent))) return sendError(reply, 404, "not_found", "No such agent.");
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
      if (body.data.status === "active" && a.mode === "live") {
        // An order this agent placed that the engine has not written down yet is still moving the vault. Until
        // it is on record, the vault cannot be told apart from the order's own effect, so the agent waits.
        const lastDecided = await deps.prisma.decision.findFirst({ where: { agentId: a.id }, orderBy: { hour: "desc" }, select: { hour: true } });
        const unbooked = await deps.prisma.liveOrder.findFirst({ where: { agentId: a.id, ...(lastDecided ? { hour: { gt: lastDecided.hour } } : {}) }, select: { id: true } });
        if (unbooked) return sendError(reply, 409, "order_pending", "This agent's last order is still being written down. Try again in a few minutes.");
        // A live agent only resumes on a vault that can be traded right now.
        const vault = await checkVault(user, a.market, false, a.vault);
        if (!vault.ok) return sendError(reply, vault.status, vault.error, vault.message);
        await settleTokensTakenOutWhileStopped(a, vault);
      }
      await deps.prisma.agent.update({
        where: { id: a.id },
        // Resuming owes decisions from the next hour; paused hours are never backfilled.
        data: body.data.status === "active" ? { status: "active", pausedReason: null, owedFrom: new Date(nextHour(now())) } : { status: "paused", pausedReason: null },
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
    const a = await deps.prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, market: true, sentence: true, house: true, mode: true, userId: true } });
    if (!a || !(await mayRead(req, a))) return sendError(reply, 404, "not_found", "No such agent.");
    const rows = await deps.prisma.decision.findMany({
      where: { agentId: a.id, ...(q.data.before ? { hour: { lt: new Date(q.data.before) } } : {}) },
      orderBy: { hour: "desc" },
      take: q.data.limit,
    });
    return rows.map((d) => decisionDTO(d, a));
  });

  /** One mode at a time: virtual money and real money are never added together. */
  app.get<{ Querystring: Record<string, string> }>("/overview", async (req, reply): Promise<OverviewDTO | typeof reply> => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const q = ModeQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, "bad_request", "Mode must be paper or live.");
    const agents = await deps.prisma.agent.findMany({
      where: { userId: user.id, status: { not: "archived" }, mode: q.data.mode ?? "paper" },
      select: { id: true, name: true, market: true, sentence: true, house: true, startingCash: true, mode: true },
    });
    const ids = agents.map((a) => a.id);
    const byId = new Map(agents.map((a) => [a.id, a]));
    const rows = ids.length
      ? await deps.prisma.decision.findMany({
          where: { agentId: { in: ids } },
          orderBy: { hour: "asc" },
          select: { agentId: true, hour: true, equityAfter: true, holdingEquityAfter: true, basisAfter: true },
        })
      : [];
    const latestRows = ids.length ? await deps.prisma.decision.findMany({ where: { agentId: { in: ids } }, orderBy: { hour: "desc" }, take: 10 }) : [];
    const latest = latestRows.map((d) => decisionDTO(d, byId.get(d.agentId)!));
    if (!rows.length) return { agentCount: agents.length, kpis: null, series: [], latest };

    // Combined equity per hour: each agent's latest value carried forward, its base before its first decision.
    // A paper agent's base is its starting cash and never moves. A live agent's base moves with deposits and
    // withdrawals, so every hour is divided by the base it had at the time (stored with the decision).
    const active = [...new Set(rows.map((r) => r.agentId))];
    const firstBase = new Map<string, number>();
    const baseOf = (r: { agentId: string; basisAfter: number | null }) => (r.basisAfter != null && r.basisAfter > 0 ? r.basisAfter : byId.get(r.agentId)!.startingCash);
    for (const r of rows) if (!firstBase.has(r.agentId)) firstBase.set(r.agentId, baseOf(r));
    const eq = new Map(active.map((id) => [id, firstBase.get(id)!]));
    const hold = new Map(active.map((id) => [id, firstBase.get(id)!]));
    const base = new Map(active.map((id) => [id, firstBase.get(id)!]));
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const points: { t: number; e: number; h: number; b: number }[] = [];
    for (const r of rows) {
      eq.set(r.agentId, r.equityAfter);
      hold.set(r.agentId, r.holdingEquityAfter);
      base.set(r.agentId, baseOf(r));
      const p = { t: r.hour.getTime(), e: sum(eq), h: sum(hold), b: sum(base) };
      if (points.length && points[points.length - 1]!.t === p.t) points[points.length - 1] = p;
      else points.push(p);
    }
    const last = points[points.length - 1]!;
    const since = now() - 30 * 24 * HOUR_MS;
    const series: CurvePointDTO[] = points
      .filter((p) => p.t >= since)
      .filter((p) => p.b > 0)
      .map((p) => ({ t: new Date(p.t).toISOString(), strategy: (p.e / p.b) * 100, holding: (p.h / p.b) * 100 }));
    return {
      agentCount: agents.length,
      kpis: {
        equity: last.e,
        returnPct: (last.e / last.b - 1) * 100,
        holdingPct: (last.h / last.b - 1) * 100,
        maxDrawdownPct: maxDrawdownPct(points.map((p) => p.e / p.b), 1),
      },
      series,
      latest,
    };
  });
}

