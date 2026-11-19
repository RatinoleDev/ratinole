import { HOUR_MS } from "@rationale/brain";
import { describe, expect, it } from "vitest";
import { cleanCandles, countGaps, loadCandles } from "../src/market/candles";
import { fakeFeed, synthCandles } from "./fakes";

const T = Date.UTC(2026, 10, 1);

describe("cleanCandles", () => {
  it("sorts, removes duplicates and drops malformed rows", () => {
    const c = synthCandles(T, T + 5 * HOUR_MS);
    const messy = [c[3]!, c[0]!, c[1]!, c[1]!, { ...c[2]!, c: Number.NaN }, { ...c[4]!, t: c[4]!.t + 5 }];
    const out = cleanCandles(messy);
    expect(out.map((x) => x.t)).toEqual([c[0]!.t, c[1]!.t, c[3]!.t]);
    expect(countGaps(out)).toBe(1);
  });
});

describe("loadCandles", () => {
  const series = synthCandles(T, T + 100 * HOUR_MS);

  it("uses the first feed that answers", async () => {
    const calls = { n: 0 };
    const set = await loadCandles("ETH", T, T + 50 * HOUR_MS, { feeds: [fakeFeed("binance", series, calls), fakeFeed("hyperliquid", series)] });
    expect(set.source).toBe("binance");
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toHaveLength(50);
    expect(calls.n).toBe(1);
  });

  it("falls back to the next feed when one fails", async () => {
    const broken = fakeFeed("binance", () => {
      throw new Error("HTTP 451");
    });
    const set = await loadCandles("ETH", T, T + 10 * HOUR_MS, { feeds: [broken, fakeFeed("hyperliquid", series)] });
    expect(set.source).toBe("hyperliquid");
    expect(set.fromCache).toBe(false);
  });

  it("treats an empty answer as a failure", async () => {
    const empty = fakeFeed("binance", []);
    const set = await loadCandles("ETH", T, T + 10 * HOUR_MS, { feeds: [empty, fakeFeed("hyperliquid", series)] });
    expect(set.source).toBe("hyperliquid");
  });

  it("throws, naming every failure, when nothing answers and there is no cache", async () => {
    const bad = (n: string) =>
      fakeFeed(n, () => {
        throw new Error("down");
      });
    await expect(loadCandles("ETH", T, T + HOUR_MS, { feeds: [bad("binance"), bad("hyperliquid")] })).rejects.toThrow(/binance: down; hyperliquid: down/);
  });
});
