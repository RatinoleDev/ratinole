import type { PlanDrafter } from "@rationale/brain";
import type { PrismaClient, User } from "@rationale/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { currentUser } from "./auth";
import type { VaultReader } from "./chain";
import type { ApiEnv } from "./env";

export interface ApiDeps {
  prisma: PrismaClient;
  redis: Redis;
  env: ApiEnv;
  /** Queue a job for the engine. */
  enqueue: (name: "backtest", data: { backtestId: string }, jobId: string) => Promise<void>;
  /** The LLM drafter for a user, or null when no LLM is configured. */
  drafterFor: (userId: string) => PlanDrafter | null;
  /** Reads vaults on Robinhood Chain. Null while live trading is off. It holds no key. */
  vaults: VaultReader | null;
  now?: () => number;
}

export function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/** Returns the signed-in user, or sends 401 and returns null. */
export async function requireUser(deps: ApiDeps, req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const user = await currentUser(deps.prisma, req);
  if (!user) {
    await sendError(reply, 401, "unauthorized", "Connect your wallet and sign in first.");
    return null;
  }
  return user;
}

/** Fixed-window rate limit. Returns true when the call is allowed. */
export async function allow(redis: Redis, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const k = `rl:${key}`;
  const n = await redis.incr(k);
  // The window's end is set on the first count, and again whenever it is found missing: a command lost between
  // the two must not leave a counter that never runs out and locks a wallet out for good.
  if (n === 1 || (await redis.ttl(k)) < 0) await redis.expire(k, windowSeconds);
  return n <= limit;
}
