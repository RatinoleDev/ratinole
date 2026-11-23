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
import { OPEN_EXIT_HOURS, applyBuy, applySell, equityOf, rollDay, settleBuy, settleSell, staysOpen, type ExitKind, type Fill, type LiveFill, type PositionState } from "./paper";
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
  /** Where non-candle evidence came from, shown next to it (e.g. { funding: "Hyperliquid" }). */
  sources?: { funding?: string };
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
  /**
   * Live trading. The first pass (no `liveFill`) says what the agent wants to do. If that was a trade, the engine
   * places the order and runs this step again with the same inputs plus what really happened, so the stored
   * decision, position and explanation carry the real amounts, or say that the order did not go through.
   */
  liveFill?: LiveFill;
}

export interface StepOutput {
  decision: Decision;
  fill: Fill | null;
  state: PositionState;
  /** Equity after any fill, marked at the fill price (or the last close). */
  equity: number;
  markPrice: number;
  /** Which exit asked for a sale this hour, whether or not it went through. Null when none did. */
  exitKind: ExitKind | null;
}

const NOT_CHECKED_SHORT: Partial<Record<Filter, string>> = {
  negative_news: "news filter (headlines not collected yet)",
  earnings_week: "earnings filter (event calendar not collected yet)",
  macro_print: "macro filter (event calendar not collected yet)",
};

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14:00 UTC on 21 Nov" */
function whenText(ms: number): string {
  const d = new Date(ms);
  return `${hhmm(ms)} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * Whether the prices are current enough to act on. Reading the market for a buy also needs enough history; an
 * open position's exits do not, so a short history never stands between a position and its stop.
 */
function freshness(candle: Candle, hour: number, fillPrice: number | null, hasHistory: boolean): { ok: boolean; detail: string } {
  if (!hasHistory) return { ok: false, detail: "Not enough price history to read the market yet." };
  const expected = hour - HOUR_MS;
  if (candle.t !== expected) {
    const ago = Math.round((hour - (candle.t + HOUR_MS)) / HOUR_MS);
    return {
      ok: false,
      detail: `The newest price data ends at ${hhmm(candle.t + HOUR_MS)} UTC, ${ago} hour${ago === 1 ? "" : "s"} before this decision. Waiting for fresh data.`,
    };
  }
  if (fillPrice == null) return { ok: false, detail: `The opening price for ${hhmm(hour)} UTC is not in yet.` };
  return { ok: true, detail: `Prices are complete up to ${hhmm(hour)} UTC.` };
}

/** Evidence about an open position, and whether a price exit has been reached. */
function positionEvidence(state: PositionState, close: number, plan: Plan): { items: EvidenceItem[]; reason: string | null; kind: ExitKind | null; pnlPct: number } {
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
  let kind: ExitKind | null = null;
  if (tp != null && pnlPct >= tp) {
    reason = `Take profit reached: ${pct(pnlPct)} since buying, target +${tp}%.`;
    kind = "take profit";
  } else if (sl != null && pnlPct <= -sl) {
    reason = `Stop loss reached: ${pct(pnlPct)} since buying, stop at −${sl}%.`;
    kind = "stop loss";
  }
  if (trail != null && state.peak != null) {
    const dd = (close / state.peak - 1) * 100;
    items.push({
      name: "Trailing stop",
      value: `${pct(dd)} from the high since buying (stop ${trail}% under it)`,
      score: Math.round(Math.min(1, Math.max(0, -dd / trail)) * 100),
    });
    if (!reason && dd <= -trail) {
      reason = `Trailing stop reached: ${Math.abs(dd).toFixed(1)}% under the high since buying, stop at ${trail}%.`;
      kind = "trailing stop";
    }
  }
  return { items, reason, kind, pnlPct };
}

function exitSummary(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.exit.takeProfitPct != null) out.push(`Take profit at +${plan.exit.takeProfitPct}%`);
  if (plan.exit.stopLossPct != null) out.push(`stop at −${plan.exit.stopLossPct}%`);
  if (plan.exit.trailingStopPct != null) out.push(`trailing stop ${plan.exit.trailingStopPct}% under the high`);
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
  if (state.qty > 0) {
    // The high since buying takes in every close the agent has not looked at yet. Hour after hour that is this
    // hour's alone. After hours it could not read (stale data, or the engine was down) it is every close since,
    // so a high made in those hours still counts for the trailing stop.
    // A close that came before the buy never counts, also when this hour's data is old and the newest candle
    // there is closed before the position was opened.
    const seen = state.peakSeenTo;
    let peak = state.peak ?? close;
    if (seen == null) peak = Math.max(peak, close);
    else for (let j = i; j >= 0 && src.candles[j]!.t > seen; j--) peak = Math.max(peak, src.candles[j]!.c);
    state = { ...state, peak, peakSeenTo: Math.max(seen ?? candle.t, candle.t) };
    // An exit left open too long ago lapses: from here on the exits are checked against today's prices again.
    if (state.exitPending && hour - state.exitPending.since > OPEN_EXIT_HOURS * HOUR_MS) state = { ...state, exitPending: null };
  }

  const reading = classifyRegime(src, i, ctx.regimeParams);
  const regime = reading?.regime ?? "ranging";
  const fresh = freshness(candle, hour, fillPrice, reading != null);
  const freshForExit = freshness(candle, hour, fillPrice, true);
  const notChecked = plan.filters.map((f) => NOT_CHECKED_SHORT[f]).filter((x): x is string => !!x);
  const ctxBuy = reading ? contextEvidence(src, i, reading, ctx.sources) : [];

  const entry = resolveConditions(plan.entry, "entry", ctx.params.windows).map((rc) => readCondition(src, i, rc));
  const exitConds = resolveConditions(plan.exit.conditions ?? [], "exit", ctx.params.windows).map((rc) => readCondition(src, i, rc));
  const allEntryHold = entry.every((r) => r.holds);

  const equityBefore = equityOf(state, mark);
  const dailyPnlPct = state.dayStartEquity > 0 ? (equityBefore / state.dayStartEquity - 1) * 100 : 0;
  const guardFor = (action: "buy" | "sell"): GuardCheck[] =>
    runGuard({
      action,
      fresh: action === "buy" ? fresh : freshForExit,
      sizePctOfCash: plan.sizePctOfCash,
      maxSizePct: ctx.limits.maxSizePct,
      dailyPnlPct,
      dailyLossCapPct: ctx.limits.dailyLossCapPct,
      regime,
      standsAsideWhenStressed: plan.filters.includes("stressed_regime"),
    });

  const cadenceMs = (plan.cadenceHours ?? 0) * HOUR_MS;
  const onSchedule = plan.kind === "dca" && cadenceMs > 0;
  const dcaDue = onSchedule && (state.lastBuyAt == null || hour - state.lastBuyAt >= cadenceMs);
  const hoursToNextBuy = () => Math.max(1, Math.ceil(((state.lastBuyAt ?? hour) + cadenceMs - hour) / HOUR_MS));

  let action: Action = "hold";
  let confidence: number;
  let evidence: EvidenceItem[];
  let guard: GuardCheck[];
  let fill: Fill | null = null;
  let situation: Situation;
  let exitKind: ExitKind | null = null;

  const tryBuy = (): void => {
    const ruleItems = entry.map((r) => r.item);
    const buyConf = combineConfidence(ruleItems, ctxBuy);
    evidence = [...ruleItems, ...ctxBuy];
    guard = guardFor("buy");
    const wants = plan.kind === "dca" ? dcaDue && allEntryHold : allEntryHold && buyConf >= ctx.params.confidenceThreshold;
    confidence = 100 - buyConf;
    if (!fresh.ok) {
      // With a position open its exits were checked this hour unless the prices themselves are old: a short
      // history stops a buy only.
      situation = { type: "stale", detail: fresh.detail, inPosition: state.qty > 0 && !freshForExit.ok };
      return;
    }
    if (!wants) {
      if (plan.kind === "dca" && !dcaDue) {
        situation = { type: "not_due", hoursLeft: hoursToNextBuy() };
      } else if (!allEntryHold) {
        situation = { type: "waiting", unmet: entry.filter((r) => !r.holds), total: entry.length, buyConfidence: buyConf, scheduledDue: onSchedule };
      } else {
        const weakest = [...evidence].sort((a, b) => a.score - b.score)[0];
        situation = { type: "weak", buyConfidence: buyConf, threshold: ctx.params.confidenceThreshold, weakest };
      }
      return;
    }
    const v = vetoes(guard);
    if (v.length) {
      situation = { type: "vetoed", confidence: buyConf, vetoes: v, scheduledDue: onSchedule };
      return;
    }
    const live = inp.liveFill;
    if (live && !live.ok) {
      situation = { type: "not_bought", confidence: buyConf, why: live.reason, scheduledDue: onSchedule };
      return;
    }
    if (live && live.side !== "buy") throw new Error("A sell was booked for a decision to buy");
    const cashBefore = state.cash;
    const res = live ? settleBuy(state, live, hour) : applyBuy(state, fillPrice!, plan.sizePctOfCash, ctx.costPct, hour);
    if (!res) {
      situation = { type: "no_cash" };
      return;
    }
    // Closes up to this hour came before the buy. The high since buying starts with the next one.
    state = { ...res.state, peakSeenTo: candle.t };
    fill = res.fill;
    action = "buy";
    confidence = buyConf;
    situation = {
      type: "entered",
      readings: entry,
      fill: res.fill,
      planPct: plan.sizePctOfCash,
      actualPct: cashBefore > 0 ? (res.fill.notional / cashBefore) * 100 : plan.sizePctOfCash,
      cadenceHours: plan.kind === "dca" ? plan.cadenceHours : undefined,
      note: live?.note,
    };
  };

  if (state.qty > 0) {
    const pos = positionEvidence(state, close, plan);
    const ruleItems = [...pos.items, ...exitConds.map((r) => r.item)];
    const ctxSell = negate(ctxBuy);
    const sellConf = combineConfidence(ruleItems, ctxSell);
    const condExit = exitConds.find((r) => r.holds);
    const pending = state.exitPending ?? null;

    let reason = pos.reason;
    let kind = pos.kind;
    if (!reason && condExit) {
      reason = `Exit rule met: ${describeCondition(condExit.rc.cond, condExit.rc.window)} (now ${formatSignalValue(condExit.rc.spec.id as SignalId, condExit.current!)}).`;
      kind = "exit rule";
    }
    // An exit reached in an earlier hour whose sale did not complete stays an order to sell. If nothing asks for a
    // sale this hour on its own, that one does: a stop that was hit is not forgotten because the price came back.
    let stillTrying: string | undefined;
    if (!reason && pending) {
      const sale = `the sale from ${whenText(pending.since)} (${pending.kind === "exit rule" ? "exit rule met" : `${pending.kind} reached`})`;
      reason = `Finishing ${sale}. Now ${pct(pos.pnlPct)} since buying.`;
      stillTrying = `The agent is still trying to finish ${sale}`;
      kind = pending.kind;
    }

    evidence = [...ruleItems, ...ctxSell];
    guard = guardFor("sell");
    confidence = 100 - sellConf;
    const dueButWaiting = dcaDue && !allEntryHold;
    situation = {
      type: "holding",
      pnlPct: pos.pnlPct,
      exits: exitSummary(plan),
      conditions: exitConds,
      schedule: !onSchedule ? undefined : dueButWaiting ? { waitingFor: entry.filter((r) => !r.holds) } : !dcaDue ? { hoursLeft: hoursToNextBuy() } : undefined,
    };

    if (!freshForExit.ok) {
      situation = { type: "stale", detail: freshForExit.detail, inPosition: true };
    } else if (reason && kind) {
      exitKind = kind;
      // A stop or an exit rule that was reached stays an order to sell. A take profit does not: it sells at its
      // target or above, so it is simply checked again next hour.
      const open = staysOpen(kind);
      const live = inp.liveFill;
      if (live && !live.ok) {
        // Nothing was sold.
        if (open) state = { ...state, exitPending: pending ?? { since: hour, kind } };
        situation = { type: "not_sold", reason, why: live.reason, stillTrying, retry: open };
      } else {
        if (live && live.side !== "sell") throw new Error("A buy was booked for a decision to sell");
        // A sale of part of the position is measured against the cost of that part.
        const soldQty = live ? Math.min(live.qty, state.qty) : state.qty;
        const costBasis = (state.avgEntry ?? close) * soldQty;
        const res = live ? settleSell(state, live) : applySell(state, fillPrice!, ctx.costPct);
        if (res) {
          const realizedPct = ((res.fill.notional - res.fill.fee) / costBasis - 1) * 100;
          state = res.state;
          // Only part of it could be sold.
          if (state.qty > 0 && open) state = { ...state, exitPending: pending ?? { since: hour, kind } };
          fill = res.fill;
          action = "sell";
          confidence = sellConf;
          situation = { type: "exited", reason, fill: res.fill, realizedPct, rest: state.qty > 0 ? { qty: state.qty, retry: open } : undefined, note: live?.note };
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
  return { decision, fill, state, equity, markPrice: mark, exitKind };
}

/** Decide from raw candles. Uses only candles that closed at or before `hour`. */
export function decide(
  ctx: DecideContext,
  args: { candles: readonly Candle[]; hour: number; state: PositionState; fillPrice: number | null; liveFill?: LiveFill },
): StepOutput {
  const closed = args.candles.filter((c) => c.t + HOUR_MS <= args.hour);
  if (!closed.length) throw new Error("No candle closed before this hour");
  const src = new SeriesSource(closed);
  return decideStep(ctx, { src, i: closed.length - 1, hour: args.hour, state: args.state, fillPrice: args.fillPrice, liveFill: args.liveFill });
}
