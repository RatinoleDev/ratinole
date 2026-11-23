/**
 * Step 5 (explain), Phase 1 version: plain-language text built by template
 * from the facts of the decision. No LLM; LLM-written explanations arrive in
 * Phase 2 and will be written from the stored Decision record only.
 *
 * Every sentence states something this hour's decision really found. A number is printed only where it was
 * measured: the size of an order comes from its fill, never from the plan alone.
 */
import { cadenceText, describeCondition } from "./describe";
import { missingText, pct, type ConditionReading } from "./evidence";
import type { Fill } from "./paper";
import { formatSignalValue, type SignalId } from "./signals";
import type { Action, EvidenceItem, GuardCheck, PlanKind } from "./types";

export type Situation =
  | { type: "stale"; detail: string; inPosition?: boolean }
  | {
      type: "entered";
      readings: ConditionReading[];
      fill: Fill;
      /** What the plan asks for, and what this order really was, both in percent of the cash before it. */
      planPct: number;
      actualPct: number;
      cadenceHours?: number;
      note?: string;
    }
  | { type: "waiting"; unmet: ConditionReading[]; total: number; buyConfidence: number; scheduledDue?: boolean }
  | { type: "weak"; buyConfidence: number; threshold: number; weakest?: EvidenceItem }
  | { type: "vetoed"; confidence: number; vetoes: GuardCheck[]; scheduledDue?: boolean }
  | { type: "not_due"; hoursLeft: number }
  | { type: "no_cash" }
  | {
      type: "holding";
      pnlPct: number;
      /** Price exits, e.g. "Take profit at +8%". */
      exits: string[];
      /** Exit conditions with their current readings. */
      conditions: ConditionReading[];
      /** A plan that buys on a schedule: when the next purchase is, or what a due one is waiting for. */
      schedule?: { hoursLeft: number } | { waitingFor: ConditionReading[] };
    }
  | {
      type: "exited";
      reason: string;
      fill: Fill;
      realizedPct: number;
      /** After a sale of part of the position: what is still held, and whether the agent keeps trying to sell it. */
      rest?: { qty: number; retry: boolean };
      note?: string;
    }
  /** Live trading only: the agent wanted to buy, and nothing was bought. */
  | { type: "not_bought"; confidence: number; why: string; scheduledDue?: boolean }
  /**
   * Live trading only: an exit was reached and the position was not sold. `retry`: the exit stays an order to
   * sell, and the agent tries again every hour (a take profit instead waits for its target to be reached again).
   * `stillTrying` is set when this hour was itself such a retry.
   */
  | { type: "not_sold"; reason: string; why: string; stillTrying?: string; retry: boolean };

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

/** A share of cash, as the plan writes it: "25%", or "4.9%" when it is not a whole number. */
function shareText(p: number): string {
  const r = Math.round(p * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}%`;
}

function now(r: ConditionReading): string {
  const id = r.rc.spec.id as SignalId;
  if (r.current == null) return missingText(id);
  const v = `now ${formatSignalValue(id, r.current)}`;
  // A cross happens in one hour. A value that is already on the far side has not crossed, and reads as if it had.
  const { op, value } = r.rc.cond;
  const past = (op === "crosses_above" && r.current > value) || (op === "crosses_below" && r.current < value);
  return past && !r.holds ? `${v}, already past it, so a new cross is needed` : v;
}

function conditionText(r: ConditionReading, k = 0): string {
  const text = `${describeCondition(r.rc.cond, r.rc.window)} (${now(r)})`;
  return k === 0 ? text : lowerFirst(text);
}

function joinWith(word: "and" | "or", parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${word} ${parts[parts.length - 1]}`;
}

/** Lower-case the first letter unless the first word is an acronym (RSI). */
function lowerFirst(s: string): string {
  if (/^[A-Z]{2}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const noDot = (s: string) => s.replace(/\.$/, "");
const list = (rs: ConditionReading[]) => rs.map((r) => lowerFirst(conditionText(r))).join("; ");
const hoursText = (h: number) => `${h} hour${h === 1 ? "" : "s"}`;

export function explain(x: ExplainInput): string {
  const s = x.situation;
  // A plan that buys on a schedule does not weigh its confidence, so none is quoted for it.
  const scheduled = x.kind === "dca";
  let text: string;
  switch (s.type) {
    case "stale":
      text = `Hold. ${s.detail}${s.inPosition ? " The position stays open, and its exits are not checked until prices are current." : ""}`;
      break;
    case "entered": {
      const why = s.cadenceHours
        ? `Scheduled purchase (${cadenceText(s.cadenceHours)})${s.readings.length ? `, and ${lowerFirst(joinWith("and", s.readings.map(conditionText)))}` : ""}.`
        : `${joinWith("and", s.readings.map(conditionText))}.`;
      // The size printed is the order's own. The plan's figure is used when the two agree.
      const share = Math.abs(s.actualPct - s.planPct) < 0.05 ? shareText(s.planPct) : shareText(s.actualPct);
      text = `Buy. ${why}${scheduled ? "" : ` Confidence ${x.confidence}%.`} Bought ${usd(s.fill.notional)} of ${x.market} at ${usd(s.fill.price)}, ${share} of cash.${s.note ? ` ${s.note}` : ""}`;
      break;
    }
    case "waiting": {
      const met = s.total - s.unmet.length;
      if (s.scheduledDue) {
        const which = s.total === 1 ? "its condition is" : `${s.unmet.length} of its ${s.total} conditions ${s.unmet.length === 1 ? "is" : "are"}`;
        text = `Hold. A scheduled purchase is due, but ${which} not met. Waiting for: ${list(s.unmet)}.`;
      } else if (s.total === 1) {
        text = `Hold. Waiting until ${lowerFirst(conditionText(s.unmet[0]!))}.`;
      } else {
        const count = met === 0 ? `None of the ${s.total} entry conditions is met` : `${met} of ${s.total} entry conditions ${met === 1 ? "is" : "are"} met`;
        text = `Hold. ${count}. Waiting for: ${list(s.unmet)}.`;
      }
      if (!scheduled) text += ` Confidence in buying now: ${s.buyConfidence}%.`;
      break;
    }
    case "weak":
      text = `Hold. The entry rules are met, but confidence in buying is ${s.buyConfidence}%, under the ${s.threshold}% this agent needs${
        s.weakest ? `. Weakest evidence: ${lowerFirst(s.weakest.name)}, ${s.weakest.value}` : ""
      }.`;
      break;
    case "vetoed": {
      const what = s.scheduledDue ? "A scheduled purchase is due" : `The entry rules are met${scheduled ? "" : ` (confidence ${s.confidence}%)`}`;
      // One reason reads as one sentence. Several are each named, so no two run together.
      text =
        s.vetoes.length === 1
          ? `Hold. ${what}, but the guard said no: ${lowerFirst(noDot(s.vetoes[0]!.detail))}.`
          : `Hold. ${what}, but the guard said no, for ${s.vetoes.length} reasons. ${s.vetoes.map((v) => `${v.check}: ${lowerFirst(noDot(v.detail))}.`).join(" ")}`;
      break;
    }
    case "not_due":
      text = `Hold. Next scheduled purchase in ${hoursText(s.hoursLeft)}.`;
      break;
    case "no_cash":
      text = "Hold. No cash left to buy with.";
      break;
    case "holding": {
      text = `Hold. In position at ${pct(s.pnlPct)} since buying.`;
      if (s.exits.length) text += ` ${s.exits.join(", ")}.`;
      if (s.conditions.length) text += ` ${s.exits.length ? "Also sells" : "Sells"} when ${joinWith("or", s.conditions.map((r) => lowerFirst(conditionText(r))))}.`;
      if (!s.exits.length && !s.conditions.length) text += " The plan has no exit rule.";
      if (s.schedule && "hoursLeft" in s.schedule) text += ` Next scheduled purchase in ${hoursText(s.schedule.hoursLeft)}.`;
      else if (s.schedule) text += ` A scheduled purchase is due. Waiting for: ${list(s.schedule.waitingFor)}.`;
      break;
    }
    case "exited":
      text = `Sell. ${s.reason} Sold ${qtyText(s.fill.qty)} ${x.market} at ${usd(s.fill.price)}, ${pct(s.realizedPct)} on the trade after costs.`;
      if (s.rest) text += ` ${qtyText(s.rest.qty)} ${x.market} is still held.`;
      if (s.note) text += ` ${s.note}`;
      if (s.rest) text += s.rest.retry ? " The agent tries to sell the rest every hour." : " The rest is sold in the next hour the target is still reached.";
      break;
    case "not_bought": {
      const what = s.scheduledDue ? "A scheduled purchase is due" : `The entry rules are met${scheduled ? "" : ` (confidence ${s.confidence}%)`}`;
      text = `Hold. ${what}, but nothing was bought: ${lowerFirst(noDot(s.why))}.`;
      break;
    }
    case "not_sold":
      text = `Hold. ${noDot(s.stillTrying ?? s.reason)}, but the position was not sold: ${lowerFirst(noDot(s.why))}. It is still open, and the agent ${
        s.retry ? "tries again next hour" : "sells in the next hour its target is still reached"
      }.`;
      break;
  }
  if (x.notChecked.length) text += ` Not checked: ${joinWith("and", x.notChecked)}.`;
  return text;
}
