/**
 * Plain-language text for plans and conditions, shown on the plan
 * confirmation screen and inside decision explanations.
 */
import { SIGNALS, isSignalId, type SignalId } from "./signals";
import type { Condition, Filter, Plan } from "./types";

export interface PlanRow {
  label: string;
  lines: string[];
  tone?: "missing";
}
export interface PlanCheck {
  pass: boolean;
  label: string;
}

/** Tuned windows keyed by condition path, e.g. { "entry.1": 200 }. */
export type WindowMap = Record<string, number>;

const fmt = (v: number) => {
  const abs = Math.abs(v);
  return (Number.isInteger(abs) ? String(abs) : abs.toFixed(abs >= 10 ? 1 : 2).replace(/0+$/, "").replace(/\.$/, ""));
};
const signed = (v: number) => (v < 0 ? `−${fmt(v)}` : `+${fmt(v)}`);

function hours(w: number | undefined, fallback: string): string {
  return w == null ? fallback : `${w}-hour`;
}

/** One condition in a sentence, e.g. "Price is more than 3% under its 20-hour average". */
export function describeCondition(c: Condition, tunedWindow?: number): string {
  const w = c.window ?? tunedWindow;
  if (!isSignalId(c.signal)) return `${c.signal} ${c.op} ${c.value}`;
  const id: SignalId = c.signal;
  const v = c.value;
  switch (id) {
    case "rsi": {
      const name = w != null && w !== 14 ? `RSI (${w}-hour)` : "RSI";
      return `${name} ${opWords(c.op)} ${fmt(v)}`;
    }
    case "price_vs_sma_pct": {
      const avg = `its ${hours(w, "short")} average`;
      if (c.op === "crosses_above" && v === 0) return `Price crosses back above ${avg}`;
      if (c.op === "crosses_below" && v === 0) return `Price crosses below ${avg}`;
      if (c.op === "<") {
        if (v < 0) return `Price is more than ${fmt(v)}% under ${avg}`;
        if (v === 0) return `Price is under ${avg}`;
        return `Price is less than ${fmt(v)}% above ${avg}`;
      }
      if (c.op === ">") {
        if (v > 0) return `Price is more than ${fmt(v)}% above ${avg}`;
        if (v === 0) return `Price is above ${avg}`;
        return `Price is less than ${fmt(v)}% under ${avg}`;
      }
      return `Price vs ${avg} ${opWords(c.op)} ${signed(v)}%`;
    }
    case "trend_pct": {
      const trend = w == null ? "The long trend" : `The ${w}-hour trend`;
      if (v === 0 && (c.op === ">" || c.op === "crosses_above")) return `${trend} is rising`;
      if (v === 0 && (c.op === "<" || c.op === "crosses_below")) return `${trend} is falling`;
      return `${trend} ${opWords(c.op)} ${signed(v)}% a day`;
    }
    case "change_pct": {
      const span = `the last ${w ?? 24} hours`;
      if (c.op === "<" && v < 0) return `Price fell more than ${fmt(v)}% in ${span}`;
      if (c.op === ">" && v > 0) return `Price rose more than ${fmt(v)}% in ${span}`;
      return `Price change over ${span} ${opWords(c.op)} ${signed(v)}%`;
    }
    case "from_high_pct": {
      const high = `its ${hours(w, "recent")} high`;
      if (c.op === "<" && v < 0) return `Price is more than ${fmt(v)}% below ${high}`;
      if (c.op === ">" && v < 0) return `Price is within ${fmt(v)}% of ${high}`;
      return `Price vs ${high} ${opWords(c.op)} ${signed(v)}%`;
    }
    case "volume_ratio":
      return `Volume ${opWords(c.op)} ${fmt(v)}× its ${w ?? 24}-hour average`;
    case "volatility_pct":
      return `Typical daily move ${opWords(c.op)} ${fmt(v)}%`;
    default: {
      const spec = SIGNALS[id];
      return `${spec.name} ${opWords(c.op)} ${fmt(v)}`;
    }
  }
}

function opWords(op: Condition["op"]): string {
  switch (op) {
    case "<":
      return "is below";
    case ">":
      return "is above";
    case "crosses_above":
      return "crosses above";
    case "crosses_below":
      return "crosses below";
  }
}

export function cadenceText(h: number): string {
  if (h === 168) return "every week";
  if (h === 24) return "every day";
  if (h % 168 === 0) return `every ${h / 168} weeks`;
  if (h % 24 === 0) return `every ${h / 24} days`;
  return h === 1 ? "every hour" : `every ${h} hours`;
}

export const FILTER_TEXT: Record<Filter, string> = {
  stressed_regime: "When the market is classed as stressed",
  negative_news: "When headline sentiment is negative",
  earnings_week: "In earnings week",
  macro_print: "Around scheduled macro releases",
};

/** Filters the engine cannot check yet, with the reason. */
export const FILTER_NOT_CHECKED: Partial<Record<Filter, string>> = {
  negative_news: "News filter: headlines are not collected yet, so this agent trades on price signals only.",
  earnings_week: "Earnings filter: the event calendar is not collected yet.",
  macro_print: "Macro filter: the event calendar is not collected yet.",
};

export function isFilterChecked(f: Filter): boolean {
  return !(f in FILTER_NOT_CHECKED);
}

/** Rows for "How the agent understood it". */
export function describePlan(
  plan: Plan,
  opts: { marketLabel?: (id: string) => string; windows?: WindowMap } = {},
): PlanRow[] {
  const label = opts.marketLabel ?? ((id: string) => `${id} / USDG`);
  const win = opts.windows ?? {};
  const rows: PlanRow[] = [];

  rows.push({ label: "Market", lines: plan.markets.length ? [plan.markets.map(label).join(", ")] : ["Not found"], tone: plan.markets.length ? undefined : "missing" });

  const buy: string[] = [];
  if (plan.kind === "dca" && plan.cadenceHours) buy.push(`Buys ${cadenceText(plan.cadenceHours)}`);
  plan.entry.forEach((c, i) => buy.push(describeCondition(c, win[`entry.${i}`])));
  rows.push({ label: "Buy when", lines: buy.length ? buy : ["Not found"], tone: buy.length ? undefined : "missing" });

  const sell: string[] = [];
  if (plan.exit.takeProfitPct != null) sell.push(`Take profit at +${fmt(plan.exit.takeProfitPct)}%`);
  if (plan.exit.stopLossPct != null) sell.push(`Stop loss at −${fmt(plan.exit.stopLossPct)}%`);
  if (plan.exit.trailingStopPct != null) sell.push(`Trailing stop ${fmt(plan.exit.trailingStopPct)}% under the high since buying`);
  (plan.exit.conditions ?? []).forEach((c, i) => sell.push(describeCondition(c, win[`exit.${i}`])));
  rows.push({ label: "Sell when", lines: sell.length ? sell : ["No exit given"], tone: sell.length ? undefined : "missing" });

  rows.push({
    label: "Stands aside",
    lines: plan.filters.length
      ? plan.filters.map((f) => (isFilterChecked(f) ? FILTER_TEXT[f] : `${FILTER_TEXT[f]} (not checked yet)`))
      : ["No filters given"],
  });

  rows.push({ label: "Size per trade", lines: [`${fmt(plan.sizePctOfCash)}% of cash`] });
  return rows;
}

export function hasLossLimit(plan: Plan): boolean {
  return plan.exit.stopLossPct != null || plan.exit.trailingStopPct != null;
}

/** The checklist under the plan (prototype: Pass / Check). */
export function planChecks(plan: Plan, maxSizePct: number): PlanCheck[] {
  return [
    { pass: plan.markets.length > 0 && (plan.entry.length > 0 || plan.kind === "dca"), label: "Strategy is complete enough to run" },
    { pass: hasLossLimit(plan), label: "Has a loss limit" },
    { pass: plan.filters.length > 0, label: "Has a reason to stand aside" },
    { pass: plan.sizePctOfCash <= maxSizePct, label: `Risk per trade is ${maxSizePct}% or less` },
  ];
}
