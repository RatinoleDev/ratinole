/**
 * Replays the exact decision code over historical candles. A decision at the
 * close of candle i fills at the open of candle i+1, so the last decision needs
 * one more candle after it. Indicators are causal, so precomputing them over all
 * candles leaks nothing from the future.
 */
import { decideStep, type DecideContext } from "../decide";
import { initialState, type Fill } from "../paper";
import type { SeriesSource } from "../signals";
import { HOUR_MS, type Decision } from "../types";
import { maxDrawdownPct, returnPct } from "./metrics";

export interface SimTrade extends Fill {
  hour: number;
}

export interface SimResult {
  /** Hour of each decision. */
  hours: number[];
  /** Strategy equity after each decision. */
  equity: number[];
  /** Buy-and-hold equity at each decision (bought at the first fill, same cost). */
  holding: number[];
  trades: SimTrade[];
  returnPct: number;
  holdingPct: number;
  maxDrawdownPct: number;
  /** Decisions, only when `keepDecisions` is set. */
  decisions?: Decision[];
}

export interface SimOptions {
  ctx: DecideContext;
  src: SeriesSource;
  /** First decision index (inclusive). */
  start: number;
  /** Last decision index (exclusive). Must be <= candles.length - 1. */
  end: number;
  startCash: number;
  keepDecisions?: boolean;
}

export function simulate(o: SimOptions): SimResult {
  const { src, ctx } = o;
  const end = Math.min(o.end, src.length - 1);
  if (o.start >= end) throw new Error("Empty simulation window");
  const firstHour = src.candles[o.start]!.t + HOUR_MS;
  let state = initialState(o.startCash, firstHour);
  const firstFill = src.candles[o.start + 1]!.o;
  const holdQty = (o.startCash * (1 - ctx.costPct / 100)) / firstFill;

  const hours: number[] = [];
  const equity: number[] = [];
  const holding: number[] = [];
  const trades: SimTrade[] = [];
  const decisions: Decision[] = [];

  for (let i = o.start; i < end; i++) {
    const hour = src.candles[i]!.t + HOUR_MS;
    const fillPrice = src.candles[i + 1]!.o;
    const out = decideStep(ctx, { src, i, hour, state, fillPrice, explain: o.keepDecisions === true });
    state = out.state;
    if (out.fill) trades.push({ ...out.fill, hour });
    hours.push(hour);
    equity.push(out.equity);
    holding.push(holdQty * fillPrice);
    if (o.keepDecisions) decisions.push(out.decision);
  }

  return {
    hours,
    equity,
    holding,
    trades,
    returnPct: returnPct(equity, o.startCash),
    holdingPct: returnPct(holding, o.startCash),
    maxDrawdownPct: maxDrawdownPct(equity, o.startCash),
    ...(o.keepDecisions ? { decisions } : {}),
  };
}
