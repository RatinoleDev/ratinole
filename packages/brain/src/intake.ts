/**
 * Sentence to plan (HANDOFF 5.1). The LLM only drafts JSON; this module
 * validates it and applies the rules. It never guesses: anything invalid or
 * missing that has no documented default sends the user back to rephrase.
 */
import { FILTER_NOT_CHECKED, hasLossLimit } from "./describe";
import { DraftSchema, PlanSchema, type Draft } from "./schema";
import { SIGNALS, isSignalId } from "./signals";
import type { Condition, Filter, Plan } from "./types";

export interface IntakeOptions {
  supportedMarkets: readonly string[];
  /** The wallet's cap on size per trade, in percent of cash. */
  maxSizePct: number;
  defaultSizePct: number;
  defaultStopLossPct: number;
}

export type IntakeErrorCode = "rephrase" | "unsupported_market" | "unsupported_signal" | "unsupported_kind" | "size_over_cap";

export type IntakeOutcome =
  | { ok: true; plan: Plan; notes: string[]; notChecked: string[] }
  | { ok: false; code: IntakeErrorCode; message: string };

/** Calls the LLM and returns its raw JSON. Implemented outside the brain. */
export type PlanDrafter = (sentence: string) => Promise<unknown>;

const GENERIC =
  "I couldn't turn that into a plan. Name a market, say when to buy and when to sell, and how much of your cash to use per trade.";

const fail = (code: IntakeErrorCode, message: string): IntakeOutcome => ({ ok: false, code, message });

/** The longest RSI lookback, in hours. A longer one needs more history than the agent reads each hour, so its RSI would differ from the backtest's. */
export const MAX_RSI_WINDOW = 100;

/**
 * A number that is outside what a plan allows, named in plain words. The schema refuses the same plans; this
 * says which number and what the limits are, instead of "I couldn't turn that into a plan".
 */
function rangeProblem(input: unknown): string | null {
  const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const plan = obj(input);
  const exit = obj(plan.exit);

  const size = plan.sizePctOfCash;
  if (num(size) && (size < 1 || size > 100)) return `Size per trade must be between 1% and 100% of cash. You gave ${size}%.`;
  const tp = exit.takeProfitPct;
  if (num(tp) && (tp <= 0 || tp > 1000)) return `Take profit must be more than 0% and no more than 1,000%. You gave ${tp}%.`;
  const sl = exit.stopLossPct;
  if (num(sl) && (sl <= 0 || sl >= 100)) return `A stop loss must be more than 0% and less than 100%. You gave ${sl}%.`;
  const trail = exit.trailingStopPct;
  if (num(trail) && (trail <= 0 || trail >= 100)) return `A trailing stop must be more than 0% and less than 100%. You gave ${trail}%.`;

  const conditions = [...(Array.isArray(plan.entry) ? plan.entry : []), ...(Array.isArray(exit.conditions) ? exit.conditions : [])].map(obj);
  for (const c of conditions) {
    const w = c.window;
    if (!num(w) || !Number.isInteger(w)) continue;
    if (w < 1 || w > 1000) return `A lookback must be between 1 and 1,000 hours. You gave ${w}.`;
    if (c.signal === "rsi" && (w < 2 || w > MAX_RSI_WINDOW)) return `An RSI lookback must be between 2 and ${MAX_RSI_WINDOW} hours. You gave ${w}.`;
  }
  return null;
}

export async function intake(sentence: string, draft: PlanDrafter, opts: IntakeOptions): Promise<IntakeOutcome> {
  const s = sentence.trim();
  if (s.length < 8) return fail("rephrase", GENERIC);
  if (s.length > 1000) return fail("rephrase", "Keep the strategy under 1,000 characters.");
  const raw = await draft(s);
  return draftToPlan(raw, opts);
}

/** Validate an LLM draft and turn it into a Plan. Pure. */
export function draftToPlan(raw: unknown, opts: IntakeOptions): IntakeOutcome {
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) return fail("rephrase", GENERIC);
  const d: Draft = parsed.data;
  if (!d.understood) {
    const problem = d.problem?.trim();
    return fail("rephrase", problem ? `${problem.replace(/\.?$/, ".")} Try rephrasing.` : GENERIC);
  }

  const notes: string[] = [];
  const toCondition = (c: Draft["entry"][number]): Condition => ({
    signal: c.signal,
    op: c.op,
    value: c.value,
    ...(c.window != null ? { window: c.window } : {}),
  });

  let sizePctOfCash = d.sizePctOfCash;
  if (sizePctOfCash == null) {
    sizePctOfCash = opts.defaultSizePct;
    notes.push(`No size was given, so each trade uses ${opts.defaultSizePct}% of cash.`);
  }

  const exit: Plan["exit"] = {};
  if (d.exit.takeProfitPct != null) exit.takeProfitPct = d.exit.takeProfitPct;
  if (d.exit.stopLossPct != null) exit.stopLossPct = d.exit.stopLossPct;
  if (d.exit.trailingStopPct != null) exit.trailingStopPct = d.exit.trailingStopPct;
  if (d.exit.conditions.length) exit.conditions = d.exit.conditions.map(toCondition);

  const plan: Plan = {
    markets: [...new Set(d.markets.map((m) => m.trim().toUpperCase()).filter(Boolean))],
    kind: d.kind,
    entry: d.entry.map(toCondition),
    exit,
    filters: [...new Set(d.filters)] as Filter[],
    sizePctOfCash,
  };
  if (d.cadenceHours != null) plan.cadenceHours = d.cadenceHours;
  if (d.weights.length) plan.weights = Object.fromEntries(d.weights.map((w) => [w.market.toUpperCase(), w.pct]));

  if (!hasLossLimit(plan)) {
    plan.exit.stopLossPct = opts.defaultStopLossPct;
    notes.push(`No loss limit was given, so a ${opts.defaultStopLossPct}% stop loss was added.`);
  }

  const checked = checkPlan(plan, opts);
  if (!checked.ok) return checked;
  return { ok: true, plan: checked.plan, notes: [...notes, ...checked.notes], notChecked: checked.notChecked };
}

/**
 * Rules every runnable plan must meet. Used after drafting and again when the
 * browser sends a confirmed plan back, so a tampered plan gets no further than
 * a sentence would.
 */
export function checkPlan(input: unknown, opts: IntakeOptions): IntakeOutcome {
  const outOfRange = rangeProblem(input);
  if (outOfRange) return fail("rephrase", outOfRange);
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) return fail("rephrase", GENERIC);
  const plan = parsed.data as Plan;
  const notes: string[] = [];

  if (!plan.markets.length) return fail("rephrase", "Name a market, such as ETH or BTC.");
  const unsupported = plan.markets.filter((m) => !opts.supportedMarkets.includes(m));
  if (unsupported.length) {
    return fail(
      "unsupported_market",
      `${unsupported.join(" and ")} ${unsupported.length > 1 ? "aren't" : "isn't"} available yet. Agents trade ${opts.supportedMarkets.join(" and ")} for now.`,
    );
  }

  if (plan.kind === "rebalance") {
    return fail("unsupported_kind", "Portfolio rebalancing isn't available yet. Describe a single-market strategy, such as when to buy and sell ETH.");
  }
  if (plan.kind === "grid") {
    return fail("unsupported_kind", "Grid strategies aren't available yet. Describe when to buy and when to sell instead.");
  }
  if (plan.markets.length > 1) {
    return fail("rephrase", "One market per agent for now. Pick one market and launch a second agent for the other.");
  }

  const conditions = [...plan.entry, ...(plan.exit.conditions ?? [])];
  const missing = new Set<string>();
  for (const c of conditions) {
    if (!isSignalId(c.signal)) return fail("rephrase", GENERIC);
    const spec = SIGNALS[c.signal];
    if (!spec.available) missing.add(spec.needs ?? spec.name);
  }
  if (missing.size) {
    const list = [...missing].join(" and ");
    return fail(
      "unsupported_signal",
      `This strategy depends on ${list}. That data isn't collected yet, so the agent can't follow it. Remove that part and try again.`,
    );
  }
  for (const c of conditions) {
    const spec = SIGNALS[c.signal as keyof typeof SIGNALS];
    const [lo, hi] = spec.range;
    if (c.value < lo || c.value > hi) {
      return fail("rephrase", `${spec.name} can't be ${c.value}; it ranges from ${lo} to ${hi}.`);
    }
  }

  if (plan.kind === "entry_exit" && plan.entry.length === 0) {
    return fail("rephrase", 'Say when to buy, for example "when RSI drops below 30".');
  }
  if (plan.kind === "dca" && plan.cadenceHours == null) {
    return fail("rephrase", 'Say how often to buy, for example "every week".');
  }
  if (plan.kind === "entry_exit" && plan.cadenceHours != null) {
    delete plan.cadenceHours;
  }

  if (plan.sizePctOfCash > opts.maxSizePct) {
    return fail(
      "size_over_cap",
      `Each trade would use ${plan.sizePctOfCash}% of cash, which is over your ${opts.maxSizePct}% cap. Lower the size and try again.`,
    );
  }
  if (!hasLossLimit(plan)) {
    return fail("rephrase", "Add a loss limit, such as a stop loss.");
  }

  const notChecked = plan.filters.map((f) => FILTER_NOT_CHECKED[f]).filter((x): x is string => !!x);
  return { ok: true, plan, notes, notChecked };
}
