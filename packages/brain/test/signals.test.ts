import { describe, expect, it } from "vitest";
import { SIGNALS, SIGNAL_IDS, SeriesSource, conditionHolds, formatSignalValue, isSignalId } from "../src/signals";
import { fromCloses } from "./helpers";

describe("signal registry", () => {
  it("every available signal can be computed; unavailable ones name the data they need", () => {
    for (const id of SIGNAL_IDS) {
      const s = SIGNALS[id];
      if (s.available) expect(typeof s.compute).toBe("function");
      else {
        expect(s.compute).toBeUndefined();
        expect(s.needs).toBeTruthy();
      }
    }
  });
  it("recognises signal ids", () => {
    expect(isSignalId("rsi")).toBe(true);
    expect(isSignalId("vibes")).toBe(false);
  });
});

describe("SeriesSource", () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i);
  const src = new SeriesSource(fromCloses(closes));

  it("computes price vs average", () => {
    const s = src.signal("price_vs_sma_pct", 20);
    const i = 299;
    const avg = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    expect(s[i]).toBeCloseTo((closes[i]! / avg - 1) * 100, 10);
  });
  it("computes trend as the 24-hour change of the average", () => {
    const s = src.signal("trend_pct", 100);
    expect(s[299]).toBeGreaterThan(0);
    expect(s[122]).toBeNull(); // needs 100 + 24 candles
  });
  it("computes change, distance from high and volume ratio", () => {
    expect(src.signal("change_pct", 24)[299]).toBeCloseTo((399 / 375 - 1) * 100, 10);
    expect(src.signal("from_high_pct", 72)[299]).toBeCloseTo(0, 10);
    expect(src.signal("volume_ratio", 24)[299]).toBeCloseTo(1, 10);
  });
  it("memoizes each (signal, window)", () => {
    expect(src.signal("rsi", 14)).toBe(src.signal("rsi", 14));
  });
  it("refuses unavailable signals", () => {
    expect(() => src.signal("funding_rate")).toThrow();
  });
});

describe("conditionHolds", () => {
  it("handles comparisons", () => {
    expect(conditionHolds("<", 30, 29, null)).toBe(true);
    expect(conditionHolds(">", 30, 29, null)).toBe(false);
  });
  it("needs a fresh cross for crossing ops", () => {
    expect(conditionHolds("crosses_above", 30, 31, 29)).toBe(true);
    expect(conditionHolds("crosses_above", 30, 31, 30)).toBe(true);
    expect(conditionHolds("crosses_above", 30, 32, 31)).toBe(false);
    expect(conditionHolds("crosses_above", 30, 31, null)).toBe(false);
    expect(conditionHolds("crosses_below", 0, -1, 1)).toBe(true);
  });
});

describe("formatSignalValue", () => {
  it("formats by unit", () => {
    expect(formatSignalValue("rsi", 27.4)).toBe("27.4");
    expect(formatSignalValue("price_vs_sma_pct", -3.456)).toBe("−3.46%");
    expect(formatSignalValue("trend_pct", 0.42)).toBe("+0.42%");
    expect(formatSignalValue("volume_ratio", 1.8)).toBe("1.80×");
  });
});
