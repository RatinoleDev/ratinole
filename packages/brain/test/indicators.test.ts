import { describe, expect, it } from "vitest";
import { logReturns, pctChange, rollingMax, rollingStd, rsi, sma, trailingMeanExcl } from "../src/indicators";
import { rng } from "./helpers";

describe("sma", () => {
  it("averages the last w values and is null before that", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("returns all nulls for a bad window", () => {
    expect(sma([1, 2], 0)).toEqual([null, null]);
  });
});

describe("rsi", () => {
  it("is 100 when price only rises and 0 when it only falls", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(down, 14).at(-1)).toBe(0);
  });
  it("is 50 for a flat series and null before it has 14 changes", () => {
    const flat = new Array(20).fill(10);
    const r = rsi(flat, 14);
    expect(r[13]).toBeNull();
    expect(r[14]).toBe(50);
  });
  it("matches the textbook Wilder value", () => {
    // Classic StockCharts example: avg gain 3.34/14, avg loss 1.40/14 -> RSI 70.46.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(closes, 14)[14]).toBeCloseTo(70.464, 2);
  });
  it("stays within 0..100", () => {
    const r = rng(7);
    const closes = Array.from({ length: 500 }, () => 100 + r() * 10);
    for (const v of rsi(closes, 14)) if (v != null) expect(v >= 0 && v <= 100).toBe(true);
  });
});

describe("rollingStd", () => {
  it("matches the sample standard deviation", () => {
    const v = [2, 4, 4, 4, 5, 5, 7, 9];
    const s = rollingStd(v, 8);
    expect(s[7]).toBeCloseTo(2.138, 3);
    expect(s[6]).toBeNull();
  });
  it("skips nulls without counting them", () => {
    const s = rollingStd([null, 1, 2, 3], 3);
    expect(s[2]).toBeNull();
    expect(s[3]).toBeCloseTo(1, 10);
  });
});

describe("rollingMax / pctChange / trailingMeanExcl / logReturns", () => {
  it("rollingMax tracks the highest value in the window", () => {
    expect(rollingMax([1, 3, 2, 5, 4, 1], 3)).toEqual([null, null, 3, 5, 5, 5]);
  });
  it("pctChange compares with `lag` steps earlier", () => {
    expect(pctChange([100, 110, 121], 1)[2]).toBeCloseTo(10, 10);
    expect(pctChange([100, null, 121], 1)[1]).toBeNull();
  });
  it("trailingMeanExcl averages the values before i", () => {
    expect(trailingMeanExcl([1, 2, 3, 4], 2)).toEqual([null, null, 1.5, 2.5]);
  });
  it("logReturns starts with null", () => {
    const r = logReturns([100, 110]);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(Math.log(1.1), 12);
  });
});

describe("causality", () => {
  it("values at i do not change when later data is added", () => {
    const r = rng(3);
    const full = Array.from({ length: 400 }, () => 100 + r() * 20);
    const cut = 250;
    const prefix = full.slice(0, cut + 1);
    const pairs: [(x: number[]) => (number | null)[], string][] = [
      [(x) => sma(x, 20), "sma"],
      [(x) => rsi(x, 14), "rsi"],
      [(x) => rollingStd(logReturns(x), 24), "std"],
      [(x) => rollingMax(x, 72), "max"],
      [(x) => pctChange(sma(x, 50), 24), "slope"],
      [(x) => trailingMeanExcl(x, 24), "mean"],
    ];
    for (const [f] of pairs) expect(f(full)[cut]).toBeCloseTo(f(prefix)[cut]!, 9);
  });
});
