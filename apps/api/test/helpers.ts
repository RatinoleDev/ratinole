import { prisma } from "@rationale/db";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { ApiDeps } from "../src/deps";
import type { ApiEnv } from "../src/env";
import { buildServer } from "../src/server";

export const env: ApiEnv = {
  port: 0,
  appOrigin: "http://localhost:3000",
  sessionSecret: "test-secret-test-secret-test-secret-0123456789",
  redisUrl: "redis://localhost:6379/15",
  anthropicApiKey: null,
  llmModel: "claude-opus-5-5",
  llmMonthlyBudgetUsd: 20,
  production: false,
};

export const redis = new Redis(env.redisUrl);

export async function wipe() {
  await redis.flushdb();
  await prisma.llmUsage.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.agentState.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.backtest.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}

export function makeApp(over: Partial<ApiDeps> = {}) {
  const enqueued: { name: string; data: unknown; jobId: string }[] = [];
  const deps: ApiDeps = {
    prisma,
    redis,
    env,
    enqueue: async (name, data, jobId) => {
      enqueued.push({ name, data, jobId });
    },
    drafterFor: () => null,
    ...over,
  };
  return { deps, enqueued, app: buildServer(deps) };
}

export async function signIn(app: FastifyInstance, opts: { key?: `0x${string}`; domain?: string; chainId?: number } = {}) {
  const account = privateKeyToAccount(opts.key ?? generatePrivateKey());
  const { nonce } = (await app.inject({ method: "GET", url: "/api/auth/nonce" })).json() as { nonce: string };
  const message = createSiweMessage({
    address: account.address,
    chainId: opts.chainId ?? 4663,
    domain: opts.domain ?? "localhost:3000",
    nonce,
    uri: `http://${opts.domain ?? "localhost:3000"}`,
    version: "1",
    statement: "Sign in to Rationale. This signature does not move funds or approve anything.",
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { message, signature } });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  return { res, cookie, address: account.address.toLowerCase(), message, signature, account };
}

export const validDraft = (over: Record<string, unknown> = {}) => ({
  understood: true,
  problem: null,
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [
    { signal: "rsi", op: "<", value: 30, window: null },
    { signal: "trend_pct", op: ">", value: 0, window: null },
  ],
  exit: { takeProfitPct: 8, stopLossPct: 4, trailingStopPct: null, conditions: [] },
  filters: ["negative_news"],
  sizePctOfCash: 25,
  weights: [],
  cadenceHours: null,
  ...over,
});
