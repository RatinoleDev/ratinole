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
    state: { ...s, cash: s.cash + gross - fee, qty: 0, avgEntry: null, peak: null },
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
      /** Why the order was smaller than the plan asked for, as a sentence. It replaces "N% of cash" in the explanation. */
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
    },
    fill: { side: "sell", price: f.notional / f.qty, qty: f.qty, notional: f.notional, fee: f.fee },
  };
}
