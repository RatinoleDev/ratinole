/**
 * Meme vaults: trading launchpad tokens against ETH, in a vault of the owner's own.
 *
 * These tokens have no price oracle and no hourly candles, so nothing here goes through the strategy brain. A meme
 * agent does one thing the owner asked for by name: buy this token with this much ETH now, then sell it all when
 * it is up by X or down by Y. The numbers the agent acts on are read from the chain at the moment it acts.
 */
import type { Address } from "./live";

/** The pons v2 launchpad on Robinhood Chain (docs.ponsfamily.com/v2). Same addresses as contracts/config/robinhood.json. */
export const PONS = {
  name: "Pons",
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address,
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address,
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  docsUrl: "https://docs.ponsfamily.com/v2",
  tokenPage: (token: string) => `https://ponsfamily.com/launchpad/${token.toLowerCase()}`,
} as const;

/** Where a pons launch is in its life. The factory's record says which; nothing else is trusted for it. */
export const PONS_PHASE = { curve: 0, swept: 1, pool: 2, rescued: 3 } as const;
export type MemePhase = "curve" | "moving" | "pool" | "rescued";
export const memePhase = (phase: number): MemePhase => (phase === PONS_PHASE.curve ? "curve" : phase === PONS_PHASE.swept ? "moving" : phase === PONS_PHASE.pool ? "pool" : "rescued");

/** Errors a pons curve can answer with, so that a refusal can be put in plain words. */
export const PONS_CURVE_ERRORS_ABI = [
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "CurveGraduated", inputs: [] },
  { type: "error", name: "NativeValueMismatch", inputs: [] },
] as const;

/** The parts of a launch's curve the app reads. */
export const PONS_CURVE_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "quoteReserve", type: "uint256" }, { name: "tokenReserve", type: "uint256" }] },
  { type: "function", name: "realQuoteReserve", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "readyToGraduate", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;

export const MEME = {
  /** How often the engine looks at each open position, in seconds. A stop or a target is acted on at a look, not between two. */
  checkEverySeconds: 60,
  /** An order is refused by the vault this long after it was signed, so one left unsent can never trade later. */
  orderWindowSeconds: 120,
  /**
   * How far the price may move between the engine's dry run and the block the order lands in, in basis points.
   * Further than this and the order is refused on-chain instead of filled at a worse price. These tokens move
   * fast, so the room is wider than for ETH and BTC.
   */
  maxDriftBps: 300,
  /** Gas given to every order, at least. A buy that happens to finish a launch's curve also moves it into its pool. */
  minGas: 1_800_000,
  /** The smallest and the largest buy an agent can be launched with, in ETH. The largest holds while the contracts are unaudited. */
  minBuyEth: 0.0005,
  betaMaxBuyEth: 0.25,
  /** Suggested when a vault is created. The owner can change it at any time. */
  defaults: { dailyBuyLimitEth: 0.1 },
  /** Bounds for the two exits, in percent of the price right after the buy. */
  takeProfitPct: { min: 5, max: 2000 },
  stopLossPct: { min: 5, max: 95 },
  /** One open position per token in a vault: two agents on one token would sell each other's tokens. */
  maxOpenPerVault: 5,
  /** How many times in a row a buy that the market refused is tried again before the agent stops and says why. */
  buyTries: 3,
  /** Under this much left of a position (in wei of sale value) there is nothing worth selling. */
  dustWei: 1_000_000_000n,
} as const;

/** The least accepted from a trade the dry run quoted at `quote`. */
export const memeMinOut = (quote: bigint): bigint => quote - (quote * BigInt(MEME.maxDriftBps)) / 10_000n;

/** Percent change from `from` to `to`, both in wei. */
export function weiChangePct(from: bigint, to: bigint): number {
  if (from <= 0n) return 0;
  return Number(((to - from) * 1_000_000n) / from) / 10_000;
}

/** ETH as a short decimal string for sentences: up to 6 significant decimals, no trailing zeros. */
export function ethText(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0");
  // Six decimals, or as many as it takes to show two significant digits of a small amount.
  const firstDigit = frac.search(/[1-9]/);
  const places = firstDigit < 0 ? 0 : Math.min(18, Math.max(6, firstDigit + 2));
  const cut = frac.slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${cut ? `.${cut}` : ""}`;
}

export type MemeExitKind = "take profit" | "stop loss" | "sold by owner";
