import { HOUR_MS, type Candle } from "@rationale/brain";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEHIND_CACHE_SECONDS, cleanCandles, countGaps, feedLag, isCurrent, loadCandles } from "../src/market/candles";
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

/**
 * The request the hourly run makes for the decision of hour H, two minutes into it: everything up to and including
 * the hour in progress. The decision reads the candle that closed at H and fills at the open of the hour starting at H.
 */
const H = T + 60 * HOUR_MS;
const FROM = T;
const TO = H + HOUR_MS;
const now = () => H + 2 * 60_000;
/** A feed's whole history up to the candle that opens at `last`. Each feed has prices of its own (the seed). */
const upTo = (last: number, seed: number) => synthCandles(FROM, last + HOUR_MS, seed);
/** Everything a healthy feed has at `now`: the hour that just closed, and the one in progress. */
const healthy = (seed: number) => upTo(H, seed);
/** Stuck: the newest closed candle it has is `hours` older than the one that just closed. */
const behindBy = (hours: number, seed: number) => upTo(H - HOUR_MS - hours * HOUR_MS, seed);

/** What the engine logged, one object per line. */
function logged() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as { msg: string; feed?: string; hoursBehind?: number; newestCandle?: string | null; noOpeningPrice?: boolean });
}

/** A Redis that only remembers, and says how long each key was asked to be kept. */
function fakeRedis() {
  const store = new Map<string, string>();
  const kept = new Map<string, number>();
  const redis = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, _ex: string, seconds: number) => {
      store.set(k, v);
      kept.set(k, seconds);
      return "OK";
    },
  };
  const secondsFor = (feed: string) => kept.get(`candles:${feed}:ETH:${FROM}:${TO}`);
  /** Time passes: whatever was kept for `seconds` or less is gone. */
  const expire = (seconds: number) => {
    for (const [k, s] of [...kept]) {
      if (s > seconds) continue;
      store.delete(k);
      kept.delete(k);
    }
  };
  return { redis: redis as unknown as Redis, secondsFor, expire };
}

describe("feedLag", () => {
  const at = now();
  it("is nothing when the answer has the hour that just closed and the one in progress", () => {
    expect(feedLag(healthy(1), FROM, TO, at)).toEqual({ hours: 0, noOpen: false, newest: H - HOUR_MS });
    expect(isCurrent(feedLag(healthy(1), FROM, TO, at))).toBe(true);
  });

  it("counts the closed hours missing at the end", () => {
    expect(feedLag(behindBy(1, 1), FROM, TO, at)).toEqual({ hours: 1, noOpen: true, newest: H - 2 * HOUR_MS });
    expect(feedLag(behindBy(3, 1), FROM, TO, at)).toMatchObject({ hours: 3, newest: H - 4 * HOUR_MS });
    // The same answer is further behind an hour later.
    expect(feedLag(behindBy(3, 1), FROM, TO + HOUR_MS, at + HOUR_MS).hours).toBe(4);
    // Nothing closed at all: every closed hour of the range is missing.
    expect(feedLag([healthy(1).at(-1)!], FROM, TO, at)).toEqual({ hours: 60, noOpen: false, newest: null });
  });

  it("an answer with the hour that just closed but no candle for the hour in progress has no opening price", () => {
    const lag = feedLag(upTo(H - HOUR_MS, 1), FROM, TO, at);
    expect(lag).toEqual({ hours: 0, noOpen: true, newest: H - HOUR_MS });
    expect(isCurrent(lag)).toBe(false);
  });

  it("a range that ends at the hour in progress asks for no opening price (market readings and backtests)", () => {
    expect(feedLag(upTo(H - HOUR_MS, 1), FROM, H, at)).toEqual({ hours: 0, noOpen: false, newest: H - HOUR_MS });
    expect(feedLag(upTo(H - 3 * HOUR_MS, 1), FROM, H, at).hours).toBe(2);
  });

  it("an hour decided late needs that hour's own candle, closed", () => {
    // The decision of hour H made 70 minutes late: the candle that opened at H has closed by then.
    const late = H + 70 * 60_000;
    expect(feedLag(upTo(H, 1), FROM, TO, late)).toEqual({ hours: 0, noOpen: false, newest: H });
    expect(feedLag(upTo(H - HOUR_MS, 1), FROM, TO, late)).toMatchObject({ hours: 1, noOpen: false });
  });

  it("a range that has not closed any hour yet is behind nothing", () => {
    expect(feedLag([], H, TO, at)).toEqual({ hours: 0, noOpen: true, newest: null });
    expect(feedLag([], H + HOUR_MS, H + 2 * HOUR_MS, at)).toEqual({ hours: 0, noOpen: false, newest: null });
  });
});

describe("loadCandles when a feed answers with old candles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes over a first feed that is three hours behind for a second that is current, and names the second", async () => {
    const lines = logged();
    const a = { n: 0 };
    const b = { n: 0 };
    const set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", behindBy(3, 1), a), fakeFeed("hyperliquid", healthy(2), b)], now });
    expect(set).toMatchObject({ source: "hyperliquid", sourceLabel: "hyperliquid:ETHUSDT", fromCache: false });
    // The series is the second feed's own, whole: nothing of the first is in it.
    expect(set.candles).toEqual(healthy(2));
    expect(set.candles.at(-1)!.t).toBe(H);
    expect([a.n, b.n]).toEqual([1, 1]);
    // One line for the owner: which feed, and by how much.
    const behind = lines().filter((l) => l.msg === "candle feed is behind");
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ level: "warn", market: "ETH", feed: "binance", hoursBehind: 3, newestCandle: new Date(H - 4 * HOUR_MS).toISOString() });
    expect(lines().some((l) => l.msg === "no candle feed is current; using the least behind")).toBe(false);
  });

  it("uses the fresher of two feeds that are both behind, whichever comes first", async () => {
    const lines = logged();
    let set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", behindBy(5, 1)), fakeFeed("hyperliquid", behindBy(2, 2))], now });
    expect(set.source).toBe("hyperliquid");
    expect(set.candles).toEqual(behindBy(2, 2));
    expect(lines().filter((l) => l.msg === "candle feed is behind").map((l) => [l.feed, l.hoursBehind])).toEqual([
      ["binance", 5],
      ["hyperliquid", 2],
    ]);
    expect(lines().find((l) => l.msg === "no candle feed is current; using the least behind")).toMatchObject({ feed: "hyperliquid", hoursBehind: 2 });

    set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", behindBy(2, 1)), fakeFeed("hyperliquid", behindBy(5, 2))], now });
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toEqual(behindBy(2, 1));
  });

  it("does not ask the second feed when the first is current", async () => {
    const lines = logged();
    const a = { n: 0 };
    const b = { n: 0 };
    const set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", healthy(1), a), fakeFeed("hyperliquid", healthy(2), b)], now });
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toEqual(healthy(1));
    expect([a.n, b.n]).toEqual([1, 0]);
    expect(lines().filter((l) => l.msg !== "candle gaps")).toEqual([]);
  });

  it("a first feed that throws is handled as before: the second is used, current or not", async () => {
    const down = () =>
      fakeFeed("binance", () => {
        throw new Error("HTTP 451");
      });
    const lines = logged();
    let set = await loadCandles("ETH", FROM, TO, { feeds: [down(), fakeFeed("hyperliquid", healthy(2))], now });
    expect(set).toMatchObject({ source: "hyperliquid", sourceLabel: "hyperliquid:ETHUSDT", fromCache: false });
    expect(set.candles).toEqual(healthy(2));
    expect(lines().map((l) => l.msg)).toEqual(["candle feed failed"]);

    // The only feed that answers is behind: its candles are still the best there is.
    set = await loadCandles("ETH", FROM, TO, { feeds: [down(), fakeFeed("hyperliquid", behindBy(3, 2))], now });
    expect(set.source).toBe("hyperliquid");
    expect(set.candles).toEqual(behindBy(3, 2));
    // And the other way round: a first feed that is behind is used when the second is down.
    set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", behindBy(3, 1)), { ...down(), name: "hyperliquid" }], now });
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toEqual(behindBy(3, 1));
  });

  it("passes over a feed that stopped during the last hour: it has that hour's candle but no opening price for this one", async () => {
    const lines = logged();
    const b = { n: 0 };
    const halted = upTo(H - HOUR_MS, 1);
    const set = await loadCandles("ETH", FROM, TO, { feeds: [fakeFeed("binance", halted), fakeFeed("hyperliquid", healthy(2), b)], now });
    expect(set.sourceLabel).toBe("hyperliquid:ETHUSDT");
    expect(b.n).toBe(1);
    expect(lines().find((l) => l.msg === "candle feed is behind")).toMatchObject({ feed: "binance", hoursBehind: 0, noOpeningPrice: true });

    // A market reading or a backtest asks for closed hours only. For those the same feed is current.
    b.n = 0;
    const closedOnly = await loadCandles("ETH", FROM, H, { feeds: [fakeFeed("binance", halted), fakeFeed("hyperliquid", healthy(2), b)], now });
    expect(closedOnly.sourceLabel).toBe("binance:ETHUSDT");
    expect(b.n).toBe(0);
  });

  it("when neither feed has the hour that just closed, stays with the first, and does not ask again for a few seconds", async () => {
    const a = { n: 0 };
    const b = { n: 0 };
    logged();
    const first: Candle[] = behindBy(1, 1);
    const second: Candle[] = behindBy(1, 2);
    const { redis, secondsFor, expire } = fakeRedis();
    const deps = { feeds: [fakeFeed("binance", first, a), fakeFeed("hyperliquid", second, b)], now, redis };

    // Both are asked once. On a tie the first in line is the source, so it does not change from call to call.
    let set = await loadCandles("ETH", FROM, TO, deps);
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toEqual(behindBy(1, 1));
    expect([a.n, b.n]).toEqual([1, 1]);
    // An answer that is behind is not kept for the usual two minutes.
    expect(secondsFor("binance")).toBe(BEHIND_CACHE_SECONDS);
    expect(secondsFor("hyperliquid")).toBe(BEHIND_CACHE_SECONDS);

    // Every other agent asking in those seconds gets the same answer, and no feed is asked again.
    for (let i = 0; i < 5; i++) set = await loadCandles("ETH", FROM, TO, deps);
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect([a.n, b.n]).toEqual([1, 1]);

    // A retry later: still behind. Each feed is asked once more, and the source is still the first.
    expire(BEHIND_CACHE_SECONDS);
    set = await loadCandles("ETH", FROM, TO, deps);
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect([a.n, b.n]).toEqual([2, 2]);

    // The first feed catches up. It is the source, the second is not asked, and the answer is kept the full time.
    expire(BEHIND_CACHE_SECONDS);
    first.push(...healthy(1).slice(-2));
    set = await loadCandles("ETH", FROM, TO, deps);
    expect(set.sourceLabel).toBe("binance:ETHUSDT");
    expect(set.candles).toEqual(healthy(1));
    expect([a.n, b.n]).toEqual([3, 2]);
    expect(secondsFor("binance")).toBe(120);
    set = await loadCandles("ETH", FROM, TO, deps);
    expect([a.n, b.n]).toEqual([3, 2]);
  });

  it("while the first feed stays behind, it is asked again only once its short-lived answer is gone; the second is kept the full time", async () => {
    const a = { n: 0 };
    const b = { n: 0 };
    const { redis, secondsFor, expire } = fakeRedis();
    logged();
    const deps = { feeds: [fakeFeed("binance", behindBy(3, 1), a), fakeFeed("hyperliquid", healthy(2), b)], now, redis };
    for (let i = 0; i < 4; i++) expect((await loadCandles("ETH", FROM, TO, deps)).sourceLabel).toBe("hyperliquid:ETHUSDT");
    expect([a.n, b.n]).toEqual([1, 1]);
    expect(secondsFor("binance")).toBe(BEHIND_CACHE_SECONDS);
    expect(secondsFor("hyperliquid")).toBe(120);
    expire(BEHIND_CACHE_SECONDS);
    expect((await loadCandles("ETH", FROM, TO, deps)).sourceLabel).toBe("hyperliquid:ETHUSDT");
    expect([a.n, b.n]).toEqual([2, 1]);
  });
});
