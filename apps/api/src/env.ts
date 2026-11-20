/** API configuration from the environment. Secrets are never written in code. */
import { CHAIN, LIVE } from "@rationale/config";

/** Unset: the beta cap. "0" or "none": no cap. Anything else: that many dollars. */
function maxVaultUsd(raw: string | undefined): number | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return LIVE.betaMaxVaultUsd;
  if (v === "0" || v === "none") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : LIVE.betaMaxVaultUsd;
}

export interface ApiEnv {
  port: number;
  appOrigin: string;
  sessionSecret: string;
  redisUrl: string;
  anthropicApiKey: string | null;
  llmModel: string;
  llmMonthlyBudgetUsd: number;
  production: boolean;
  /** Live trading: the vault factory on Robinhood Chain. Null keeps live trading off. */
  liveFactory: string | null;
  liveRpcUrl: string;
  /** The most a vault may hold when a live agent is launched, in dollars; null for no cap. */
  liveMaxVaultUsd: number | null;
  /** The owner paused live trading: vaults stay reachable, but no live agent starts, resumes or trades. */
  liveTradingPaused: boolean;
}

export function readEnv(): ApiEnv {
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters");
  return {
    port: Number(process.env.API_PORT ?? 4000),
    appOrigin: process.env.APP_ORIGIN ?? "http://localhost:3000",
    sessionSecret,
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    llmModel: process.env.LLM_MODEL || "claude-opus-5-5",
    llmMonthlyBudgetUsd: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 20),
    production: process.env.NODE_ENV === "production",
    liveFactory: /^0x[0-9a-fA-F]{40}$/.test(process.env.LIVE_FACTORY_ADDRESS?.trim() ?? "") ? process.env.LIVE_FACTORY_ADDRESS!.trim() : null,
    liveRpcUrl: process.env.LIVE_RPC_URL?.trim() || CHAIN.rpcUrl,
    liveMaxVaultUsd: maxVaultUsd(process.env.LIVE_MAX_VAULT_USD),
    liveTradingPaused: /^(1|true|yes)$/i.test(process.env.LIVE_TRADING_PAUSED?.trim() ?? ""),
  };
}
