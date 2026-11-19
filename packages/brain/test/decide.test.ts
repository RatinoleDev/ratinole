import { describe, expect, it } from "vitest";
import { decide, type DecideContext } from "../src/decide";
import { initialState, utcDayStart, type PositionState } from "../src/paper";
import { HOUR_MS, type Candle, type Plan } from "../src/types";
import { fromCloses, rng } from "./helpers";

const basePlan: Plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [{ signal: "rsi", op: "<", value: 30 }],
  exit: { takeProfitPct: 8, stopLossPct: 4 },
  filters: [],
  sizePctOfCash: 25,
};

function ctx(plan: Partial<Plan> = {}, threshold = 50): DecideContext {
  return {
    agentId: "a1",
    plan: { ...basePlan, ...plan },
    params: { confidenceThreshold: threshold, windows: {} },
    limits: { maxSizePct: 35, dailyLossCapPct: 3 },
    costPct: 0.1,
  };
}

/** 800 calm hours, then a tail. */
function series(tail: (last: number) => number[], seed = 1): Candle[] {
  const r = rng(seed);
  const closes = Array.from({ length: 800 }, (_, i) => 2000 * (1 + 0.01 * Math.sin((2 * Math.PI * i) / 48)) * (1 + (r() - 0.5) * 0.002));
  const more = tail(closes[closes.length - 1]!);
  return fromCloses([...closes, ...more]);
}
const falling = (n: number, step = 0.005) => (p: number) => Array.from({ length: n }, (_, k) => p * Math.pow(1 - step, k + 1));
const rising = (n: number, step = 0.005) => (p: number) => Array.from({ length: n }, (_, k) => p * Math.pow(1 + step, k + 1));

function at(candles: Candle[]) {
  const last = candles[candles.length - 1]!;
  return { hour: last.t + HOUR_MS, fillPrice: last.c, close: last.c };
}

function inPosition(hour: number, entry: number, qty = 1, extra: Partial<PositionState> = {}): PositionState {
  return { ...initialState(10_000 - entry * qty, hour), qty, avgEntry: entry, peak: entry, lastBuyAt: hour - 10 * HOUR_MS, dayStartEquity: 10_000, ...extra };
}

describe("decide: entries", () => {
  it("buys when every entry rule holds and the guard passes", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const out = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.action).toBe("buy");
    expect(out.fill).toMatchObject({ side: "buy", price: fillPrice, notional: 2500, fee: 2.5 });
    expect(out.state.cash).toBe(7500);
    expect(out.decision.confidence).toBeGreaterThanOrEqual(50);
    expect(out.decision.evidence[0]!.name).toBe("RSI");
    expect(out.decision.guard.every((g) => g.pass)).toBe(true);
    expect(out.decision.explanation).toMatch(/^Buy\. RSI is below 30 \(now \d/);
    expect(out.decision.explanation).toMatch(/Bought \$2,500\.00 of ETH/);
    expect(out.decision.at).toBe(new Date(hour).toISOString());
  });

  it("holds while waiting and reports confidence in buying as 100 minus the hold confidence", () => {
    const candles = series(rising(12));
    const { hour, fillPrice } = at(candles);
    const out = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.fill).toBeNull();
    expect(out.decision.explanation).toMatch(/^Hold\. Waiting until RSI is below 30 \(now \d/);
    expect(out.decision.evidence[0]!.value).toMatch(/\(rule: below 30\)$/);
    const m = out.decision.explanation.match(/Confidence in buying now: (\d+)%/);
    expect(m).not.toBeNull();
    expect(out.decision.confidence).toBe(100 - Number(m![1]));
  });

  it("holds when the rules hold but confidence is under the agent's threshold", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const out = decide(ctx({}, 100), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.explanation).toMatch(/under the 100% this agent needs/);
  });

  it("holds on stale data, with the guard's fresh-data check failing", () => {
    const candles = series(falling(12));
    const last = candles[candles.length - 1]!;
    const hour = last.t + 3 * HOUR_MS;
    const out = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice: last.c });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.guard[0]).toMatchObject({ check: "Fresh data", pass: false });
    expect(out.decision.explanation).toMatch(/^Hold\. The latest candle closed at .* 2 hours before this run/);
  });

  it("holds when the next hour's opening price is not known", () => {
    const candles = series(falling(12));
    const { hour } = at(candles);
    const out = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice: null });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.guard[0]!.pass).toBe(false);
  });

  it("is vetoed past the daily loss cap, and says why", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const state: PositionState = { ...initialState(10_000, hour), dayStart: utcDayStart(hour), dayStartEquity: 10_500 };
    const out = decide(ctx(), { candles, hour, state, fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.guard.find((g) => g.check === "Daily loss")!.pass).toBe(false);
    expect(out.decision.explanation).toMatch(/the guard said no: down 4\.8% today, past your 3% cap/);
  });

  it("stands aside in a stressed market when the plan says so", () => {
    const candles = series(falling(20));
    const { hour, fillPrice } = at(candles);
    const plan: Partial<Plan> = { entry: [{ signal: "change_pct", op: "<", value: -5 }], filters: ["stressed_regime"] };
    const out = decide(ctx(plan, 0), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.regime).toBe("stressed");
    expect(out.decision.action).toBe("hold");
    expect(out.decision.guard.find((g) => g.check === "Market stress")!.pass).toBe(false);
  });

  it("notes filters it cannot check yet", () => {
    const candles = series(rising(5));
    const { hour, fillPrice } = at(candles);
    const out = decide(ctx({ filters: ["negative_news"] }), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.explanation).toMatch(/Not checked: news filter \(headlines not collected yet\)\./);
  });
});

describe("decide: exits", () => {
  it("sells at the stop loss", () => {
    const candles = series(falling(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const out = decide(ctx(), { candles, hour, state: inPosition(hour, close * 1.06), fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.fill).toMatchObject({ side: "sell", qty: 1 });
    expect(out.state.qty).toBe(0);
    expect(out.decision.explanation).toMatch(/^Sell\. Stop loss reached: −5\.\d% since buying, stop at −4%\./);
  });

  it("sells at the take-profit target", () => {
    const candles = series(rising(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const out = decide(ctx(), { candles, hour, state: inPosition(hour, close / 1.1), fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.decision.explanation).toMatch(/Take profit reached: \+10\.0% since buying/);
  });

  it("sells at a trailing stop", () => {
    const candles = series(falling(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const out = decide(ctx({ exit: { trailingStopPct: 6 } }), { candles, hour, state: inPosition(hour, close, 1, { peak: close * 1.1 }), fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.decision.explanation).toMatch(/Trailing stop reached/);
  });

  it("sells when an exit condition holds", () => {
    const candles = series(rising(12));
    const { hour, fillPrice, close } = at(candles);
    const plan: Partial<Plan> = { exit: { stopLossPct: 50, conditions: [{ signal: "rsi", op: ">", value: 70 }] } };
    const out = decide(ctx(plan), { candles, hour, state: inPosition(hour, close), fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.decision.explanation).toMatch(/Exit rule met: RSI is above 70/);
  });

  it("holds a position that has hit nothing, and the daily loss cap never blocks an exit", () => {
    const candles = series(falling(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const held = decide(ctx(), { candles, hour, state: inPosition(hour, close), fillPrice });
    expect(held.decision.action).toBe("hold");
    expect(held.decision.explanation).toMatch(/^Hold\. In position at/);
    const losing = inPosition(hour, close * 1.06, 1, { dayStart: utcDayStart(hour), dayStartEquity: 20_000 });
    expect(decide(ctx(), { candles, hour, state: losing, fillPrice }).decision.action).toBe("sell");
  });
});

describe("decide: dca", () => {
  const dca: Partial<Plan> = { kind: "dca", entry: [], cadenceHours: 24, sizePctOfCash: 10, exit: { stopLossPct: 15 } };
  it("buys when due and waits otherwise", () => {
    const candles = series(rising(3, 0.001));
    const { hour, fillPrice } = at(candles);
    expect(decide(ctx(dca), { candles, hour, state: initialState(10_000, hour), fillPrice }).decision.action).toBe("buy");
    const recent = { ...initialState(10_000, hour), lastBuyAt: hour - 10 * HOUR_MS };
    const out = decide(ctx(dca), { candles, hour, state: recent, fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.explanation).toBe("Hold. Next scheduled purchase in 14 hours.");
  });
  it("adds to an open position on schedule", () => {
    const candles = series(rising(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const state = inPosition(hour, close, 1, { lastBuyAt: hour - 24 * HOUR_MS });
    const out = decide(ctx(dca), { candles, hour, state, fillPrice });
    expect(out.decision.action).toBe("buy");
    expect(out.state.qty).toBeGreaterThan(1);
  });
});

describe("decide: reproducibility", () => {
  it("gives the same decision for the same inputs", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const a = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice });
    const b = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(a).toEqual(b);
  });
  it("ignores candles that had not closed by the decision hour", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const future = fromCloses([1, 99999, 5], { start: hour });
    const a = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice });
    const b = decide(ctx(), { candles: [...candles, ...future], hour, state: initialState(10_000, hour), fillPrice });
    expect(b).toEqual(a);
  });
  it("every decision has evidence, guard checks and a confidence in 0..100", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const d = decide(ctx(), { candles, hour, state: initialState(10_000, hour), fillPrice }).decision;
    expect(d.evidence.length).toBeGreaterThanOrEqual(3);
    for (const e of d.evidence) expect(Math.abs(e.score)).toBeLessThanOrEqual(100);
    expect(d.guard.length).toBeGreaterThanOrEqual(2);
    expect(d.confidence).toBeGreaterThanOrEqual(0);
    expect(d.confidence).toBeLessThanOrEqual(100);
  });
});
