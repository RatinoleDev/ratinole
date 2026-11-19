/** Engine configuration, read from the environment. No secrets live in code. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  databaseUrl: () => required("DATABASE_URL"),
  redisUrl: () => process.env.REDIS_URL ?? "redis://localhost:6379",
  /** Minute past each hour when agents run. Candles close on the hour. */
  runMinute: () => Math.min(59, Math.max(0, Number(process.env.ENGINE_RUN_MINUTE ?? 1))),
  /** Most hours one agent may catch up in a run (14 days). */
  maxCatchUpHours: () => Number(process.env.ENGINE_MAX_CATCHUP_HOURS ?? 336),
};
