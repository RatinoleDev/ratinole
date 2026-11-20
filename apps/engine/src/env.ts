/** Engine configuration, read from the environment. No secrets live in code. */
import { CHAIN } from "@rationale/config";

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
  /**
   * Live trading. All three are needed; without them the engine runs paper agents only.
   * The operator key signs swaps inside users' vaults. It can never withdraw. It is read here and nowhere else,
   * and is never logged.
   */
  operatorKey: () => process.env.OPERATOR_PRIVATE_KEY?.trim() || null,
  /** Once the key is in the signer's memory it is taken out of the environment, where tools and crash reports look. */
  forgetKeys: () => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.DEPLOYER_PRIVATE_KEY;
  },
  liveFactory: () => process.env.LIVE_FACTORY_ADDRESS?.trim() || null,
  liveRpcUrl: () => process.env.LIVE_RPC_URL?.trim() || CHAIN.rpcUrl,
  /** The owner paused live trading: live agents are left alone until it is lifted. Vaults are untouched. */
  liveTradingPaused: () => /^(1|true|yes)$/i.test(process.env.LIVE_TRADING_PAUSED?.trim() ?? ""),
};
