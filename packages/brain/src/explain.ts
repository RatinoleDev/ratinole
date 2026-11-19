/**
 * Step 5 (explain), Phase 1 version: plain-language text built by template
 * from the facts of the decision. No LLM; LLM-written explanations arrive in
 * Phase 2 and will be written from the stored Decision record only.
 */
import { cadenceText, describeCondition } from "./describe";
import { pct, type ConditionReading } from "./evidence";
import type { Fill } from "./paper";
import { formatSignalValue, type SignalId } from "./signals";
import type { Action, EvidenceItem, GuardCheck, PlanKind } from "./types";

export type Situation =
  | { type: "stale"; detail: string }
  | { type: "entered"; readings: ConditionReading[]; fill: Fill; sizePct: number; cadenceHours?: number }
  | { type: "waiting"; unmet: ConditionReading[]; buyConfidence: number }
  | { type: "weak"; buyConfidence: number; threshold: number; weakest?: EvidenceItem }
  | { type: "vetoed"; side: "buy" | "sell"; confidence: number; vetoes: GuardCheck[]; reason?: string }
  | { type: "not_due"; hoursLeft: number }
  | { type: "no_cash" }
  | { type: "holding"; pnlPct: number; exits: string[] }
  | { type: "exited"; reason: string; fill: Fill; realizedPct: number };

export interface ExplainInput {
  action: Action;
  confidence: number;
  market: string;
  kind: PlanKind;
  situation: Situation;
  /** Short notes on filters that could not be checked. */
  notChecked: string[];
}

export function usd(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function qtyText(q: number): string {
  return q >= 1 ? q.toFixed(4) : q.toPrecision(4);
}

function now(r: ConditionReading): string {
  if (r.current == null) return "not enough history";
  return `now ${formatSignalValue(r.rc.spec.id as SignalId, r.current)}`;
}

function conditionText(r: ConditionReading, k = 0): string {
  const text = `${describeCondition(r.rc.cond, r.rc.window)} (${now(r)})`;
  return k === 0 ? text : lowerFirst(text);
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Lower-case the first letter unless the first word is an acronym (RSI). */
function lowerFirst(s: string): string {
  if (/^[A-Z]{2}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function explain(x: ExplainInput): string {
  const s = x.situation;
  let text: string;
  switch (s.type) {
    case "stale":
      text = `Hold. ${s.detail}`;
      break;
    case "entered": {
      const why = s.cadenceHours
        ? `Scheduled purchase (${cadenceText(s.cadenceHours)})${s.readings.length ? `, and ${lowerFirst(joinAnd(s.readings.map(conditionText)))}` : ""}.`
        : `${joinAnd(s.readings.map(conditionText))}.`;
      text = `Buy. ${why} Confidence ${x.confidence}%. Bought ${usd(s.fill.notional)} of ${x.market} at ${usd(s.fill.price)}, ${s.sizePct}% of cash.`;
      break;
    }
    case "waiting":
      text = `Hold. Waiting until ${lowerFirst(joinAnd(s.unmet.map(conditionText)))}. Confidence in buying now: ${s.buyConfidence}%.`;
      break;
    case "weak":
      text = `Hold. The entry rules are met, but confidence in buying is ${s.buyConfidence}%, under the ${s.threshold}% this agent needs${
        s.weakest ? `. Weakest evidence: ${lowerFirst(s.weakest.name)}, ${s.weakest.value}` : ""
      }.`;
      break;
    case "vetoed": {
      const what = s.side === "buy" ? `The entry rules are met (confidence ${s.confidence}%)` : (s.reason ?? "The exit rule is met");
      text = `Hold. ${what.replace(/\.$/, "")}, but the guard said no: ${joinAnd(s.vetoes.map((v) => lowerFirst(v.detail.replace(/\.$/, ""))))}.`;
      break;
    }
    case "not_due":
      text = `Hold. Next scheduled purchase in ${s.hoursLeft} hour${s.hoursLeft === 1 ? "" : "s"}.`;
      break;
    case "no_cash":
      text = "Hold. No cash left to buy with.";
      break;
    case "holding":
      text = `Hold. In position at ${pct(s.pnlPct)} since buying.${s.exits.length ? ` ${s.exits.join(", ")}.` : ""}`;
      break;
    case "exited":
      text = `Sell. ${s.reason} Sold ${qtyText(s.fill.qty)} ${x.market} at ${usd(s.fill.price)}, ${pct(s.realizedPct)} on the trade after costs.`;
      break;
  }
  if (x.notChecked.length) text += ` Not checked: ${joinAnd(x.notChecked)}.`;
  return text;
}
