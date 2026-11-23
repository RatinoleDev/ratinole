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

/** Same checks, with a wallet whose cap is 100%, so a size read from the sentence is not refused for being over the cap. */
const wide = { ...opts, maxSizePct: 100 };
const planWide = (s: string) => {
  const out = draftToPlan(readStrategy(s), wide);
  if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
  return out.plan;
};
const RSI = [{ signal: "rsi", op: "<", value: 30 }];
const SELL_AT_70 = [{ signal: "rsi", op: ">", value: 70 }];

describe("each number stays with the rule it was written for", () => {
  it("reads two exits written one after the other, in either order", () => {
    expect(plan("Buy ETH when RSI is below 30, take profit 8% trailing stop 3%").exit).toEqual({ takeProfitPct: 8, trailingStopPct: 3 });
    expect(plan("Buy ETH when RSI is below 30, stop loss 4% trailing 2%").exit).toEqual({ stopLossPct: 4, trailingStopPct: 2 });
    expect(plan("Buy ETH when RSI is below 30, tp 8% sl 4% trailing 3%").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4, trailingStopPct: 3 });
    expect(plan("Buy ETH when RSI is below 30, take profit 8% stop loss 4%").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI is below 30, stop loss 4% take profit 8%").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI is below 30, trailing stop of 5%, take profit 12%").exit).toEqual({ takeProfitPct: 12, trailingStopPct: 5 });
  });

  it("reads the number-first forms too", () => {
    expect(plan("Buy ETH when RSI is below 30, 4% stop loss, 8% take profit").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI is below 30, a 5% trailing stop and a 12% take profit").exit).toEqual({ takeProfitPct: 12, trailingStopPct: 5 });
    expect(plan("Buy ETH when RSI is below 30, with a 4% stop and a 8% profit target").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI is below 30, 8% take profit, 4% stop, 20% per trade")).toMatchObject({ exit: { takeProfitPct: 8, stopLossPct: 4 }, sizePctOfCash: 20 });
  });

  it("asks instead of guessing when it cannot tell which number belongs to which rule", () => {
    const out = read("Buy ETH when RSI is below 30, 4% stop loss 8% take profit");
    expect(out).toMatchObject({ ok: false, code: "rephrase" });
    expect(!out.ok && out.message).toContain('I couldn\'t read this part: "4%"');
  });

  it("reads a stop before a size: 'stop loss 2% per trade' is a stop, not a size", () => {
    const sentence = "Buy ETH when RSI is below 30, stop loss 2% per trade, take profit 6%";
    expect(readStrategy(sentence)).toMatchObject({ sizePctOfCash: null, exit: { takeProfitPct: 6, stopLossPct: 2, trailingStopPct: null } });
    const out = read(sentence);
    expect(out).toMatchObject({ ok: true, plan: { exit: { takeProfitPct: 6, stopLossPct: 2 }, sizePctOfCash: 25 } });
    expect(out.ok && out.notes).toEqual(["No size was given, so each trade uses 25% of cash."]);
    expect(plan("Buy ETH when RSI is below 30 and stop loss is 4% per trade, 20% per trade")).toMatchObject({ exit: { stopLossPct: 4 }, sizePctOfCash: 20 });
  });

  it("still reads a size where the sentence gives one", () => {
    expect(plan("Buy ETH when RSI is below 30, stop 5%, use 25% per trade")).toMatchObject({ exit: { stopLossPct: 5 }, sizePctOfCash: 25 });
    expect(plan("Buy ETH when RSI is below 30, risk 2% per trade, stop 5%")).toMatchObject({ exit: { stopLossPct: 5 }, sizePctOfCash: 2 });
    expect(plan("Buy ETH when RSI is below 30, risk 2% per trade with a 4% stop")).toMatchObject({ exit: { stopLossPct: 4 }, sizePctOfCash: 2 });
    expect(plan("Buy ETH when RSI is below 30 with 20% of my cash and a 4% stop")).toMatchObject({ exit: { stopLossPct: 4 }, sizePctOfCash: 20 });
  });

  it("refuses two different numbers for one rule, and accepts the same number said twice", () => {
    const two = read("Buy ETH when RSI is below 30, take profit 8%, take profit 12%, stop 5%");
    expect(two).toEqual({ ok: false, code: "rephrase", message: "Two different take profit numbers were given, 8% and 12%. Keep one. Try rephrasing." });
    const stops = read("Buy ETH when RSI is below 30, sell when RSI is above 70 or it falls 4%, stop 5%");
    expect(!stops.ok && stops.message).toBe("Two different stop loss numbers were given, 5% and 4%. Keep one. Try rephrasing.");
    expect(plan("Buy ETH when RSI is below 30, stop loss 4%, sell if it falls 4%").exit).toEqual({ stopLossPct: 4 });
  });
});

describe("sell rules", () => {
  it("reads every sell rule in the sentence, not only the first", () => {
    const p = plan("Buy ETH when RSI is below 30, sell if it rises 8%, sell if it falls 4%");
    expect(p.entry).toEqual(RSI);
    expect(p.exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    const id = plan("Beli ETH kalau RSI di bawah 30, jual kalau naik 8%, jual kalau turun 4%");
    expect(id.entry).toEqual(RSI);
    expect(id.exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    const q = plan("Buy ETH when RSI is below 30, sell when it gains 8%. Stop out if it loses 4%.");
    expect(q.entry).toEqual(RSI);
    expect(q.exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
  });

  it("reads 'stop if it falls 4%' as the stop, never as a buy rule", () => {
    for (const s of [
      "Buy ETH when RSI is below 30, stop if it falls 4%",
      "Buy ETH when RSI is below 30, stop out when it drops 4%",
      "Buy ETH when RSI is below 30, with a stop if it falls 4%",
      "Buy ETH when RSI is below 30. Sell everything if it falls 4%.",
      "Buy ETH when RSI is below 30, exit my position if it drops 4%",
      "Buy ETH when RSI is below 30, get out if it drops 4%",
      "Buy ETH when RSI is below 30, sell if it falls 4% below my entry",
      "Beli ETH kalau RSI di bawah 30, tutup posisi kalau turun 4%",
    ]) {
      const p = plan(s);
      expect(p.entry, s).toEqual(RSI);
      expect(p.exit, s).toEqual({ stopLossPct: 4 });
    }
  });

  it("reads a sell rule that names what it sells as an exit, not as a second buy rule", () => {
    for (const s of [
      "Buy ETH when RSI is below 30, sell everything when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, sell all when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, sell it all when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, close the position when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, sell ETH when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, exit the trade once RSI is over 70, stop 5%",
      "Buy ETH when RSI is below 30, take profit when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, hold until RSI is above 70, stop 5%",
      "Beli ETH kalau RSI di bawah 30, jual semua kalau RSI di atas 70, stop loss 5%",
    ]) {
      const p = plan(s);
      expect(p.entry, s).toEqual(RSI);
      expect(p.exit, s).toEqual({ stopLossPct: 5, conditions: SELL_AT_70 });
    }
  });

  it("keeps the second half of 'sell at 10% profit or when RSI is above 70' in the sell rule", () => {
    const p = plan("Buy ETH when RSI is below 30, sell at 10% profit or when RSI is above 70, stop 5%");
    expect(p.entry).toEqual(RSI);
    expect(p.exit).toEqual({ takeProfitPct: 10, stopLossPct: 5, conditions: SELL_AT_70 });
    expect(plan("Buy ETH when RSI is below 30, take profit if it rises 8%, cut losses if it falls 4%").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI drops below 30, sell everything if RSI goes above 70 or the price falls 5%, use 20% of my cash per trade")).toMatchObject({
      entry: RSI,
      exit: { stopLossPct: 5, conditions: SELL_AT_70 },
      sizePctOfCash: 20,
    });
  });

  it("does not take 'the close' for a sell", () => {
    expect(plan("Buy ETH at the daily close when RSI is below 30, stop 5%")).toMatchObject({ kind: "entry_exit", entry: RSI, exit: { stopLossPct: 5 } });
  });

  it("names a sell rule it cannot read", () => {
    const out = read("Buy ETH when RSI is below 30, stop when the trend turns down");
    expect(out).toMatchObject({ ok: false, code: "rephrase" });
    expect(!out.ok && out.message).toContain('the sell rule: "stop when the trend turns down"');
  });
});

describe("trailing stops", () => {
  it("reads a trailing stop described in words as a trailing stop, not as a buy rule", () => {
    for (const s of [
      "Buy ETH when RSI is below 30 with a trailing stop that sells if it drops 5% from the peak",
      "Buy ETH when RSI is below 30, trailing stop 5% from the high",
      "Buy ETH when RSI is below 30, trailing stop at 5% below the peak",
      "Buy ETH when RSI is below 30, trailing stop that triggers 5% below the peak",
      "Buy ETH when RSI is below 30, with a trailing stop of 5% that sells if it drops",
      "Buy ETH when RSI is below 30, trail by 5% from the high",
      "Buy ETH when RSI is below 30, 5% trailing stop",
      "Buy ETH when RSI is below 30, sell if it drops 5% from the peak",
      "Buy ETH when RSI is below 30, sell when price is 5% below the peak since buying",
    ]) {
      const p = plan(s);
      expect(p.entry, s).toEqual(RSI);
      expect(p.exit, s).toEqual({ trailingStopPct: 5 });
    }
  });

  it("does not give a trailing stop the number of the rule after it", () => {
    const p = plan("Buy ETH when RSI is below 30 and a 12% trailing stop and sell if it drops 13% and 4% profit");
    expect(p.entry).toEqual(RSI);
    expect(p.exit).toEqual({ takeProfitPct: 4, stopLossPct: 13, trailingStopPct: 12 });
  });

  it("keeps a fall from a high over a stated period as the condition it is", () => {
    const p = plan("Buy ETH when RSI is below 30, sell if it drops 5% from its 3-day high, stop 6%");
    expect(p.exit).toEqual({ stopLossPct: 6, conditions: [{ signal: "from_high_pct", op: "<", value: -5, window: 72 }] });
    expect(plan("Buy BTC when the price is 5% below its 3-day high, trailing stop of 6%, 15% per trade")).toMatchObject({
      entry: [{ signal: "from_high_pct", op: "<", value: -5, window: 72 }],
      exit: { trailingStopPct: 6 },
    });
  });
});

describe("numbers and sizes written in words", () => {
  it("reads a number word in front of percent", () => {
    expect(plan("Buy ETH when RSI is below 30, take profit at eight percent and stop at four percent").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Buy ETH when RSI is below 30, use ten percent per trade, stop 5%")).toMatchObject({ sizePctOfCash: 10, exit: { stopLossPct: 5 } });
    expect(plan("Buy ETH when RSI is below 30, take profit at twenty five percent, stop at 5%").exit).toEqual({ takeProfitPct: 25, stopLossPct: 5 });
    expect(plan("Buy ETH when RSI is below 30, take profit at one hundred percent, stop at twenty-five percent").exit).toEqual({ takeProfitPct: 100, stopLossPct: 25 });
    expect(plan("Buy ETH when RSI is below 30, take profit at two point five percent, stop at one percent").exit).toEqual({ takeProfitPct: 2.5, stopLossPct: 1 });
    expect(plan("Buy ETH when RSI is below 30, tp ten %, sl five %").exit).toEqual({ takeProfitPct: 10, stopLossPct: 5 });
  });

  it("reads Indonesian number words in front of persen", () => {
    expect(plan("Beli ETH kalau RSI di bawah 30, ambil untung delapan persen, stop loss empat persen").exit).toEqual({ takeProfitPct: 8, stopLossPct: 4 });
    expect(plan("Beli ETH kalau RSI di bawah 30, ambil untung dua puluh lima persen, batas rugi lima belas persen, pakai sepuluh persen per transaksi")).toMatchObject({
      exit: { takeProfitPct: 25, stopLossPct: 15 },
      sizePctOfCash: 10,
    });
  });

  it("leaves a number word alone when it is not a percentage", () => {
    expect(plan("Buy ETH when RSI is below 30 in one sentence, stop 5%")).toMatchObject({ entry: RSI, exit: { stopLossPct: 5 } });
    const high = read("Buy ETH when it is 5% below a one-day high, stop 5%");
    expect(!high.ok && high.message).toContain('"when it is 5% below a one-day high"');
  });

  it("asks about a number it cannot read instead of dropping it", () => {
    const four = read("Buy ETH when RSI is below 30, stop at four");
    expect(four).toMatchObject({ ok: false, code: "rephrase" });
    expect(!four.ok && four.message).toContain('"stop at four"');
    const several = read("Buy ETH when RSI is below 30, take profit at several percent, stop 5%");
    expect(!several.ok && several.message).toContain('"take profit at several percent"');
    const days = read("Buy ETH when it drops 5% in the last two days, stop 5%");
    expect(!days.ok && days.message).toContain('"in the last two days"');
  });

  it("reads a size given as a share of the cash", () => {
    const size = (s: string) => readStrategy(`Buy ETH when RSI is below 30, ${s}, stop 5%`).sizePctOfCash;
    expect(size("use half my cash")).toBe(50);
    expect(size("use half of my capital per trade")).toBe(50);
    expect(size("use a quarter of my cash")).toBe(25);
    expect(size("use all my cash")).toBe(100);
    expect(size("invest all of my cash")).toBe(100);
    expect(size("all in")).toBe(100);
    expect(size("pakai setengah modal")).toBe(50);
    expect(size("pakai seperempat dari modal")).toBe(25);
    expect(planWide("Buy ETH when RSI is below 30, use half my cash, stop 5%")).toMatchObject({ entry: RSI, exit: { stopLossPct: 5 }, sizePctOfCash: 50 });
    // "all in an uptrend" is not a size.
    expect(readStrategy("Buy ETH when RSI is below 30 all in an uptrend, stop 5%")).toMatchObject({ sizePctOfCash: null, entry: [{ signal: "rsi" }, { signal: "trend_pct" }] });
  });

  it("a share over the wallet's cap is refused like any other size over it", () => {
    const half = read("Buy ETH when RSI is below 30, use half my cash, stop 5%");
    expect(half).toEqual({ ok: false, code: "size_over_cap", message: "Each trade would use 50% of cash, which is over your 35% cap. Lower the size and try again." });
    expect(read("Buy ETH when RSI is below 30, all in, stop 5%")).toMatchObject({ ok: false, code: "size_over_cap" });
  });

  it("asks about a share it does not know", () => {
    const third = read("Buy ETH when RSI is below 30, use a third of my cash, stop 5%");
    expect(!third.ok && third.message).toContain('"use a third of my cash"');
    const bare = read("Buy ETH when RSI is below 30, use half, stop 5%");
    expect(!bare.ok && bare.message).toContain('"use half"');
  });
});

describe("periods", () => {
  it("reads hari as days, jam as hours and minggu as weeks", () => {
    expect(plan("Beli ETH kalau harga turun 5% dalam 3 hari, stop loss 4%").entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 72 }]);
    expect(plan("Beli ETH kalau harga turun 5% dalam 24 jam, stop loss 4%").entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 24 }]);
    expect(plan("Beli ETH kalau harga turun 5% dalam 2 minggu, stop loss 4%").entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 336 }]);
    expect(plan("Beli ETH kalau harga 5% di bawah harga tertinggi 7 hari, stop loss 4%").entry).toEqual([{ signal: "from_high_pct", op: "<", value: -5, window: 168 }]);
    expect(plan("Beli BTC kalau harga turun 5% dalam 3 hari dan tren sedang naik, ambil untung 10%, batas rugi 5%").entry).toContainEqual({ signal: "change_pct", op: "<", value: -5, window: 72 });
    expect(plan("Beli ETH kalau RSI 14 jam di bawah 30, stop loss 4%").entry).toEqual([{ signal: "rsi", op: "<", value: 30, window: 14 }]);
  });

  it("reads short forms of hours, days and weeks", () => {
    expect(plan("Buy ETH on a 3% dip under its 20 h average, stop 4%").entry).toEqual([{ signal: "price_vs_sma_pct", op: "<", value: -3, window: 20 }]);
    expect(plan("Buy ETH when it drops 5% in 7d, stop 5%").entry).toEqual([{ signal: "change_pct", op: "<", value: -5, window: 168 }]);
    expect(plan("Buy ETH when it is 10% off its 2w high, trailing stop 5%").entry).toEqual([{ signal: "from_high_pct", op: "<", value: -10, window: 336 }]);
    expect(plan("Buy ETH when the 14h RSI is below 30, stop 5%").entry).toEqual([{ signal: "rsi", op: "<", value: 30, window: 14 }]);
  });
});

describe("what it refuses instead of misreading", () => {
  it("refuses selling in parts", () => {
    for (const s of [
      "Buy ETH when RSI is below 30, sell half at 8% profit and the rest at 12% profit, stop 5%",
      "Buy ETH when RSI is below 30, sell 50% at 8% profit, stop 5%",
      "Buy ETH when RSI is below 30, sell 50% of the position when RSI is above 70, stop 5%",
      "Buy ETH when RSI is below 30, scale out as it rises, stop 5%",
      "Buy ETH when RSI is below 30, take partial profits at 8%, stop 5%",
      "Buy ETH when RSI is below 30, sell some when RSI is above 70, stop 5%",
      "Beli ETH kalau RSI di bawah 30, jual sebagian di 8%, stop loss 4%",
      "Beli ETH kalau RSI di bawah 30, jual setengah di 8%, stop loss 4%",
    ]) {
      expect(read(s), s).toEqual({
        ok: false,
        code: "rephrase",
        message: "An agent sells its whole position at once, so selling in parts isn't available. Give one take profit and one stop. Try rephrasing.",
      });
    }
    // "the rest" of the cash is not a sale in parts.
    expect(plan("Buy ETH when RSI is below 30, use 25% per trade and keep the rest in cash, stop 5%")).toMatchObject({ entry: RSI, sizePctOfCash: 25 });
  });

  it("refuses a market it does not know instead of trading what it is paid with", () => {
    for (const [s, market] of [
      ["Buy ARB with ETH when RSI is below 30, stop 5%", "ARB"],
      ["buy arb with eth when rsi is below 30, stop 5%", "ARB"],
      ["Buy FOO with ETH when RSI is below 30, stop 5%", "FOO"],
      ["Buy $OP when RSI is below 30, stop 5%", "OP"],
      ["Long ARB when RSI is below 30, stop 5%", "ARB"],
      ["Beli DOT kalau RSI di bawah 30, stop loss 4%", "DOT"],
    ] as const) {
      const out = read(s);
      expect(out, s).toMatchObject({ ok: false, code: "unsupported_market" });
      expect(!out.ok && out.message, s).toBe(`${market} isn't available yet. Agents trade ETH and BTC for now.`);
    }
  });

  it("does not take an ordinary word after 'buy' for a market", () => {
    for (const s of [
      "Buy ETH when RSI is below 30, stop 5%",
      "Buy more ETH when RSI is below 30, stop 5%",
      "Buy when RSI is below 30 on ETH, stop 5%",
      "BUY WHEN RSI IS BELOW 30 ON ETH, STOP 5%",
      "BUY LOW ON ETH WHEN RSI IS BELOW 30, STOP 5%",
      "Buy ETH With USDG when RSI is below 30, stop 5%",
      "Buy RSI dips on ETH when RSI is below 30, stop 5%",
      "Buy BACK ETH when RSI is below 30, stop 5%",
      "Buy ETH/USDT when RSI is below 30, stop 5%",
      "Long ETH when RSI is below 30, stop 5%",
    ]) {
      expect(plan(s), s).toMatchObject({ markets: ["ETH"], entry: RSI, exit: { stopLossPct: 5 } });
    }
  });

  it("says which number is out of range", () => {
    const message = (s: string) => {
      const out = read(s);
      return out.ok ? "ok" : `${out.code}: ${out.message}`;
    };
    expect(message("Buy ETH when RSI is below 30, stop loss 400%")).toBe("rephrase: A stop loss must be more than 0% and less than 100%. You gave 400%.");
    expect(message("Buy ETH when RSI is below 30, stop 5%, use 150% per trade")).toBe("rephrase: Size per trade must be between 1% and 100% of cash. You gave 150%.");
    expect(message("Buy ETH when RSI is below 30, stop 5%, use 0.5% per trade")).toBe("rephrase: Size per trade must be between 1% and 100% of cash. You gave 0.5%.");
    expect(message("Buy ETH when RSI is below 30, take profit 0%, stop 5%")).toBe("rephrase: Take profit must be more than 0% and no more than 1,000%. You gave 0%.");
    expect(message("Buy ETH when RSI is below 30, trailing stop 100%")).toBe("rephrase: A trailing stop must be more than 0% and less than 100%. You gave 100%.");
    expect(message("Buy ETH when the 200-hour RSI is below 30, stop 5%")).toBe("rephrase: An RSI lookback must be between 2 and 100 hours. You gave 200.");
  });
});

describe("sentences that read correctly before still read the same", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["Buy ETH when RSI is below 30, take profit at 8%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 5 }, sizePctOfCash: 25 }],
    ["Buy ETH when RSI is below 30, TP 8%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 5 } }],
    ["Buy ETH when RSI is below 30, target 8%, stop 4%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, stop 4% and target 8%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, stop at 4%", { entry: RSI, exit: { stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, stop loss 4%", { entry: RSI, exit: { stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, cut losses at 4%", { entry: RSI, exit: { stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, stop 2,5%", { entry: RSI, exit: { stopLossPct: 2.5 } }],
    ["Buy ETH when RSI is below 30, exit at +8% or -4%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, sell when it is up 8% or down 4%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, sell at a 8% gain, stop out at 4%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30. Take profit: 8%. Stop loss: 4%. Size: 20%.", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 }, sizePctOfCash: 20 }],
    ["Buy ETH when RSI is below 30; TP=8%; SL=4%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 } }],
    ["Buy ETH when RSI is below 30, risking 20% per trade with a stop loss at -4% and a take profit at +8%", { entry: RSI, exit: { takeProfitPct: 8, stopLossPct: 4 }, sizePctOfCash: 20 }],
    ["Buy ETH when RSI of ETH is below 30, stop 5%", { markets: ["ETH"], entry: RSI, exit: { stopLossPct: 5 } }],
    ["Buy ETH when RSI(14) is below 30, stop 5%", { entry: [{ signal: "rsi", op: "<", value: 30, window: 14 }] }],
    [
      "Buy ETH when RSI is below 30 and the price is 3% below its 20-hour average, stop 4%",
      { entry: [{ signal: "price_vs_sma_pct", op: "<", value: -3, window: 20 }, { signal: "rsi", op: "<", value: 30 }], exit: { stopLossPct: 4 } },
    ],
    [
      "Buy ETH when volume is more than twice its 24-hour average and RSI is below 40, stop 5%, take profit 6%, 10% per trade",
      { entry: [{ signal: "rsi", op: "<", value: 40 }, { signal: "volume_ratio", op: ">", value: 2, window: 24 }], exit: { takeProfitPct: 6, stopLossPct: 5 }, sizePctOfCash: 10 },
    ],
    ["Every day buy 5% of my cash in bitcoin, with a 20% stop loss", { markets: ["BTC"], kind: "dca", entry: [], cadenceHours: 24, sizePctOfCash: 5, exit: { stopLossPct: 20 } }],
    ["Buy ETH when funding is negative, sell when funding is positive, stop 5%", { entry: [{ signal: "funding_rate", op: "<", value: 0 }], exit: { stopLossPct: 5, conditions: [{ signal: "funding_rate", op: ">", value: 0 }] } }],
  ];

  it.each(cases)("%s", (sentence, want) => {
    const p = plan(sentence);
    expect(p).toMatchObject(want);
    // No exit the sentence did not give, apart from the default stop.
    const exit = want.exit as Record<string, unknown> | undefined;
    if (exit) expect(Object.keys(p.exit).sort()).toEqual(Object.keys(exit).sort());
  });

  it("reads the sentence Agent Studio starts with", () => {
    expect(plan("Buy ETH when RSI drops below 30 in an uptrend, stay out when the market is stressed, take profit at 8% and stop at 4%, use 25% per trade")).toEqual({
      markets: ["ETH"],
      kind: "entry_exit",
      entry: [
        { signal: "rsi", op: "<", value: 30 },
        { signal: "trend_pct", op: ">", value: 0 },
      ],
      exit: { takeProfitPct: 8, stopLossPct: 4 },
      filters: ["stressed_regime"],
      sizePctOfCash: 25,
    });
  });
});
