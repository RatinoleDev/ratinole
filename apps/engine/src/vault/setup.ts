/** Builds the engine's chain access from the environment, or returns null when live trading is not set up. */
import type { Hex } from "viem";
import { env } from "../env";
import { log } from "../log";
import { viemVaultChain, type VaultChain } from "./chain";

export function liveChainFromEnv(): VaultChain | null {
  const key = env.operatorKey();
  const factory = env.liveFactory();
  if (!key && !factory) return null;
  if (env.liveTradingPaused()) {
    log("warn", "live trading is paused (LIVE_TRADING_PAUSED): live agents are left alone");
    return null;
  }
  if (!key || !factory) {
    log("warn", "live trading is off: set both OPERATOR_PRIVATE_KEY and LIVE_FACTORY_ADDRESS to turn it on");
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    log("error", "live trading is off: OPERATOR_PRIVATE_KEY is not a 0x-prefixed 32-byte key");
    return null;
  }
  const chain = viemVaultChain({ rpcUrl: env.liveRpcUrl(), privateKey: key as Hex });
  log("info", "live trading is on", { operator: chain.operator, factory });
  return chain;
}
