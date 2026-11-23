import { describe, expect, it } from "vitest";
import { combineConfidence, negate, scoreCondition } from "../src/evidence";
import { runGuard, vetoes, type GuardInput } from "../src/guard";
import { applyBuy, applySell, equityOf, initialState, rollDay, utcDayStart } from "../src/paper";
import { HOUR_MS } from "../src/types";
import { T0 } from "./helpers";

describe("scoreCondition", () => {
  it("scores near zero when a rule barely holds and near 100 when it holds by a wide margin", () => {
    expect(scoreCondition("<", 30, 29.9, null, 10)).toBeGreaterThan(0);
    expect(scoreCondition("<", 30, 29.9, null, 10)).toBeLessThan(5);
    expect(scoreCondition("<", 30, 5, null, 10)).toBeGreaterThan(95);
    expect(scoreCondition(">", 0, -1, null, 0.5)).toBeLessThan(-90);
  });
  it("is monotonic in the margin", () => {
    const a = scoreCondition("<", 30, 28, null, 10);
    const b = scoreCondition("<", 30, 20, null, 10);
    expect(b).toBeGreaterThan(a);
  });
  it("rewards a fresh cross and mildly penalises being past the level without one", () => {
    expect(scoreCondition("crosses_above", 30, 31, 29, 10)).toBeGreaterThanOrEqual(60);
    expect(scoreCondition("crosses_above", 30, 35, 33, 10)).toBe(-20);
    expect(scoreCondition("crosses_above", 30, 10, 12, 10)).toBeLessThan(-20);
  });
});

describe("combineConfidence", () => {
  const e = (score: number) => ({ name: "x", value: "", score });
  it("maps -100..100 to 0..100 and weighs rules 60/40 over context", () => {
    expect(combineConfidence([e(100)], [e(100)])).toBe(100);
    expect(combineConfidence([e(-100)], [e(-100)])).toBe(0);
    expect(combineConfidence([], [])).toBe(50);
    expect(combineConfidence([e(100)], [e(-100)])).toBe(60);
    expect(combineConfidence([e(50)], [])).toBe(75);
  });
  it("negate flips scores for the opposite action", () => {
    expect(negate([e(30), e(0)]).map((x) => x.score)).toEqual([-30, 0]);
  });
});

describe("runGuard", () => {
  const base: GuardInput = {
    action: "buy",
    fresh: { ok: true, detail: "ok" },
    sizePctOfCash: 25,
    maxSizePct: 35,
    dailyPnlPct: -0.4,
    dailyLossCapPct: 3,
    regime: "trending",
    standsAsideWhenStressed: true,
  };
  it("passes a normal buy", () => {
    const g = runGuard(base);
    expect(vetoes(g)).toEqual([]);
    // Only what the guard really checks is listed. What the vault enforces by itself is not a row here.
    expect(g.map((c) => c.check)).toEqual(["Fresh data", "Trade size", "Daily loss", "Market stress"]);
    expect(g[1]!.detail).toBe("The plan uses 25% of cash per trade, within your 35% cap.");
    expect(g[2]!.detail).toBe("Down 0.4% today, under your 3% cap.");
    expect(g[3]!.detail).toBe("The market is trending, not stressed.");
  });
  it("vetoes oversize, past the daily loss cap, stressed markets and stale data", () => {
    expect(vetoes(runGuard({ ...base, sizePctOfCash: 40 }))).toEqual([{ check: "Trade size", pass: false, detail: "The plan uses 40% of cash per trade, over your 35% cap." }]);
    expect(vetoes(runGuard({ ...base, dailyPnlPct: -3.2 })).map((c) => c.check)).toEqual(["Daily loss"]);
    expect(vetoes(runGuard({ ...base, regime: "stressed" })).map((c) => c.check)).toEqual(["Market stress"]);
    expect(vetoes(runGuard({ ...base, fresh: { ok: false, detail: "old" } })).map((c) => c.check)).toEqual(["Fresh data"]);
  });
  it("never blocks a sell with buy-side limits", () => {
    const g = runGuard({ ...base, action: "sell", sizePctOfCash: 90, dailyPnlPct: -10, regime: "stressed" });
    expect(vetoes(g)).toEqual([]);
    expect(g.map((c) => c.check)).toEqual(["Fresh data"]);
  });
  it("never writes a change of nothing as a loss or a gain", () => {
    const loss = (dailyPnlPct: number) => runGuard({ ...base, dailyPnlPct })[2]!.detail;
    expect(loss(-0.04)).toBe("Flat today. Your cap is a 3% daily loss.");
    expect(loss(0.04)).toBe("Flat today. Your cap is a 3% daily loss.");
    expect(loss(0)).toBe("Flat today. Your cap is a 3% daily loss.");
    expect(loss(1.26)).toBe("Up 1.3% today. Your cap is a 3% daily loss.");
    // At the cap to one decimal it is "at", not "past".
    expect(loss(-3.04)).toBe("Down 3.0% today, at your 3% cap. No new buys until the next UTC day.");
    expect(loss(-3.2)).toBe("Down 3.2% today, past your 3% cap. No new buys until the next UTC day.");
  });
  it("only checks market stress when the plan asks for it", () => {
    expect(runGuard({ ...base, standsAsideWhenStressed: false, regime: "stressed" }).some((c) => c.check === "Market stress")).toBe(false);
  });
});

describe("paper accounting", () => {
  it("buys a share of cash with the cost taken from the notional", () => {
    const s0 = initialState(10_000, T0);
    const { state, fill } = applyBuy(s0, 2000, 25, 0.1, T0)!;
    expect(fill).toEqual({ side: "buy", price: 2000, qty: 1.24875, notional: 2500, fee: 2.5 });
    expect(state.cash).toBe(7500);
    expect(state.avgEntry).toBeCloseTo(2500 / 1.24875, 10);
    expect(equityOf(state, 2000)).toBeCloseTo(9997.5, 10);
  });
  it("averages the entry over several buys", () => {
    let s = initialState(10_000, T0);
    s = applyBuy(s, 100, 50, 0, T0)!.state; // 50 units
    s = applyBuy(s, 200, 50, 0, T0)!.state; // 12.5 units for 2500
    expect(s.qty).toBeCloseTo(62.5, 10);
    expect(s.avgEntry).toBeCloseTo(7500 / 62.5, 10);
  });
  it("sells the whole position with the cost taken from the proceeds", () => {
    let s = applyBuy(initialState(10_000, T0), 100, 100, 0, T0)!.state;
    const { state, fill } = applySell(s, 110, 0.1)!;
    expect(fill.notional).toBeCloseTo(11_000, 10);
    expect(fill.fee).toBeCloseTo(11, 10);
    expect(state.cash).toBeCloseTo(10_989, 10);
    expect(state.qty).toBe(0);
    expect(state.avgEntry).toBeNull();
    s = state;
    expect(applySell(s, 110, 0.1)).toBeNull();
  });
  it("refuses to buy with no cash", () => {
    expect(applyBuy({ ...initialState(0, T0) }, 100, 25, 0.1, T0)).toBeNull();
  });
  it("starts a new day's loss budget at UTC midnight", () => {
    const s = initialState(10_000, T0 + 5 * HOUR_MS);
    expect(rollDay(s, T0 + 23 * HOUR_MS, 1)).toBe(s);
    const bought = applyBuy(s, 100, 50, 0, T0)!.state;
    const next = rollDay(bought, T0 + 25 * HOUR_MS, 90);
    expect(next.dayStart).toBe(utcDayStart(T0 + 25 * HOUR_MS));
    expect(next.dayStartEquity).toBeCloseTo(5000 + 50 * 90, 10);
  });
});
