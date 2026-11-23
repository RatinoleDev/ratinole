/** Paper accounting: virtual cash, one position per agent, simulated costs. */
import { HOUR_MS } from "./types";

export interface PositionState {
  cash: number;
  qty: number;
  /** Cost per unit including the buy cost; null when flat. */
  avgEntry: number | null;
  /** Highest close since buying, for trailing stops; null when flat. */
  peak: number | null;
  /** Hour (ms) of the last buy. */
  lastBuyAt: number | null;
  /** Start of the current UTC day (ms). */
  dayStart: number;
  /** Equity at the start of the current UTC day. */
  dayStartEquity: number;
  /**
   * Open time (ms) of the newest candle whose close the trailing-stop high has taken in. After hours the agent
   * could not read (stale data, or the engine was down) every close since this one is looked at, as far back as
   * the prices loaded for the decision reach (about a month). Null or absent when flat, and on positions opened
   * before this was kept.
   */
  peakSeenTo?: number | null;
  /**
   * A stop or an exit rule that was reached and whose sale did not complete: the order was refused or late, or
   * the vault's daily limit let only part of the position go. While this is open the agent sells in every hour
   * it can, whether or not the exit still holds, the way a stop that was hit stays an order to sell. It lapses
   * after OPEN_EXIT_HOURS, and is cleared when the position is closed. A take profit is never kept open: it
   * only ever sells while its target is reached. Paper sales always complete, so this is only set for live agents.
   */
  exitPending?: ExitPending | null;
}

/** How long an exit whose sale did not complete stays an order to sell. After that the exits are checked afresh. */
export const OPEN_EXIT_HOURS = 48;
/** A take profit sells at its target or above, never below. The other exits, once reached, stay orders to sell. */
export const staysOpen = (kind: ExitKind): boolean => kind !== "take profit";
/**
 * The exit that is open on a position at `hour`, if any: one of a kind that stays open, reached no longer ago
 * than OPEN_EXIT_HOURS. Everything that asks "is there still an order to sell?" asks here.
 */
export function openExit(s: Pick<PositionState, "exitPending">, hour: number): ExitPending | null {
  const p = s.exitPending;
  return p && staysOpen(p.kind) && hour - p.since <= OPEN_EXIT_HOURS * HOUR_MS ? p : null;
}

export type ExitKind = "take profit" | "stop loss" | "trailing stop" | "exit rule";
export interface ExitPending {
  /** The hour (ms) the exit was first reached. */
  since: number;
  kind: ExitKind;
}

export interface Fill {
  side: "buy" | "sell";
  price: number;
  qty: number;
  notional: number;
  fee: number;
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / (24 * HOUR_MS)) * 24 * HOUR_MS;
}

export function initialState(cash: number, hour: number): PositionState {
  return { cash, qty: 0, avgEntry: null, peak: null, lastBuyAt: null, dayStart: utcDayStart(hour), dayStartEquity: cash };
}

export function equityOf(s: PositionState, price: number): number {
  return s.cash + s.qty * price;
}

/** Start a new UTC day if `hour` falls in one. */
export function rollDay(s: PositionState, hour: number, price: number): PositionState {
  const day = utcDayStart(hour);
  if (day === s.dayStart) return s;
  return { ...s, dayStart: day, dayStartEquity: equityOf(s, price) };
}

export function applyBuy(s: PositionState, price: number, pctOfCash: number, costPct: number, hour: number): { state: PositionState; fill: Fill } | null {
  const notional = s.cash * (pctOfCash / 100);
  if (!(notional > 0.01) || !(price > 0)) return null;
  const fee = notional * (costPct / 100);
  const qty = (notional - fee) / price;
  const newQty = s.qty + qty;
  const avgEntry = ((s.avgEntry ?? 0) * s.qty + notional) / newQty;
  return {
    state: {
      ...s,
      cash: s.cash - notional,
      qty: newQty,
      avgEntry,
      peak: Math.max(s.peak ?? price, price),
      lastBuyAt: hour,
    },
    fill: { side: "buy", price, qty, notional, fee },
  };
}

export function applySell(s: PositionState, price: number, costPct: number): { state: PositionState; fill: Fill } | null {
  if (!(s.qty > 0) || !(price > 0)) return null;
  const gross = s.qty * price;
  const fee = gross * (costPct / 100);
  return {
    state: { ...s, cash: s.cash + gross - fee, qty: 0, avgEntry: null, peak: null, peakSeenTo: null, exitPending: null },
    fill: { side: "sell", price, qty: s.qty, notional: gross, fee },
  };
}

/**
 * Live trading: what really happened to an order, read from the chain after the swap, or why there was none.
 * Amounts are in whole units (dollars, tokens), already converted from the token's decimals.
 *  - buy: `notional` dollars left the vault and `qty` tokens arrived; `fee` is the pool fee inside the notional.
 *  - sell: `qty` tokens left the vault; `notional` is their value before the pool fee and `notional - fee`
 *    dollars arrived.
 */
export type LiveFill =
  | {
      ok: true;
      side: "buy" | "sell";
      qty: number;
      notional: number;
      fee: number;
      /** Why the order was smaller than the plan asked for, as a sentence. It is added to the explanation. */
      note?: string;
    }
  | { ok: false; reason: string };

type DoneFill = Extract<LiveFill, { ok: true }>;

/** Book a real buy. The price is what was paid per token after the pool fee, so it includes price impact. */
export function settleBuy(s: PositionState, f: DoneFill, hour: number): { state: PositionState; fill: Fill } | null {
  if (!(f.qty > 0) || !(f.notional > 0)) return null;
  const price = (f.notional - f.fee) / f.qty;
  const newQty = s.qty + f.qty;
  return {
    state: {
      ...s,
      cash: Math.max(0, s.cash - f.notional),
      qty: newQty,
      avgEntry: ((s.avgEntry ?? 0) * s.qty + f.notional) / newQty,
      peak: Math.max(s.peak ?? price, price),
      lastBuyAt: hour,
    },
    fill: { side: "buy", price, qty: f.qty, notional: f.notional, fee: f.fee },
  };
}

/** Book a real sell. Anything smaller than a millionth of a token left over counts as flat. */
export function settleSell(s: PositionState, f: DoneFill): { state: PositionState; fill: Fill } | null {
  if (!(f.qty > 0) || !(f.notional > 0)) return null;
  const left = s.qty - f.qty;
  const flat = left < 1e-6;
  return {
    state: {
      ...s,
      cash: s.cash + f.notional - f.fee,
      qty: flat ? 0 : left,
      avgEntry: flat ? null : s.avgEntry,
      peak: flat ? null : s.peak,
      peakSeenTo: flat ? null : s.peakSeenTo,
      exitPending: flat ? null : s.exitPending,
    },
    fill: { side: "sell", price: f.notional / f.qty, qty: f.qty, notional: f.notional, fee: f.fee },
  };
}
