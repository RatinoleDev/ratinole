/**
 * What the pre-mainnet audit pinned down about the hourly decision and its text:
 *  - an exit that was reached and could not be sold stays an order to sell until the position is closed;
 *  - the high a trailing stop follows is never missed, whatever hours the agent could not read;
 *  - a short price history stops a buy, never a sale;
 *  - every sentence states what was measured this hour, and nothing reads as if it were something else.
 */
import { describe, expect, it } from "vitest";
import { decide, type DecideContext } from "../src/decide";
import { pct } from "../src/evidence";
import { initialState, utcDayStart, type LiveFill, type PositionState } from "../src/paper";
import { formatSignalValue } from "../src/signals";
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
  return { agentId: "a1", plan: { ...basePlan, ...plan }, params: { confidenceThreshold: threshold, windows: {} }, limits: { maxSizePct: 35, dailyLossCapPct: 3 }, costPct: 0.1 };
}

/** 800 calm hours, then a tail. */
function series(tail: (last: number) => number[], seed = 1): Candle[] {
  const r = rng(seed);
  const closes = Array.from({ length: 800 }, (_, i) => 2000 * (1 + 0.01 * Math.sin((2 * Math.PI * i) / 48)) * (1 + (r() - 0.5) * 0.002));
  return fromCloses([...closes, ...tail(closes[closes.length - 1]!)]);
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

const REFUSED: LiveFill = { ok: false, reason: "the vault is paused" };

describe("an exit whose sale did not complete", () => {
  // Three falling hours take the position past its 4% stop. In the hour after, the price is back at −1%.
  const all = series((p) => {
    const f = falling(3, 0.001)(p);
    return [...f, f[2]! * 1.06 * 0.99];
  });
  const first = all.slice(0, -1);
  const h1 = at(first);
  const h2 = at(all);
  const entry = h1.close * 1.06;

  it("stays an order to sell after the price comes back, and is sold in the first hour it can be", () => {
    const refused = decide(ctx(), { candles: first, hour: h1.hour, state: inPosition(h1.hour, entry), fillPrice: h1.fillPrice, liveFill: REFUSED });
    expect(refused.decision.action).toBe("hold");
    expect(refused.state.qty).toBe(1);
    expect(refused.state.exitPending).toEqual({ since: h1.hour, kind: "stop loss" });
    expect(refused.decision.explanation).toBe(
      "Hold. Stop loss reached: −5.7% since buying, stop at −4%, but the position was not sold: the vault is paused. It is still open, and the agent tries again next hour.",
    );

    // Without that open exit, the next hour is a plain hold: −1% is inside the stop.
    const plain = decide(ctx(), { candles: all, hour: h2.hour, state: { ...refused.state, exitPending: null }, fillPrice: h2.fillPrice });
    expect(plain.decision.action).toBe("hold");
    expect(plain.decision.explanation).toBe("Hold. In position at −1.0% since buying. Take profit at +8%, stop at −4%.");

    // With it, the agent sells, and says which sale it is finishing.
    const sold = decide(ctx(), { candles: all, hour: h2.hour, state: refused.state, fillPrice: h2.fillPrice });
    expect(sold.decision.action).toBe("sell");
    expect(sold.fill).toMatchObject({ side: "sell", qty: 1 });
    expect(sold.state).toMatchObject({ qty: 0, avgEntry: null, peak: null, exitPending: null, peakSeenTo: null });
    expect(sold.decision.explanation).toMatch(/^Sell\. Finishing the sale from \d\d:00 UTC on \d{1,2} [A-Z][a-z]{2} \(stop loss reached\)\. Now −1\.0% since buying\. Sold 1\.0000 ETH at \$[\d,.]+, −1\.1% on the trade after costs\.$/);
  });

  it("refused again, it keeps the hour it was first reached and says the agent is still trying", () => {
    const refused = decide(ctx(), { candles: first, hour: h1.hour, state: inPosition(h1.hour, entry), fillPrice: h1.fillPrice, liveFill: REFUSED });
    const again = decide(ctx(), { candles: all, hour: h2.hour, state: refused.state, fillPrice: h2.fillPrice, liveFill: REFUSED });
    expect(again.decision.action).toBe("hold");
    expect(again.state.exitPending).toEqual({ since: h1.hour, kind: "stop loss" });
    expect(again.decision.explanation).toMatch(
      /^Hold\. The agent is still trying to finish the sale from \d\d:00 UTC on \d{1,2} [A-Z][a-z]{2} \(stop loss reached\), but the position was not sold: the vault is paused\. It is still open, and the agent tries again next hour\.$/,
    );
  });

  it("a sale of part of the position says what is still held, and the rest is sold the next hour", () => {
    const state = inPosition(h1.hour, entry);
    const part: LiveFill = { ok: true, side: "sell", qty: 0.4, notional: h1.close * 0.4, fee: h1.close * 0.4 * 0.0005, note: "The vault's daily trading limit allowed only part of the position to be sold." };
    const out = decide(ctx(), { candles: first, hour: h1.hour, state, fillPrice: h1.fillPrice, liveFill: part });
    expect(out.decision.action).toBe("sell");
    expect(out.state.qty).toBeCloseTo(0.6, 12);
    expect(out.state.avgEntry).toBe(entry);
    expect(out.state.exitPending).toEqual({ since: h1.hour, kind: "stop loss" });
    expect(out.decision.explanation).toMatch(
      /^Sell\. Stop loss reached: −5\.7% since buying, stop at −4%\. Sold 0\.4000 ETH at \$[\d,.]+, −5\.7% on the trade after costs\. 0\.6000 ETH is still held\. The vault's daily trading limit allowed only part of the position to be sold\.$/,
    );

    // The price is back inside the stop. The rest is sold all the same.
    const want = decide(ctx(), { candles: all, hour: h2.hour, state: out.state, fillPrice: h2.fillPrice });
    expect(want.fill).toMatchObject({ side: "sell" });
    expect(want.fill!.qty).toBeCloseTo(0.6, 12);
    const rest: LiveFill = { ok: true, side: "sell", qty: out.state.qty, notional: h2.close * out.state.qty, fee: 0 };
    const done = decide(ctx(), { candles: all, hour: h2.hour, state: out.state, fillPrice: h2.fillPrice, liveFill: rest });
    expect(done.decision.action).toBe("sell");
    expect(done.state).toMatchObject({ qty: 0, exitPending: null });
    expect(done.decision.explanation).not.toMatch(/still held/);
  });

  it("an exit rule that holds for one hour only (a cross) is not lost when its sale is refused", () => {
    const candles = series(rising(14));
    const plan: Partial<Plan> = { exit: { conditions: [{ signal: "rsi", op: "crosses_above", value: 70 }] } };
    // The hour RSI crosses above 70.
    let k = -1;
    for (let n = 800; n < candles.length - 1 && k < 0; n++) {
      const part = candles.slice(0, n + 1);
      const t = at(part);
      if (decide(ctx(plan), { candles: part, hour: t.hour, state: inPosition(t.hour, t.close), fillPrice: t.fillPrice }).decision.action === "sell") k = n;
    }
    expect(k).toBeGreaterThan(0);
    const crossed = candles.slice(0, k + 1);
    const a = at(crossed);
    const refused = decide(ctx(plan), { candles: crossed, hour: a.hour, state: inPosition(a.hour, a.close), fillPrice: a.fillPrice, liveFill: REFUSED });
    expect(refused.state.exitPending).toEqual({ since: a.hour, kind: "exit rule" });
    expect(refused.decision.explanation).toMatch(/^Hold\. Exit rule met: RSI crosses above 70 \(now [\d.]+\), but the position was not sold: the vault is paused\./);

    const after = candles.slice(0, k + 2);
    const b = at(after);
    // RSI is still above 70, but it does not cross again: on its own, this hour is a hold, and the text says why.
    const plain = decide(ctx(plan), { candles: after, hour: b.hour, state: { ...refused.state, exitPending: null }, fillPrice: b.fillPrice });
    expect(plain.decision.action).toBe("hold");
    expect(plain.decision.explanation).toMatch(/Sells when RSI crosses above 70 \(now [\d.]+, already past it, so a new cross is needed\)\.$/);
    const sold = decide(ctx(plan), { candles: after, hour: b.hour, state: refused.state, fillPrice: b.fillPrice });
    expect(sold.decision.action).toBe("sell");
    expect(sold.decision.explanation).toMatch(/^Sell\. Finishing the sale from .* \(exit rule met\)\./);
  });

  it("is never set on paper: a paper sale always completes", () => {
    const out = decide(ctx(), { candles: first, hour: h1.hour, state: inPosition(h1.hour, entry), fillPrice: h1.fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.state.exitPending).toBeNull();
  });
});

describe("the high a trailing stop follows", () => {
  // Bought at p. The next two hours rise 3% and 6%; then the price is 3% under that high.
  const all = series((p) => [p * 1.03, p * 1.06, p * 1.06 * 0.97]);
  const p = all[799]!.c;
  const { hour, fillPrice } = at(all);
  const plan: Partial<Plan> = { exit: { trailingStopPct: 2.5 } };
  const bought = (extra: Partial<PositionState>): PositionState => inPosition(hour, p, 1, { peak: p, lastBuyAt: all[799]!.t + HOUR_MS, ...extra });

  it("takes in every close since the last one the agent looked at, so hours it could not read still count", () => {
    // The agent last looked when it bought. It did not run in the two hours the price rose.
    const out = decide(ctx(plan), { candles: all, hour, state: bought({ peakSeenTo: all[799]!.t }), fillPrice });
    expect(out.decision.evidence.find((e) => e.name === "Trailing stop")!.value).toBe("−3.0% from the high since buying (stop 2.5% under it)");
    expect(out.decision.action).toBe("sell");
    expect(out.decision.explanation).toMatch(/^Sell\. Trailing stop reached: 3\.0% under the high since buying, stop at 2\.5%\./);
  });

  it("hour by hour, looks at one close and remembers how far it has looked", () => {
    const upTo = (n: number) => all.slice(0, n + 1);
    let state = bought({ peakSeenTo: all[799]!.t });
    for (const n of [800, 801]) {
      const t = at(upTo(n));
      const out = decide(ctx(plan), { candles: upTo(n), hour: t.hour, state, fillPrice: t.fillPrice });
      expect(out.decision.action).toBe("hold");
      state = out.state;
      expect(state.peakSeenTo).toBe(all[n]!.t);
    }
    expect(state.peak).toBeCloseTo(p * 1.06, 8);
    expect(decide(ctx(plan), { candles: all, hour, state, fillPrice }).decision.action).toBe("sell");
  });

  it("a position from before this was kept starts from the close it sees now", () => {
    const out = decide(ctx(plan), { candles: all, hour, state: bought({}), fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.state.peakSeenTo).toBe(all[all.length - 1]!.t);
  });

  it("a buy starts the high at its own price: closes before it do not count", () => {
    const candles = series(falling(12));
    const t = at(candles);
    const out = decide(ctx(), { candles, hour: t.hour, state: initialState(10_000, t.hour), fillPrice: t.fillPrice });
    expect(out.decision.action).toBe("buy");
    expect(out.state.peak).toBe(t.fillPrice);
    expect(out.state.peakSeenTo).toBe(candles[candles.length - 1]!.t);
  });
});

describe("a short price history", () => {
  const short = series(falling(3, 0.001)).slice(-120);
  const { hour, fillPrice, close } = at(short);

  it("stops a buy", () => {
    const out = decide(ctx(), { candles: short, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.explanation).toBe("Hold. Not enough price history to read the market yet.");
  });

  it("never stands between a position and its stop", () => {
    const out = decide(ctx(), { candles: short, hour, state: inPosition(hour, close * 1.06), fillPrice });
    expect(out.decision.action).toBe("sell");
    expect(out.decision.guard).toEqual([{ check: "Fresh data", pass: true, detail: expect.stringMatching(/^Prices are complete up to \d\d:00 UTC\.$/) }]);
  });
});

describe("what the explanation says", () => {
  it("names each reason when the guard has several, so no two run together", () => {
    const candles = series(falling(20));
    const { hour, fillPrice } = at(candles);
    const plan: Partial<Plan> = { entry: [{ signal: "change_pct", op: "<", value: -5 }], filters: ["stressed_regime"] };
    const state: PositionState = { ...initialState(10_000, hour), dayStart: utcDayStart(hour), dayStartEquity: 10_500 };
    const out = decide(ctx(plan, 0), { candles, hour, state, fillPrice });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.explanation).toMatch(
      /^Hold\. The entry rules are met \(confidence \d+%\), but the guard said no, for 2 reasons\. Daily loss: down 4\.8% today, past your 3% cap\. No new buys until the next UTC day\. Market stress: the market is classed as stressed, and your plan stands aside\.$/,
    );
  });

  it("says how many entry conditions are met and lists the ones it waits for", () => {
    const candles = series(rising(12));
    const { hour, fillPrice } = at(candles);
    const run = (entry: Plan["entry"]) => decide(ctx({ entry }), { candles, hour, state: initialState(10_000, hour), fillPrice }).decision.explanation;
    expect(run([{ signal: "rsi", op: "<", value: 30 }])).toMatch(/^Hold\. Waiting until RSI is below 30 \(now [\d.]+\)\. Confidence in buying now: \d+%\.$/);
    expect(
      run([
        { signal: "rsi", op: "<", value: 30 },
        { signal: "rsi", op: ">", value: 10 },
      ]),
    ).toMatch(/^Hold\. 1 of 2 entry conditions is met\. Waiting for: RSI is below 30 \(now [\d.]+\)\. Confidence in buying now: \d+%\.$/);
    expect(
      run([
        { signal: "rsi", op: "<", value: 30 },
        { signal: "change_pct", op: "<", value: -5 },
      ]),
    ).toMatch(/^Hold\. None of the 2 entry conditions is met\. Waiting for: RSI is below 30 \(now [\d.]+\); price fell more than 5% in the last 24 hours \(now \+[\d.]+%\)\. Confidence in buying now: \d+%\.$/);
  });

  it("says when a value is already past a level it has to cross", () => {
    const candles = series(rising(12));
    const { hour, fillPrice } = at(candles);
    const out = decide(ctx({ entry: [{ signal: "rsi", op: "crosses_above", value: 50 }] }), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(out.decision.explanation).toMatch(/^Hold\. Waiting until RSI crosses above 50 \(now [\d.]+, already past it, so a new cross is needed\)\./);
  });

  it("prints the size an order really had, and the reason it was smaller", () => {
    const candles = series(falling(12));
    const { hour, fillPrice } = at(candles);
    const state = initialState(10_000, hour);
    const small = { ok: true as const, side: "buy" as const, notional: 490, qty: 0.25, fee: 0.245 };
    const plain = decide(ctx(), { candles, hour, state, fillPrice, liveFill: small });
    // The plan says 25%. The order was 4.9% of the cash, and that is what is printed, note or no note.
    expect(plain.decision.explanation).toMatch(/Bought \$490\.00 of ETH at \$[\d,.]+, 4\.9% of cash\.$/);
    const noted = decide(ctx(), { candles, hour, state, fillPrice, liveFill: { ...small, note: "The order was made smaller than the plan's 25%." } });
    expect(noted.decision.explanation).toMatch(/, 4\.9% of cash\. The order was made smaller than the plan's 25%\.$/);
    // An order of the planned size prints the plan's own figure.
    const full = decide(ctx(), { candles, hour, state, fillPrice, liveFill: { ...small, notional: 2500, qty: 1.3 } });
    expect(full.decision.explanation).toMatch(/, 25% of cash\.$/);
  });

  it("quotes no confidence for a scheduled purchase, and says when the next one is", () => {
    const dca: Partial<Plan> = { kind: "dca", entry: [], cadenceHours: 24, sizePctOfCash: 10, exit: { stopLossPct: 15 } };
    const candles = series(rising(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const buy = decide(ctx(dca), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(buy.decision.explanation).toMatch(/^Buy\. Scheduled purchase \(every day\)\. Bought \$1,000\.00 of ETH at \$[\d,.]+, 10% of cash\.$/);
    const held = decide(ctx(dca), { candles, hour, state: inPosition(hour, close), fillPrice });
    expect(held.decision.explanation).toBe("Hold. In position at 0.0% since buying. Stop at −15%. Next scheduled purchase in 14 hours.");
    // Due, but its condition is not met.
    const picky: Partial<Plan> = { ...dca, entry: [{ signal: "rsi", op: "<", value: 30 }] };
    const due = decide(ctx(picky), { candles, hour, state: initialState(10_000, hour), fillPrice });
    expect(due.decision.explanation).toMatch(/^Hold\. A scheduled purchase is due, but its condition is not met\. Waiting for: RSI is below 30 \(now [\d.]+\)\.$/);
  });

  it("names every way out of an open position, with the current reading of each exit rule", () => {
    const candles = series(falling(3, 0.001));
    const { hour, fillPrice, close } = at(candles);
    const held = (exit: Plan["exit"]) => decide(ctx({ exit }), { candles, hour, state: inPosition(hour, close), fillPrice }).decision.explanation;
    expect(held({ stopLossPct: 50, conditions: [{ signal: "rsi", op: ">", value: 70 }] })).toMatch(/^Hold\. In position at 0\.0% since buying\. Stop at −50%\. Also sells when RSI is above 70 \(now [\d.]+\)\.$/);
    expect(held({ conditions: [{ signal: "rsi", op: ">", value: 70 }] })).toMatch(/^Hold\. In position at 0\.0% since buying\. Sells when RSI is above 70 \(now [\d.]+\)\.$/);
    expect(held({ takeProfitPct: 8, trailingStopPct: 5 })).toBe("Hold. In position at 0.0% since buying. Take profit at +8%, trailing stop 5% under the high.");
    expect(held({})).toBe("Hold. In position at 0.0% since buying. The plan has no exit rule.");
  });

  it("with old prices and an open position, says the exits are not being checked", () => {
    const candles = series(falling(3, 0.001));
    const last = candles[candles.length - 1]!;
    const hour = last.t + 3 * HOUR_MS;
    const out = decide(ctx(), { candles, hour, state: inPosition(hour, last.c * 1.06), fillPrice: last.c });
    expect(out.decision.action).toBe("hold");
    expect(out.decision.explanation).toMatch(
      /^Hold\. The newest price data ends at \d\d:00 UTC, 2 hours before this decision\. Waiting for fresh data\. The position stays open, and its exits are not checked until prices are current\.$/,
    );
    // Nothing is decided on old prices, so no exit is opened either.
    expect(out.state.exitPending ?? null).toBeNull();
  });

  it("never prints a signed zero, or a plus sign on a size", () => {
    expect(pct(0.04)).toBe("0.0%");
    expect(pct(-0.04)).toBe("0.0%");
    expect(pct(0.05)).toBe("+0.1%");
    expect(pct(-2.34)).toBe("−2.3%");
    expect(formatSignalValue("change_pct", 0.001)).toBe("0.00%");
    expect(formatSignalValue("change_pct", -0.001)).toBe("0.00%");
    expect(formatSignalValue("change_pct", 1.5)).toBe("+1.50%");
    // A typical daily move is a size: it has no direction.
    expect(formatSignalValue("volatility_pct", 2.5)).toBe("2.50%");
  });
});
