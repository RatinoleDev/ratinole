import { describe, expect, it } from "vitest";
import { LIVE_CHANNEL, liveKey, parseMiniTicker, parseRestTickers, storeTick } from "../src/market/live";

const msg = (s: string, c: string, o = "1800.00") =>
  JSON.stringify({ stream: `${s.toLowerCase()}@miniTicker`, data: { e: "24hrMiniTicker", E: 1795082927017, s, c, o, h: "1820.50", l: "1790.10", v: "1", q: "1" } });

describe("live prices", () => {
  it("parses Binance miniTicker messages for known markets only", () => {
    const t = parseMiniTicker(msg("ETHUSDT", "1809.00"))!;
    expect(t).toMatchObject({ market: "ETH", price: 1809, open24h: 1800, high24h: 1820.5, low24h: 1790.1, t: 1795082927017, source: "binance" });
    expect(t.change24Pct).toBeCloseTo(0.5, 10);
    expect(parseMiniTicker(msg("DOGEUSDT", "0.1"))).toBeNull();
    expect(parseMiniTicker(msg("ETHUSDT", "abc"))).toBeNull();
    expect(parseMiniTicker("not json")).toBeNull();
    expect(parseMiniTicker(JSON.stringify({ result: null, id: 1 }))).toBeNull();
  });

  it("parses the REST 24h ticker used while the stream is down", () => {
    const rows = [
      { symbol: "BTCUSDT", lastPrice: "63900.00", openPrice: "64000.00", highPrice: "64500", lowPrice: "63500", closeTime: 1795082927000 },
      { symbol: "XRPUSDT", lastPrice: "1", openPrice: "1", highPrice: "1", lowPrice: "1", closeTime: 1 },
    ];
    const out = parseRestTickers(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ market: "BTC", price: 63900, open24h: 64000 });
    expect(out[0]!.change24Pct).toBeCloseTo(-0.15625, 10);
    expect(parseRestTickers({ code: 0 })).toEqual([]);
  });

  it("stores each tick with a short expiry and publishes it", async () => {
    const calls: unknown[][] = [];
    const redis = { set: async (...a: unknown[]) => (calls.push(["set", ...a]), "OK"), publish: async (...a: unknown[]) => (calls.push(["publish", ...a]), 1) };
    const t = parseMiniTicker(msg("ETHUSDT", "1809.00"))!;
    await storeTick(redis as never, t);
    expect(calls).toEqual([
      ["set", liveKey("ETH"), JSON.stringify(t), "EX", 90],
      ["publish", LIVE_CHANNEL, JSON.stringify(t)],
    ]);
  });
});
