import { PAPER, RISK_LIMITS } from "@rationale/config";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, createSession, issueNonce, sessionIdFrom, setSessionCookie, verifySiwe } from "../auth";
import { allow, requireUser, sendError, type ApiDeps } from "../deps";

const VerifyBody = z.object({ message: z.string().min(20).max(2000), signature: z.string().min(10).max(1000) });
const SettingsBody = z
  .object({
    maxSizePct: z.number().min(RISK_LIMITS.maxSizePct.min).max(RISK_LIMITS.maxSizePct.max).optional(),
    dailyLossCapPct: z.number().min(RISK_LIMITS.dailyLossCapPct.min).max(RISK_LIMITS.dailyLossCapPct.max).optional(),
  })
  .strict();

export async function meDTO(deps: ApiDeps, user: { id: string; address: string; maxSizePct: number; dailyLossCapPct: number }) {
  const agentCount = await deps.prisma.agent.count({ where: { userId: user.id, status: { not: "archived" } } });
  return { address: user.address, maxSizePct: user.maxSizePct, dailyLossCapPct: user.dailyLossCapPct, agentCount, maxAgents: PAPER.maxAgentsPerUser };
}

export function authRoutes(app: FastifyInstance, deps: ApiDeps) {
  app.get("/auth/nonce", async (req, reply) => {
    if (!(await allow(deps.redis, `nonce:${req.ip}`, 30, 60))) return sendError(reply, 429, "rate_limited", "Too many sign-in attempts. Wait a minute.");
    return { nonce: await issueNonce(deps.redis) };
  });

  app.post("/auth/verify", async (req, reply) => {
    const body = VerifyBody.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, "bad_request", "Sign-in message and signature are required.");
    const res = await verifySiwe(body.data, { redis: deps.redis, appOrigin: deps.env.appOrigin });
    if (!res.ok) return sendError(reply, 401, "siwe_failed", res.message);
    const { sessionId, user, expiresAt } = await createSession(deps.prisma, res.address);
    setSessionCookie(reply, sessionId, expiresAt, deps.env.production);
    return meDTO(deps, user);
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = sessionIdFrom(req);
    if (sid) await deps.prisma.session.deleteMany({ where: { id: sid } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    return meDTO(deps, user);
  });

  /** The wallet's own limits. They apply to new backtests and agents; running agents keep the limits they launched with. */
  app.patch("/me", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const body = SettingsBody.safeParse(req.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        "bad_request",
        `Size per trade must be ${RISK_LIMITS.maxSizePct.min}% to ${RISK_LIMITS.maxSizePct.max}%, and the daily loss cap ${RISK_LIMITS.dailyLossCapPct.min}% to ${RISK_LIMITS.dailyLossCapPct.max}%.`,
      );
    }
    const updated = await deps.prisma.user.update({ where: { id: user.id }, data: body.data });
    return meDTO(deps, updated);
  });
}
