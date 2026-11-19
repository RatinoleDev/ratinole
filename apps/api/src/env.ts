/** API configuration from the environment. Secrets are never written in code. */
export interface ApiEnv {
  port: number;
  appOrigin: string;
  sessionSecret: string;
  redisUrl: string;
  anthropicApiKey: string | null;
  llmModel: string;
  llmMonthlyBudgetUsd: number;
  production: boolean;
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
  };
}
