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
  /**
   * Every order carries a deadline this long after the order window closes, and the vault refuses it afterwards.
   * A signed order can therefore never sit somewhere unsent and trade later: 25 minutes into its hour it is dead.
   */
  orderGraceMs: 5 * 60_000,
  /** The smallest order the agent places, in dollars. Selling a whole position is always allowed, whatever its size. */
  minOrderUsd: 1,
  /**
   * A position the agent has on record is still a position while it is worth at least this, in dollars. Below it
   * there is nothing left that could be sold. Well under the smallest order, so the agent's own buys stay above it.
   */
  positionFloorUsd: 0.25,
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

/** The moment (unix seconds) after which the vault refuses an order placed for `hourMs`. */
export const orderDeadline = (hourMs: number) => Math.floor((hourMs + LIVE.orderWindowMs + LIVE.orderGraceMs) / 1000);

/**
 * Do tokens the agent did not buy itself count as its position? Used when an agent starts, and whenever an agent
 * with no position finds tokens in its vault. One rule, shared by the API and the engine.
 *
 * Anyone can send any vault a little of a token. If a little were enough to make an agent "in position", a
 * stranger could stop it from ever buying for the price of a coffee. So the tokens only count when they are worth
 * at least one of the plan's own orders: sending that much is a gift, not an attack. Smaller amounts are left
 * alone, and become part of the position the next time the agent buys.
 */
export function strayTokensArePosition(tokenUsd: number, cashUsd: number, sizePctOfCash: number): boolean {
  return tokenUsd >= Math.max(LIVE.minOrderUsd, (cashUsd * sizePctOfCash) / 100);
}

/**
 * Could this much of a token be worth a dollar, when no price is known for it? Judged at a million dollars a
 * token, far above anything traded here, so that only true specks pass as nothing. Used where a balance without
 * a price must either be counted or ignored.
 */
export const couldBeWorthADollar = (qty: number) => qty * 1_000_000 >= 1;

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

export type ParsedAmount =
  | { ok: true; raw: bigint; /** Set when digits beyond the token's decimals were dropped. */ note: string | null }
  | { ok: false; /** Why it cannot be used. Null while the field is empty: there is nothing to say yet. */ error: string | null };

/**
 * An amount a person typed, as raw token units. It never rounds up and never guesses: "1,000" is one in some
 * countries and a thousand in others, so it is refused with the reason instead of being read either way.
 * A single comma is otherwise read as the decimal mark ("10,5" is ten and a half).
 */
export function parseAmount(text: string, decimals: number): ParsedAmount {
  // Only the ends are trimmed. A space between digits ("1 5") is not dropped: that would turn it into fifteen.
  const t = text.trim();
  if (t === "") return { ok: false, error: null };
  if (!/^[0-9.,]+$/.test(t)) return { ok: false, error: /\s/.test(t) ? "Write the amount without spaces, like 1000.50." : "Use digits only, like 100 or 0.5." };
  const dots = t.split(".").length - 1;
  const commas = t.split(",").length - 1;
  let plain = t;
  if (commas > 0) {
    if (dots > 0 || commas > 1) return { ok: false, error: "Write the amount without thousands separators, like 1000.50." };
    const [head = "", tail = ""] = t.split(",");
    if (tail.length === 3 && /[1-9]/.test(head)) return { ok: false, error: `Is that ${head}.${tail} or ${head}${tail}? Write it with a dot, or without the comma.` };
    plain = `${head}.${tail}`;
  } else if (dots > 1) {
    return { ok: false, error: "Write the amount with one dot, like 1000.50." };
  }
  const [wholeText = "", frac = ""] = plain.split(".");
  if (wholeText === "" && frac === "") return { ok: false, error: "Enter an amount." };
  const whole = wholeText.replace(/^0+(?=\d)/, "") || "0";
  const kept = frac.slice(0, decimals);
  const dropped = /[1-9]/.test(frac.slice(decimals));
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept.padEnd(decimals, "0") || "0");
  if (raw === 0n) return { ok: false, error: dropped ? "That is smaller than the smallest amount of this token." : "Enter an amount above zero." };
  return { ok: true, raw, note: dropped ? `Only ${decimals} decimals count: using ${whole}.${kept}.` : null };
}

export const explorerTx = (explorerUrl: string, hash: string) => `${explorerUrl}/tx/${hash}`;
export const explorerAddress = (explorerUrl: string, address: string) => `${explorerUrl}/address/${address}`;
