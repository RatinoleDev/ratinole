import { describe, expect, it } from "vitest";
import { decide, DEFAULT_PARAMS, type DecideContext } from "../src/decide";
import { downsample, maxDrawdownPct, returnPct } from "../src/backtest/metrics";
import { simulate } from "../src/backtest/simulate";
import { buildGrid, paramsText, requiredWarmup, walkForward } from "../src/backtest/walkforward";
import { initialState } from "../src/paper";
import { SeriesSource } from "../src/signals";
import { HOUR_MS, type Plan } from "../src/types";
import { realEth, walk } from "./helpers";

const plan: Plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [
    { signal: "rsi", op: "<", value: 35 },
    { signal: "trend_pct", op: ">", value: 0 },
  ],
  exit: { takeProfitPct: 4, stopLossPct: 3 },
  filters: [],
  sizePctOfCash: 25,
};
const limits = { maxSizePct: 35, dailyLossCapPct: 3 };
const ctx = (p: Plan = plan): DecideContext => ({ agentId: "bt", plan: p, params: DEFAULT_PARAMS, limits, costPct: 0.1 });

describe("metrics", () => {
  it("computes return and worst drop", () => {
    expect(returnPct([110, 99, 120], 100)).toBeCloseTo(20, 10);
    expect(maxDrawdownPct([110, 99, 120], 100)).toBeCloseTo(-10, 10);
    expect(maxDrawdownPct([101, 102], 100)).toBe(0);
  });
  it("downsamples but keeps the last point", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(pts, 100);
    expect(d.length).toBeLessThanOrEqual(101);
    expect(d[d.length - 1]).toBe(999);
  });
});

describe("simulate", () => {
  const candles = walk(1500, { seed: 5, vol: 0.006 });
  const src = new SeriesSource(candles);

  it("produces one equity point per decision and buys holding at the first fill", () => {
    const sim = simulate({ ctx: ctx(), src, start: 800, end: 1400, startCash: 10_000 });
    expect(sim.equity).toHaveLength(600);
    expect(sim.hours[0]).toBe(candles[800]!.t + HOUR_MS);
    expect(sim.holding[0]).toBeCloseTo(9990, 6);
    for (const t of sim.trades) expect(["buy", "sell"]).toContain(t.side);
  });

  it("never looks ahead: changing candles after the window changes nothing", () => {
    const a = simulate({ ctx: ctx(), src, start: 800, end: 1200, startCash: 10_000 });
    const altered = candles.map((c, i) => (i > 1200 ? { ...c, o: c.o * 3, h: c.h * 3, l: c.l * 3, c: c.c * 3, v: c.v * 9 } : c));
    const b = simulate({ ctx: ctx(), src: new SeriesSource(altered), start: 800, end: 1200, startCash: 10_000 });
    expect(b).toEqual(a);
  });

  it("runs exactly the live decision code", () => {
    const start = 900;
    const sim = simulate({ ctx: ctx(), src, start, end: start + 5, startCash: 10_000, keepDecisions: true });
    const hour = candles[start]!.t + HOUR_MS;
    const live = decide(ctx(), { candles: candles.slice(0, start + 1), hour, state: initialState(10_000, hour), fillPrice: candles[start + 1]!.o });
    expect(sim.decisions![0]).toEqual(live.decision);
  });
});

describe("tuning grid", () => {
  it("tunes only what the sentence left open", () => {
    // rsi has a single choice; trend may be 100 or 200; four thresholds.
    expect(buildGrid(plan)).toHaveLength(8);
    const fixed: Plan = { ...plan, entry: [{ signal: "rsi", op: "<", value: 35 }, { signal: "trend_pct", op: ">", value: 0, window: 200 }] };
    expect(buildGrid(fixed)).toHaveLength(4);
    expect(buildGrid(fixed).every((p) => Object.keys(p.windows).length === 0)).toBe(true);
    const dca: Plan = { ...plan, kind: "dca", entry: [], cadenceHours: 24 };
    expect(buildGrid(dca)).toHaveLength(1);
  });
  it("puts the default settings first so ties keep them", () => {
    expect(buildGrid(plan)[0]).toEqual({ confidenceThreshold: 50, windows: { "entry.1": 100 } });
  });
  it("needs at least a month of history before the first decision", () => {
    expect(requiredWarmup(plan)).toBeGreaterThan(720);
  });
});

describe("walkForward", () => {
  it("tunes on the first two thirds and scores the rest unseen", () => {
    const candles = walk(2400, { seed: 11, vol: 0.006, drift: 0.0001 });
    const evalStart = requiredWarmup(plan);
    const before = JSON.stringify(plan);
    const res = walkForward({ plan, candles, evalStart, startCash: 10_000, costPct: 0.1, limits });
    const n = candles.length - 1 - evalStart;
    expect(res.tune.hours).toBe(Math.floor(n * (2 / 3)));
    expect(res.unseen.hours).toBe(n - res.tune.hours);
    expect(res.unseen.from).toBe(res.splitHour);
    expect(res.tune.to).toBeLessThan(res.unseen.from);
    expect(buildGrid(plan)).toContainEqual(res.params);
    expect(JSON.stringify(plan)).toBe(before); // the user's plan is never edited
    expect(res.curve.length).toBeLessThanOrEqual(361);
    expect(res.curve[0]!.strategy).toBeCloseTo(100, 0);
  });

  it("supports several walk-forward folds", () => {
    const candles = walk(2400, { seed: 12, vol: 0.006 });
    const res = walkForward({ plan, candles, evalStart: requiredWarmup(plan), folds: 3, startCash: 10_000, costPct: 0.1, limits });
    expect(res.folds).toHaveLength(3);
    expect(res.unseen.hours).toBe(res.folds.reduce((a, f) => a + f.test.hours, 0));
    for (let k = 1; k < 3; k++) expect(res.folds[k]!.test.from).toBeGreaterThan(res.folds[k - 1]!.test.to);
  });

  it("runs on real ETH candles and returns finite numbers", () => {
    const candles = realEth();
    const evalStart = candles.length - 1 - 90 * 24;
    expect(evalStart).toBeGreaterThanOrEqual(requiredWarmup(plan));
    const res = walkForward({ plan, candles, evalStart, startCash: 10_000, costPct: 0.1, limits });
    for (const v of [res.tune.returnPct, res.unseen.returnPct, res.unseen.holdingPct, res.unseen.maxDrawdownPct]) expect(Number.isFinite(v)).toBe(true);
    expect(res.unseen.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(res.unseen.hours).toBe(720);
  });

  it("explains what the tuner chose", () => {
    const lines = paramsText(plan, { confidenceThreshold: 60, windows: { "entry.1": 200 } });
    expect(lines).toEqual([
      '"The long trend is rising" uses the 200-hour window, chosen on the tuning days.',
      "Buys only when confidence is at least 60%, chosen on the tuning days.",
    ]);
  });
});

describe("backtestWarnings", () => {
  it("warns about tiny samples and a tuner that chose not to trade", async () => {
    const { backtestWarnings } = await import("../src/backtest/warnings");
    expect(backtestWarnings({ tunedTrades: 12, unseenTrades: 14 })).toEqual([]);
    const few = backtestWarnings({ tunedTrades: 6, unseenTrades: 4 });
    expect(few).toHaveLength(1);
    expect(few[0]).toMatch(/^Only 4 buys and sells on the unseen days: too few to tell skill from luck/);
    const none = backtestWarnings({ tunedTrades: 0, unseenTrades: 0 });
    expect(none[0]).toMatch(/tuner chose the strictest one/);
    expect(none[1]).toMatch(/nothing to judge yet/);
  });
});
