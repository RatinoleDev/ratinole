/**
 * One agent, one hour: Regime -> Weigh -> Guard -> Decision (HANDOFF 5.2,
 * steps 2-4, plus the template explanation). Pure: the same inputs always give
 * the same Decision, which is what makes paper results reproducible and lets the
 * backtester call exactly this code.
 *
 * Timing: a decision for `hour` sees only candles that closed at or before
 * `hour`. Any trade fills at the opening price of the hour that starts at `hour`.
 */
import { describeCondition, type WindowMap } from "./describe";
import {
  combineConfidence,
  contextEvidence,
  negate,
  pct,
  readCondition,
  resolveConditions,
} from "./evidence";
import { explain, usd, type Situation } from "./explain";
import { runGuard, vetoes } from "./guard";
import { applyBuy, applySell, equityOf, rollDay, type Fill, type PositionState } from "./paper";
import { classifyRegime, type RegimeParams } from "./regime";
import { SeriesSource, formatSignalValue, type SignalId } from "./signals";
import { HOUR_MS, type Action, type Candle, type Decision, type EvidenceItem, type Filter, type GuardCheck, type Plan } from "./types";

export interface AgentParams {
  /** Minimum confidence (0-100) to open a position. Not applied to scheduled dca buys. */
  confidenceThreshold: number;
  /** Lookbacks chosen by the tuner for conditions whose sentence gave none. */
  windows: WindowMap;
}

export const DEFAULT_PARAMS: AgentParams = { confidenceThreshold: 50, windows: {} };

export interface DecideContext {
  agentId: string;
  plan: Plan;
  params: AgentParams;
  limits: { maxSizePct: number; dailyLossCapPct: number };
  /** Simulated fee plus slippage per trade, percent. */
  costPct: number;
  /** Market name used in explanations; defaults to the plan's first market. */
  market?: string;
  regimeParams?: RegimeParams;
}

export interface StepInput {
  src: SeriesSource;
  /** Index of the candle that closes at `hour`. */
  i: number;
  /** The hour boundary, ms since epoch. */
  hour: number;
  state: PositionState;
  /** Opening price of the hour starting at `hour`; null when not known yet. */
  fillPrice: number | null;
  /** Skip building the explanation text (backtests). Default true. */
  explain?: boolean;
}

export interface StepOutput {
  decision: Decision;
  fill: Fill | null;
  state: PositionState;
  /** Equity after any fill, marked at the fill price (or the last close). */
  equity: number;
  markPrice: number;
}

const NOT_CHECKED_SHORT: Partial<Record<Filter, string>> = {
  negative_news: "news filter (headlines not collected yet)",
  earnings_week: "earnings filter (event calendar not collected yet)",
  macro_print: "macro filter (event calendar not collected yet)",
};

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function freshness(candle: Candle, hour: number, fillPrice: number | null, hasHistory: boolean): { ok: boolean; detail: string } {
  if (!hasHistory) return { ok: false, detail: "Not enough price history to read the market yet." };
  const expected = hour - HOUR_MS;
  if (candle.t !== expected) {
    const ago = Math.round((hour - (candle.t + HOUR_MS)) / HOUR_MS);
    return {
      ok: false,
      detail: `The latest candle closed at ${hhmm(candle.t + HOUR_MS)} UTC, ${ago} hour${ago === 1 ? "" : "s"} before this run. Waiting for fresh data.`,
    };
  }
  if (fillPrice == null) return { ok: false, detail: `No opening price yet for the hour starting ${hhmm(hour)} UTC.` };
  return { ok: true, detail: `The hourly candle to ${hhmm(hour)} UTC is in.` };
}

/** Evidence about an open position, and whether a price exit has been reached. */
function positionEvidence(state: PositionState, close: number, plan: Plan): { items: EvidenceItem[]; reason: string | null; pnlPct: number } {
  const entry = state.avgEntry ?? close;
  const pnlPct = (close / entry - 1) * 100;
  const { takeProfitPct: tp, stopLossPct: sl, trailingStopPct: trail } = plan.exit;
  let score = 0;
  if (tp != null && pnlPct >= 0) score = Math.min(1, pnlPct / tp);
  else if (sl != null && pnlPct < 0) score = Math.min(1, -pnlPct / sl);
  const items: EvidenceItem[] = [
    { name: "Since buying", value: `${pct(pnlPct)} (average entry ${usd(entry)})`, score: Math.round(score * 100) },
  ];
  let reason: string | null = null;
  if (tp != null && pnlPct >= tp) reason = `Take profit reached: ${pct(pnlPct)} since buying, target +${tp}%.`;
  else if (sl != null && pnlPct <= -sl) reason = `Stop loss reached: ${pct(pnlPct)} since buying, stop at −${sl}%.`;
  if (trail != null && state.peak != null) {
    const dd = (close / state.peak - 1) * 100;
    items.push({
      name: "Trailing stop",
      value: `${pct(dd)} from the high since buying (stop ${trail}% under it)`,
      score: Math.round(Math.min(1, Math.max(0, -dd / trail)) * 100),
    });
    if (!reason && dd <= -trail) reason = `Trailing stop reached: ${Math.abs(dd).toFixed(1)}% under the high since buying.`;
  }
  return { items, reason, pnlPct };
}

function exitSummary(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.exit.takeProfitPct != null) out.push(`Take profit at +${plan.exit.takeProfitPct}%`);
  if (plan.exit.stopLossPct != null) out.push(`stop at −${plan.exit.stopLossPct}%`);
  if (plan.exit.trailingStopPct != null) out.push(`trailing stop ${plan.exit.trailingStopPct}%`);
  if (out[0]) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  return out;
}

export function decideStep(ctx: DecideContext, inp: StepInput): StepOutput {
  const { src, i, hour, fillPrice } = inp;
  const plan = ctx.plan;
  const market = ctx.market ?? plan.markets[0] ?? "";
  const candle = src.candles[i];
  if (!candle) throw new Error(`No candle at index ${i}`);
  const close = candle.c;
  const mark = fillPrice ?? close;

  let state = rollDay(inp.state, hour, mark);
  if (state.qty > 0) state = { ...state, peak: Math.max(state.peak ?? close, close) };

  const reading = classifyRegime(src, i, ctx.regimeParams);
  const regime = reading?.regime ?? "ranging";
  const fresh = freshness(candle, hour, fillPrice, reading != null);
  const notChecked = plan.filters.map((f) => NOT_CHECKED_SHORT[f]).filter((x): x is string => !!x);
  const ctxBuy = reading ? contextEvidence(src, i, reading) : [];

  const entry = resolveConditions(plan.entry, "entry", ctx.params.windows).map((rc) => readCondition(src, i, rc));
  const exitConds = resolveConditions(plan.exit.conditions ?? [], "exit", ctx.params.windows).map((rc) => readCondition(src, i, rc));
  const allEntryHold = entry.every((r) => r.holds);

  const equityBefore = equityOf(state, mark);
  const dailyPnlPct = state.dayStartEquity > 0 ? (equityBefore / state.dayStartEquity - 1) * 100 : 0;
  const guardFor = (action: "buy" | "sell"): GuardCheck[] =>
    runGuard({
      action,
      fresh,
      sizePctOfCash: plan.sizePctOfCash,
      maxSizePct: ctx.limits.maxSizePct,
      dailyPnlPct,
      dailyLossCapPct: ctx.limits.dailyLossCapPct,
      regime,
      standsAsideWhenStressed: plan.filters.includes("stressed_regime"),
      costPct: ctx.costPct,
    });

  const cadenceMs = (plan.cadenceHours ?? 0) * HOUR_MS;
  const dcaDue = plan.kind === "dca" && cadenceMs > 0 && (state.lastBuyAt == null || hour - state.lastBuyAt >= cadenceMs);

  let action: Action = "hold";
  let confidence: number;
  let evidence: EvidenceItem[];
  let guard: GuardCheck[];
  let fill: Fill | null = null;
  let situation: Situation;

  const tryBuy = (): void => {
    const ruleItems = entry.map((r) => r.item);
    const buyConf = combineConfidence(ruleItems, ctxBuy);
    evidence = [...ruleItems, ...ctxBuy];
    guard = guardFor("buy");
    const wants = plan.kind === "dca" ? dcaDue && allEntryHold : allEntryHold && buyConf >= ctx.params.confidenceThreshold;
    confidence = 100 - buyConf;
    if (!fresh.ok) {
      situation = { type: "stale", detail: fresh.detail };
      return;
    }
    if (!wants) {
      if (plan.kind === "dca" && !dcaDue) {
        const left = Math.max(1, Math.ceil(((state.lastBuyAt ?? hour) + cadenceMs - hour) / HOUR_MS));
        situation = { type: "not_due", hoursLeft: left };
      } else if (!allEntryHold) {
        situation = { type: "waiting", unmet: entry.filter((r) => !r.holds), buyConfidence: buyConf };
      } else {
        const weakest = [...evidence].sort((a, b) => a.score - b.score)[0];
        situation = { type: "weak", buyConfidence: buyConf, threshold: ctx.params.confidenceThreshold, weakest };
      }
      return;
    }
    const v = vetoes(guard);
    if (v.length) {
      situation = { type: "vetoed", side: "buy", confidence: buyConf, vetoes: v };
      return;
    }
    const res = applyBuy(state, fillPrice!, plan.sizePctOfCash, ctx.costPct, hour);
    if (!res) {
      situation = { type: "no_cash" };
      return;
    }
    state = res.state;
    fill = res.fill;
    action = "buy";
    confidence = buyConf;
    situation = {
      type: "entered",
      readings: entry,
      fill: res.fill,
      sizePct: plan.sizePctOfCash,
      cadenceHours: plan.kind === "dca" ? plan.cadenceHours : undefined,
    };
  };

  if (state.qty > 0) {
    const pos = positionEvidence(state, close, plan);
    const ruleItems = [...pos.items, ...exitConds.map((r) => r.item)];
    const ctxSell = negate(ctxBuy);
    const sellConf = combineConfidence(ruleItems, ctxSell);
    const condExit = exitConds.find((r) => r.holds);
    const reason =
      pos.reason ??
      (condExit ? `Exit rule met: ${describeCondition(condExit.rc.cond, condExit.rc.window)} (now ${formatSignalValue(condExit.rc.spec.id as SignalId, condExit.current!)}).` : null);

    evidence = [...ruleItems, ...ctxSell];
    guard = guardFor("sell");
    confidence = 100 - sellConf;
    situation = { type: "holding", pnlPct: pos.pnlPct, exits: exitSummary(plan) };

    if (!fresh.ok) {
      situation = { type: "stale", detail: fresh.detail };
    } else if (reason) {
      const v = vetoes(guard);
      if (v.length) {
        situation = { type: "vetoed", side: "sell", confidence: sellConf, vetoes: v, reason };
      } else {
        const costBasis = (state.avgEntry ?? close) * state.qty;
        const res = applySell(state, fillPrice!, ctx.costPct);
        if (res) {
          const realizedPct = ((res.fill.notional - res.fill.fee) / costBasis - 1) * 100;
          state = res.state;
          fill = res.fill;
          action = "sell";
          confidence = sellConf;
          situation = { type: "exited", reason, fill: res.fill, realizedPct };
        }
      }
    } else if (dcaDue && allEntryHold) {
      tryBuy();
    }
  } else {
    tryBuy();
  }

  const equity = equityOf(state, mark);
  const decision: Decision = {
    agentId: ctx.agentId,
    at: new Date(hour).toISOString(),
    action,
    confidence: confidence!,
    regime,
    evidence: evidence!,
    guard: guard!,
    explanation:
      inp.explain === false
        ? ""
        : explain({ action, confidence: confidence!, market, kind: plan.kind, situation: situation!, notChecked }),
  };
  return { decision, fill, state, equity, markPrice: mark };
}

/** Decide from raw candles. Uses only candles that closed at or before `hour`. */
export function decide(
  ctx: DecideContext,
  args: { candles: readonly Candle[]; hour: number; state: PositionState; fillPrice: number | null },
): StepOutput {
  const closed = args.candles.filter((c) => c.t + HOUR_MS <= args.hour);
  if (!closed.length) throw new Error("No candle closed before this hour");
  const src = new SeriesSource(closed);
  return decideStep(ctx, { src, i: closed.length - 1, hour: args.hour, state: args.state, fillPrice: args.fillPrice });
}
