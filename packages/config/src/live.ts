/**
 * Live trading on Robinhood Chain: real money in a vault that only its owner can withdraw from. The agent's key
 * may only swap inside the vault, within the limits the owner set. Token addresses mirror
 * contracts/config/robinhood.json; the vault itself is always asked whether a token is allowed.
 */
import type { MarketId } from "./constants";

export type Address = `0x${string}`;

export interface LiveToken {
  symbol: string;
  address: Address;
  decimals: number;
}

/** The dollar stablecoin every vault trades against. */
export const LIVE_STABLE: LiveToken = { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 };

/** The token a market's agent holds when it is in position. */
export const LIVE_TOKENS: Record<MarketId, LiveToken> = {
  ETH: { symbol: "WETH", address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", decimals: 18 },
  BTC: { symbol: "cbBTC", address: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4", decimals: 8 },
};

export const LIVE = {
  /** One vault per wallet, and one live agent trading it: two agents would fight over the same money. */
  maxAgentsPerVault: 1,
  /** A vault needs at least this much to launch a live agent, in dollars. */
  minVaultUsd: 5,
  /**
   * While the contracts have not had an independent security audit: the most a vault may hold when a live agent
   * is launched, in dollars. The owner raises or removes it with LIVE_MAX_VAULT_USD.
   */
  betaMaxVaultUsd: 500,
  /** An order is only placed this soon after its hour. A later run records the decision without trading. */
  orderWindowMs: 20 * 60_000,
  /** What the guard assumes a trade costs (pool fee plus typical price impact), in percent. */
  costPct: 0.1,
  /**
   * How far the pool may move between the engine's dry run and the block the order lands in, in basis points.
   * Further than this and the order is refused on-chain instead of filled at a worse price. The vault's own
   * slippage limit against the oracle still applies on top.
   */
  maxDriftBps: 50,
  /** Limits suggested when a vault is created. The owner can change both at any time. */
  defaults: { maxSlippageBps: 100, dailyLimitUsd: 200 },
  /** Hard bounds the vault contract accepts for slippage, in basis points. */
  slippageBps: { min: 10, max: 500 },
} as const;

/** Whole units from raw token units. For display and decisions; orders always use the raw amount. */
export function fromUnits(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** Raw token units from whole units, rounded down so an order never asks for more than there is. */
export function toUnits(amount: number, decimals: number): bigint {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0n;
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  const raw = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0").slice(0, decimals) || "0");
  // toFixed rounds to nearest; step back if that went past the true value.
  return fromUnits(raw, decimals) > amount ? raw - 1n : raw;
}

export const explorerTx = (explorerUrl: string, hash: string) => `${explorerUrl}/tx/${hash}`;
export const explorerAddress = (explorerUrl: string, address: string) => `${explorerUrl}/address/${address}`;
