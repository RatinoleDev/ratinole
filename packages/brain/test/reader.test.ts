import { describe, expect, it } from "vitest";
import { draftToPlan, readStrategy } from "../src";

const opts = { supportedMarkets: ["ETH", "BTC"], maxSizePct: 35, defaultSizePct: 25, defaultStopLossPct: 5 };
const read = (s: string) => draftToPlan(readStrategy(s), opts);
const plan = (s: string) => {
  const out = read(s);
  if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
  return out.plan;
};

describe("built-in strategy reader", () => {
  it("reads the usual shape: market, buy rule, exits, filter and size", () => {
    expect(plan("Buy ETH when RSI drops below 30 in an uptrend, skip if there is bad news, take profit at 8% and stop at 4%, use 25% per trade")).toEqual({
      markets: ["ETH"],
      kind: "entry_exit",
      entry: [
        { signal: "rsi", op: "<", value: 30 },
        { signal: "trend_pct", op: ">", value: 0 },
      ],
      exit: { takeProfitPct: 8, stopLossPct: 4 },
      filters: ["negative_news"],
      sizePctOfCash: 25,
    });
  });

  it("reads looser wording, capitals and shorthand the same way", () => {
    expect(plan("BUY ETH WHEN RSI IS BELOW 30, TAKE PROFIT 8%, STOP LOSS 4%, USE 20% PER TRADE").entry).toEqual([{ signal: "rsi", op: "<", value: 30 }]);
    const p = plan("Buy ETH when RSI < 30, TP 8%, SL 4%, size 20%");
    expect(p).toMatchObject({ entry: [{ signal: "rsi", op: "<", value: 30 }], exit: { takeProfitPct: 8, stopLossPct: 4 }, sizePctOfCash: 20 });
    const q = plan("Please buy some bitcoin whenever the RSI gets under 28, and sell once RSI is over 65. Stop loss 5%, risk 15% per trade.");
    expect(q).toMatchObject({ markets: ["BTC"], entry: [{ signal: "rsi", op: "<", value: 28 }], exit: { stopLossPct: 5, conditions: [{ signal: "rsi", op: ">", value: 65 }] }, sizePctOfCash: 15 });
  });

  it("reads windows only where the sentence gives one", () => {
    expect(plan("Buy ETH on a 3% dip under its 20-hour average, stop 4%").entry).toEqual([{ signal: "price_vs_sma_pct", op: "<", value: -3, window: 20 }]);
    expect(plan("Buy ETH on a 3% dip, stop 4%").entry).toEqual([{ signal: "price_vs_sma_pct", op: "<", value: -3 }]);
    expect(plan("Buy ETH when price is 10% off its 7-day high and volume is 3x normal, trailing stop 5%").entry).toEqual([
      { signal: "from_high_pct", op: "<", value: -10, window: 168 },
      { signal: "volume_ratio", op: ">", value: 3 },
    ]);
    expect(plan("Buy ETH if the 14-hour RSI is under 30. Take profit 5 percent, stop 2,5 persen.")).toMatchObject({
      entry: [{ signal: "rsi", op: "<", value: 30, window: 14 }],
      exit: { takeProfitPct: 5, stopLossPct: 2.5 },
    });
  });

  it("tells a price change over a period from a stop or a target in the sell rule", () => {
    const p = plan("Buy ETH when it drops 5% in a day, sell if it rises 6%, stop loss 4%");
    expect(p.entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 24 }]);
    expect(p.exit).toEqual({ takeProfitPct: 6, stopLossPct: 4 });
  });

  it("reads 'sell when it crosses below it' as the buy rule's signal, the other way", () => {
    const p = plan("Buy ETH when the price crosses back above its 50-hour average, sell when it crosses below it, stop at 3%");
    expect(p.entry).toEqual([{ signal: "price_vs_sma_pct", op: "crosses_above", value: 0, window: 50 }]);
    expect(p.exit.conditions).toEqual([{ signal: "price_vs_sma_pct", op: "crosses_below", value: 0, window: 50 }]);
  });

  it("reads Indonesian", () => {
    expect(plan("Beli BTC kalau RSI di bawah 25 dan tren sedang naik, ambil untung 10%, batas rugi 5%, pakai 15% per transaksi")).toMatchObject({
      markets: ["BTC"],
      entry: [
        { signal: "rsi", op: "<", value: 25 },
        { signal: "trend_pct", op: ">", value: 0 },
      ],
      exit: { takeProfitPct: 10, stopLossPct: 5 },
      sizePctOfCash: 15,
    });
    expect(plan("Beli ETH setiap hari pakai 5% dari modal, stop loss 20%")).toMatchObject({ kind: "dca", cadenceHours: 24, sizePctOfCash: 5 });
    expect(plan("Beli ETH kalau harga turun lebih dari 5% dalam 24 jam, stop loss 4%").entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 24 }]);
  });

  it("never invents a number: missing size and stop get the documented defaults, with a note", () => {
    const out = read("Buy ETH when RSI is below 30");
    expect(out).toMatchObject({ ok: true, plan: { sizePctOfCash: 25, exit: { stopLossPct: 5 } } });
    expect(out.ok && out.notes.join(" ")).toMatch(/No size was given.*No loss limit was given/);
  });

  it("names the part it cannot read instead of dropping it", () => {
    const macd = read("Buy ETH when RSI below 30 and MACD crosses up, stop 5%");
    expect(macd).toMatchObject({ ok: false, code: "rephrase" });
    expect(!macd.ok && macd.message).toContain('"and macd crosses up"');
    const second = read("Buy ETH when RSI is below 30 or above 80, stop 5%");
    expect(!second.ok && second.message).toContain('"or above 80"');
    const sell = read("Buy ETH when RSI is below 30, sell when it looks toppy, stop 5%");
    expect(!sell.ok && sell.message).toContain('the sell rule: "sell when it looks toppy"');
  });

  it("refuses short selling and leverage rather than reading them as a buy", () => {
    for (const s of ["Short ETH when RSI is above 70, stop 5%", "Buy BTC with 5x leverage when RSI below 30"]) {
      const out = read(s);
      expect(out).toMatchObject({ ok: false, code: "rephrase" });
      expect(!out.ok && out.message).toMatch(/spot only/);
    }
  });

  it("gives the same refusals as a model draft would for markets, data and ranges", () => {
    expect(read("Buy SOL when RSI is below 30, stop 5%")).toMatchObject({ ok: false, code: "unsupported_market" });
    expect(read("Buy NVDA on a 3% dip, stop 5%")).toMatchObject({ ok: false, code: "unsupported_market" });
    expect(read("Buy BTC when whales are buying, stop 5%")).toMatchObject({ ok: false, code: "unsupported_signal" });
    expect(read("Buy ETH when RSI is below 130, stop 5%")).toMatchObject({ ok: false, code: "rephrase" });
    expect(read("Buy ETH when RSI is below 30, stop 5%, use 50% per trade")).toMatchObject({ ok: false, code: "size_over_cap" });
    expect(read("Hello, how are you today?")).toMatchObject({ ok: false, code: "rephrase" });
  });

  it("reads everyday words as words, not tickers", () => {
    // "ada" (Indonesian "there is"), "link", "coin" and "meta" are tickers only in capitals.
    expect(plan("Beli ETH kalau RSI di bawah 30, hindari kalau ada berita buruk, stop loss 4%")).toMatchObject({ markets: ["ETH"], filters: ["negative_news"] });
    expect(plan("Buy this coin ETH when RSI is below 30, stop 5%").markets).toEqual(["ETH"]);
    expect(read("Buy COIN when RSI is below 30, stop 5%")).toMatchObject({ ok: false, code: "unsupported_market" });
  });
});
