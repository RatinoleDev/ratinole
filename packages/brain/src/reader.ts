/**
 * The built-in strategy reader. It turns common strategy sentences (English and Indonesian) into the same
 * draft the language model produces, using fixed rules, so Agent Studio works when no model is configured, when
 * the month's budget is spent, or when the model cannot be reached.
 *
 * It only translates. A number is used only where the sentence states it, and a part it cannot read (a rule
 * with a number or a comparison that matched nothing) makes it ask for a rephrase instead of dropping that part.
 * The draft then goes through the same checks as a model draft (`draftToPlan`).
 *
 * Two things keep a number with the rule it was written for. A phrase that was read is blanked out with a
 * character no pattern can cross, so a keyword is never joined to a number further along. And the forms that
 * name the rule first ("take profit 8%") are read before the forms that give the number first ("8% profit").
 */
import type { Draft } from "./schema";
import type { PlanDrafter } from "./intake";
import type { Filter, Op } from "./types";

type Cond = Draft["entry"][number];

const NUM = "(\\d+(?:\\.\\d+)?)";
const PCT = `${NUM}\\s*%`;
/**
 * A lookback such as "20-hour", "3 day", "20 jam", "3 hari": groups (count, unit). The unit must end at a word
 * boundary, so "3 hari" is three days and never "3 h" with "ari" left over.
 */
const WIN = "(\\d+)\\s*-?\\s*(hours?|hrs?|hr|h|jam|days?|d|hari|weeks?|wks?|w|minggu)\\b";
const BELOW = "(?:below|under|beneath|less than|lower than|<|di\\s*bawah|kurang dari|lebih rendah dari)";
const ABOVE = "(?:above|over|greater than|more than|higher than|exceeds|exceed|>|di\\s*atas|lebih dari|lebih tinggi dari|melebihi)";
const AVG = "\\b(?:moving average|average|mean|sma|ma|rata-rata|rata rata|rerata)\\b";
/** "its 20-hour average" or "rata-rata 20 jam": the window may come before or after. Four groups. */
const AVGP = `(?:(?:its|the|it's|a|an)\\s+)?(?:${WIN}\\s+)?(?:simple\\s+|short\\s+|long\\s+|hourly\\s+)?${AVG}(?:\\s+${WIN})?`;
/** Optional lead-in words in front of a percentage, consumed with it. */
const LEAD = "(?:(?:the\\s+)?(?:price|harga|it)\\s+)?(?:(?:is|trades|sits|drops?|falls?|dips?|turun|jatuh|berada|ada)\\s+)?(?:(?:a|an)\\s+)?";
const SPAN = "(?:\\s+(?:in|over|within|during|dalam|selama)\\s+(?:the\\s+)?(?:last\\s+|past\\s+)?(?:" + WIN + "|(a day|one day|sehari)|(a week|one week|seminggu)|(an hour|one hour|sejam)))?";
/** "from the peak", "below its high": the high a trailing stop follows. No groups. */
const HIGH = "(?:high|highs|peak|top|harga tertinggi|tertinggi|puncak)";
const FROM_HIGH = `(?:\\s*(?:from|below|off|under|down from|dari|di\\s*bawah)\\s+(?:its\\s+|the\\s+|it's\\s+)?(?:recent\\s+|highest\\s+|last\\s+)?${HIGH}(?:\\s+since\\s+(?:buying|entry|the buy))?)`;
/** "that sells if it drops": words after a trailing stop that only say what one does. No groups. */
const TRAIL_TAIL = "(?:\\s+(?:that|which)\\s+(?:sells?|exits?|closes?|triggers?)(?:\\s+(?:if|when|once|it|the|price|drops?|falls?|dips?|pulls?|back|goes|down|turns?|reverses?))*)?";
/** "below my entry", "from the buy price": measured from where the position was bought. One group. */
const FROM_ENTRY = "(\\s+(?:below|under|from|above|over|dari|di\\s*bawah|di\\s*atas)\\s+(?:my\\s+|the\\s+|its\\s+)?(?:entry price|entry|buy price|purchase price|cost basis|cost|harga beli))?";

function hours(count: string | undefined, unit: string | undefined): number | null {
  if (!count || !unit) return null;
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return null;
  const u = unit.toLowerCase();
  if (/^(d|hari)/.test(u)) return n * 24;
  if (/^(w|minggu)/.test(u)) return n * 168;
  return n;
}

const TICKERS: [RegExp, string][] = [
  [/\b(?:w?eth|ether|ethereum)\b(?:\s*[/-]\s*usd[tgc]?)?/, "ETH"],
  [/\b(?:w?btc|xbt|bitcoin)\b(?:\s*[/-]\s*usd[tgc]?)?/, "BTC"],
  [/\b(?:nvda|nvidia)\b/, "NVDA"],
  [/\b(?:tsla|tesla)\b/, "TSLA"],
  [/\b(?:aapl|apple)\b/, "AAPL"],
  [/\b(?:msft|microsoft)\b/, "MSFT"],
  [/\b(?:amzn|amazon)\b/, "AMZN"],
  [/\b(?:googl|goog|google)\b/, "GOOGL"],
  [/\bqqq\b/, "QQQ"],
  [/\bsolana\b/, "SOL"],
  [/\b(?:doge|dogecoin)\b/, "DOGE"],
  [/\bxrp\b/, "XRP"],
  [/\bbnb\b/, "BNB"],
  [/\bcardano\b/, "ADA"],
  [/\bavax\b/, "AVAX"],
  [/\bchainlink\b/, "LINK"],
  [/\bpepe\b/, "PEPE"],
  [/\bshib\b/, "SHIB"],
  [/\b(?:arb|arbitrum)\b/, "ARB"],
  [/\b(?:matic|polygon)\b/, "MATIC"],
  [/\b(?:ltc|litecoin)\b/, "LTC"],
  [/\buniswap\b/, "UNI"],
  [/\baave\b/, "AAVE"],
  [/\b(?:trx|tron)\b/, "TRX"],
  [/\bpolkadot\b/, "DOT"],
  [/\btoncoin\b/, "TON"],
];
/** Tickers that are also everyday words: read only when written in capitals. */
const UPPER_ONLY = ["META", "SPY", "COIN", "SOL", "ADA", "LINK", "HYPE"];
/** Capitals right after "buy" that are words or indicator names, not a market. */
const NOT_A_TICKER = new Set(
  (
    "WHEN WHENEVER IF THE A AN IT ON AT IN OUT UP DOWN AND OR ONLY ONCE MORE SOME ANY EVERY EACH WITH AS AFTER BEFORE DIP DIPS LOW HIGH ALL MY ME FOR TO NOW " +
    "BACK AGAIN BIG SMALL EARLY LATE CHEAP FAST SLOW NOTHING EVERYTHING CRYPTO COINS TOKENS STOCKS SPOT RSI DCA USD SMA MA EMA MACD TP SL ATH ATL"
  ).split(" "),
);

/** "skip if there is", "stand aside if the market is", "avoid trading around": consumed with the reason. */
const AVOID =
  "(?:(?:but\\s+)?(?:skip|avoid|stand aside|sit out|stay out|pause|hindari|lewati)\\s+(?:it\\s+)?(?:(?:if|when|on|during|around|in|saat|kalau|jika|ketika)\\s+)?(?:trading\\s+)?(?:(?:around|on|during)\\s+)?" +
  "(?:(?:there\\s+is|there's|there\\s+are|the\\s+market\\s+is|markets?\\s+(?:is|are)|it\\s+is|ada|pasar(?:\\s+sedang)?)\\s+)?)?";
const FILTERS: [RegExp, Filter][] = [
  [new RegExp(`${AVOID}(?:any\\s+)?\\b(?:bad|negative|bearish)\\s+(?:news|headlines?)\\b|${AVOID}\\bberita\\s+(?:buruk|negatif|jelek)\\b`), "negative_news"],
  [new RegExp(`${AVOID}(?:the\\s+)?\\bearnings?(?:\\s+(?:week|season|reports?|days?))?\\b`), "earnings_week"],
  [new RegExp(`${AVOID}(?:a\\s+)?\\b(?:crash(?:es|ing)?|panic(?:king)?|stressed|under stress|market stress|melting down|jatuh tajam|panik)\\b`), "stressed_regime"],
  [
    new RegExp(
      `${AVOID}(?:the\\s+)?\\b(?:cpi|fomc|fed|nfp|jobs report|payrolls|macro|economic (?:releases?|data|prints?))\\b` +
        "(?:\\s+(?:and|or|dan|atau)\\s+(?:the\\s+)?(?:cpi|fomc|fed|nfp|jobs report|payrolls))*(?:\\s+(?:announcements?|decisions?|meetings?|prints?|releases?|data|days?|news))?",
    ),
    "macro_print",
  ],
];

/**
 * Leftover words that mean a rule was not read. A leftover number means the same, whether it is written in
 * digits, in words ("stop at four") or as a share ("use half").
 */
const UNREAD = new Set(
  (
    "above below over under beneath crosses cross crossing crossed breaks break breakout breakdown flips flip spike spikes " +
    "surge surges exceeds greater less higher lower atas bawah melewati menembus macd ema bollinger band bands stochastic " +
    "vwap fibonacci fib support resistance ichimoku atr obv adx candle candles pattern golden death divergence sentiment " +
    "twitter tweet tweets moon " +
    "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen " +
    "twenty thirty forty fifty sixty seventy eighty ninety hundred half third quarter twice double triple percent persen pct " +
    "dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas belas puluh seratus setengah separuh seperempat"
  ).split(" "),
);

/** Selling a position in parts. An agent sells all of it at once, so this is refused, never read as one target. */
const IN_PARTS = new RegExp(
  "\\b(?:sell|sells|selling|exit|close|trim|unload|jual|menjual)\\s+(?:off\\s+)?(?:(?:a|one)\\s+)?(?:half|third|quarter|part|portion|some|sebagian|setengah|separuh)\\b" +
    `|\\b(?:sell|sells|exit|close|jual)\\s+(?:off\\s+)?${NUM}\\s*%\\s+(?:of\\s+(?:it|the|my)\\b|at\\b|when\\b|if\\b|once\\b|di\\b|saat\\b|kalau\\b|jika\\b)` +
    "|\\btake\\s+profits?\\s+on\\s+(?:half|part|some)\\b|\\b(?:the|and)\\s+rest\\s+(?:at|when|if|once|later|after)\\b|\\bsell\\s+the\\s+rest\\b|\\bsisanya\\b" +
    "|\\bscal(?:e|es|ing)[- ]out\\b|\\bpartial(?:ly)?\\b|\\bin\\s+(?:parts|tranches|stages)\\b|\\bsebagian\\b|\\bbertahap\\b",
);

/**
 * "sell when", "sell everything if", "stop out once", "close the position when": where a sell rule starts.
 * "close" after "the", "at" or "daily" is the candle's close, not a sell.
 */
const WHEN = "(?:when|whenever|if|once|after|as soon as|saat|kalau|ketika|jika|bila|begitu)";
const SELL = "(?:sell|sells|selling|exit|exits|(?<!\\b(?:the|a|daily|hourly|weekly|candle|at|on|each|every)\\s)closes?|stop\\s+out|stops\\s+out|stop|stops|get\\s+out|bail\\s+out|take\\s+profits?|cut\\s+(?:the\\s+|my\\s+)?loss(?:es)?|jual|keluar|tutup|ambil\\s+untung)";
const WHAT =
  "(?:it\\s+all|it|out|everything|all\\s+of\\s+it|all(?:\\s+(?:of\\s+)?(?:my|the)\\s+\\w+)?|(?:the|my)\\s+(?:whole\\s+|entire\\s+|full\\s+)?(?:position|trade|holdings?|bag|coins?|tokens?|funds)|(?:the\\s+|my\\s+)?(?:w?eth|ether|ethereum|w?btc|bitcoin)|semua|semuanya|seluruhnya|posisi|posisinya)";
const SELL_CLAUSE = new RegExp(
  `\\b${SELL}\\s+(?:${WHAT}\\s+)?${WHEN}\\b` +
    // "hold until RSI is above 70": what ends the holding is the sell rule.
    `|\\b(?:hold|holds|holding|keep|keeps|tahan)\\s+(?:${WHAT}\\s+)?(?:until|till|sampai|hingga)\\b` +
    // "sell at 10% profit or when RSI is above 70": the second half is still the sell rule.
    `|\\b(?:sell|exit|close|jual|keluar|take\\s+profits?)\\s+(?:${WHAT}\\s+)?(?:at|di|for|with)\\s(?:(?!\\b(?:buy|beli|enter)\\b)(?:[^,;.]|\\.(?=\\d))){0,30}?\\b(?:or|and|atau|dan)\\s+(?:also\\s+)?${WHEN}\\b`,
  "g",
);

/**
 * Text where each consumed match is blanked out, so one phrase is never read twice. The blank is a run of ";",
 * which no pattern here can cross: a keyword left on one side is never joined to a number on the other. Names
 * (markets, the RSI window) are blanked with spaces instead, because a rule may be written around them
 * ("RSI of ETH is below 30").
 */
class Scan {
  constructor(public text: string) {}
  blank(at: number, length: number, fill = ";") {
    this.text = this.text.slice(0, at) + fill.repeat(length) + this.text.slice(at + length);
  }
  take(re: RegExp, fill = ";"): RegExpExecArray | null {
    const m = re.exec(this.text);
    if (!m || m[0].trim() === "") return null;
    this.blank(m.index, m[0].length, fill);
    return m;
  }
  each(re: RegExp, fn: (m: RegExpExecArray) => void, fill = ";") {
    for (let i = 0; i < 12; i++) {
      const m = this.take(re, fill);
      if (!m) return;
      fn(m);
    }
  }
}

const EN_UNIT = "one|two|three|four|five|six|seven|eight|nine";
const EN_TEEN = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const EN_TEN = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const ID_UNIT = "satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan";
const WORD_VALUE: Record<string, number> = Object.fromEntries([
  ...`zero|${EN_UNIT}|${EN_TEEN}`.split("|").map((w, i) => [w, i] as const),
  ...EN_TEN.split("|").map((w, i) => [w, 20 + 10 * i] as const),
  ...`nol|${ID_UNIT}|sepuluh|sebelas`.split("|").map((w, i) => [w, i] as const),
]);
/** Only in front of a percent sign or the word: "eight percent" is a number, "one sentence" is not. */
const AS_PERCENT = "\\s*(?=%|(?:percent|per cent|persen|pct)\\b)";
const EN_WORDS = new RegExp(`\\b(?:(${EN_TEN})(?:[\\s-]+(${EN_UNIT}))?|(zero|${EN_UNIT}|${EN_TEEN})|((?:a|one)\\s+hundred))(?:\\s+point\\s+(zero|${EN_UNIT}))?${AS_PERCENT}`, "g");
const ID_WORDS = new RegExp(`\\b(?:(${ID_UNIT})\\s+puluh(?:\\s+(${ID_UNIT}))?|(${ID_UNIT})\\s+belas|(nol|${ID_UNIT}|sepuluh|sebelas)|(seratus))(?:\\s+koma\\s+(nol|${ID_UNIT}))?${AS_PERCENT}`, "g");

/** "eight percent" to "8 percent", "twenty-five percent" to "25 percent", "lima belas persen" to "15 persen". */
function wordsToDigits(text: string): string {
  const v = (w: string | undefined) => (w ? (WORD_VALUE[w] ?? 0) : 0);
  const frac = (w: string | undefined) => (w ? `.${v(w)}` : "");
  return text
    .replace(EN_WORDS, (_m, ten?: string, unit?: string, small?: string, hundred?: string, point?: string) => `${hundred ? 100 : ten ? v(ten) + v(unit) : v(small)}${frac(point)}`)
    .replace(ID_WORDS, (_m, tens?: string, unit?: string, teen?: string, small?: string, hundred?: string, point?: string) => `${hundred ? 100 : tens ? v(tens) * 10 + v(unit) : teen ? 10 + v(teen) : v(small)}${frac(point)}`);
}

function normalise(sentence: string): string {
  const plain = sentence
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/×/g, "x")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")
    .replace(/\s+/g, " ");
  return wordsToDigits(plain)
    .replace(/(\d)\s*(?:percent|per cent|persen|pct)\b/g, "$1%")
    .replace(/\s+/g, " ")
    .trim();
}

const EMPTY: Draft = {
  understood: false,
  problem: null,
  markets: [],
  kind: "entry_exit",
  entry: [],
  exit: { takeProfitPct: null, stopLossPct: null, trailingStopPct: null, conditions: [] },
  filters: [],
  sizePctOfCash: null,
  weights: [],
  cadenceHours: null,
};

const refuse = (problem: string | null): Draft => ({ ...EMPTY, exit: { ...EMPTY.exit, conditions: [] }, problem });

type Level = "size" | "tp" | "sl" | "trail";
const LEVEL_NAME: Record<Level, string> = { size: "size per trade", tp: "take profit", sl: "stop loss", trail: "trailing stop" };

/** Sentence to draft. Pure and deterministic. */
export function readStrategy(sentence: string): Draft {
  const full = normalise(sentence);
  const s = new Scan(full);

  if (/\bshort(?:ing|s)?\s+(?:eth|ether|ethereum|btc|bitcoin|it|the market|sell|selling|positions?)\b|\bgo(?:ing)?\s+short\b|\bleveraged?\b|\bmargin\b|\b\d+\s*x\s+(?:long|short|leverage)\b/.test(full)) {
    return refuse("Agents buy and sell spot only: short selling and leverage aren't available");
  }
  if (IN_PARTS.test(full)) {
    return refuse("An agent sells its whole position at once, so selling in parts isn't available. Give one take profit and one stop");
  }

  // Markets.
  const found: { at: number; ticker: string }[] = [];
  for (const [re, ticker] of TICKERS) s.each(re, (m) => found.push({ at: m.index, ticker }), " ");
  for (const ticker of UPPER_ONLY) {
    if (new RegExp(`\\b${ticker}\\b`).test(sentence)) s.each(new RegExp(`\\b${ticker.toLowerCase()}\\b`), (m) => found.push({ at: m.index, ticker }), " ");
  }
  // A ticker in capitals right after "buy" that is none of the above ("Buy FOO with ETH"): it is the market
  // the sentence asks for, so it is named and the plan is refused for it, instead of trading what it is paid with.
  // A sentence typed all in capitals says nothing this way.
  if (/[a-z]/.test(sentence)) {
    for (const m of sentence.matchAll(/\b(?:buy|buys|buying|beli|membeli|long)\s+(?:some\s+|more\s+|the\s+)?\$?([a-z][a-z0-9]{1,9})\b/gi)) {
      const token = m[1]!;
      const lower = token.toLowerCase();
      if (token !== token.toUpperCase() || NOT_A_TICKER.has(token) || UPPER_ONLY.includes(token) || TICKERS.some(([re]) => re.test(lower))) continue;
      found.push({ at: m.index, ticker: token });
      s.each(new RegExp(`\\b${lower}\\b`), () => undefined, " ");
    }
  }
  const markets = [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.ticker))];

  const rebalance = /\brebalanc|\bkeep\s+\d+\s*%\s+\w+\s+and\s+\d+\s*%/.test(full);
  const grid = /\bgrid\b/.test(full);
  if (rebalance || grid) {
    return { ...EMPTY, understood: true, markets, kind: rebalance ? "rebalance" : "grid", exit: { ...EMPTY.exit, conditions: [] } };
  }

  // Where the sell rules sit: conditions found there are exits, the rest are entries. A rule runs to the end
  // of its part of the sentence, or to the next "buy".
  const clauses = [...full.matchAll(SELL_CLAUSE)].map((m) => {
    const stop = full.slice(m.index).search(/[,;]|\.(?!\d)|\b(?:buy|beli|enter)\b/);
    return { from: m.index, to: stop === -1 ? full.length : m.index + stop };
  });
  const inSell = (at: number) => clauses.some((c) => at >= c.from && at < c.to);
  /** The text once the markets are taken out: a sell rule that still reads the same at the end was not read. */
  const named = s.text;

  // Reasons to stand aside.
  const filters: Filter[] = [];
  for (const [re, f] of FILTERS) s.each(re, () => void (filters.includes(f) || filters.push(f)));

  const got: Record<Level | "cadence", number | null> = { size: null, cadence: null, tp: null, sl: null, trail: null };
  /** Two different numbers for one rule: neither is picked for the user. */
  let clash: string | null = null;
  const set = (level: Level, value: number) => {
    if (got[level] == null) got[level] = value;
    else if (got[level] !== value) clash ??= `Two different ${LEVEL_NAME[level]} numbers were given, ${got[level]}% and ${value}%. Keep one`;
  };
  const level = (name: Level, re: RegExp) => s.each(re, (m) => set(name, Number(m[1])));

  // Exits that name the rule first. They are read before a size and before the number-first forms, so that
  // "stop loss 2% per trade" is a stop and "take profit 8% trailing stop 3%" keeps each number with its rule.
  level("trail", new RegExp(`trailing\\s+stop(?:[- ]?loss)?\\s+(?:that\\s+|which\\s+|to\\s+)?(?:sells?|exits?|closes?|triggers?|gets?\\s+out)\\b[^,.;%\\d]{0,30}?${PCT}${FROM_HIGH}?`));
  level("trail", new RegExp(`trailing\\s+stop(?:[- ]?loss)?\\s*(?:of|at|:|=|is|set\\s+at|by)?\\s*${PCT}${FROM_HIGH}?${TRAIL_TAIL}`));
  level("trail", new RegExp(`\\btrail(?:ing)?\\s+(?:it\\s+)?(?:by\\s+|at\\s+)?${PCT}${FROM_HIGH}?${TRAIL_TAIL}`));
  s.each(new RegExp(`(?:exit|sell|close|out|jual)\\s+at\\s+(?:plus\\s*|\\+\\s*)${PCT}\\s+(?:or|and|atau|dan)\\s+(?:minus\\s*|-\\s*)${PCT}`), (m) => {
    set("tp", Number(m[1]));
    set("sl", Number(m[2]));
  });
  level("tp", new RegExp(`(?:take|taking)[- ]?profits?\\s*(?:at|of|is|:|=|di|pada)?\\s*\\+?${PCT}`));
  level("tp", new RegExp(`ambil\\s+(?:untung|profit|keuntungan)\\s*(?:di|pada|saat)?\\s*\\+?${PCT}`));
  level("tp", new RegExp(`\\btp\\s*(?:at|of|is|:|=|di)?\\s*\\+?${PCT}`));
  level("tp", new RegExp(`(?:profit\\s+)?target\\s*(?:at|of|is|:|=)?\\s*\\+?${PCT}`));
  level("sl", new RegExp(`stop[- ]?loss(?:es)?\\s*(?:at|of|is|:|=|di|pada)?\\s*-?${PCT}`));
  level("sl", new RegExp(`\\bsl\\s*(?:at|of|is|:|=|di)?\\s*-?${PCT}`));
  level("sl", new RegExp(`(?:cut\\s+loss(?:es)?|cutloss|batas\\s+rugi)\\s*(?:at|di|pada)?\\s*${PCT}`));
  level("sl", new RegExp(`\\bstop\\s*(?:out\\s+)?(?:at|of|is|:|=|di)?\\s*-?${PCT}`));

  // Size per trade.
  const CASH_WORD = "(?:cash|capital|portfolio|balance|funds|account|bankroll|money)";
  const KAS = "(?:kas|modal|saldo|dana|uang)";
  const CASH = `(?:of\\s+(?:my\\s+|the\\s+)?${CASH_WORD}|dari\\s+${KAS})`;
  const USE = "(?:use|using|risk|risking|with|allocate|invest|buy|pakai|gunakan|memakai|menggunakan|beli)";
  const EACH = "(?:per|each|every|a|for each|setiap|tiap)\\s*(?:trade|position|purchase|buy|entry|order|transaksi|posisi|pembelian)";
  level("size", new RegExp(`(?:${USE}\\s+)?${PCT}\\s*(?:${CASH}\\s*)?${EACH}`));
  level("size", new RegExp(`(?:${USE}\\s+)?${PCT}\\s*${CASH}`));
  level("size", new RegExp(`(?:position\\s+)?size\\s*(?:of|is|:|=)?\\s*${PCT}`));
  // A size in words: "half my cash", "a quarter of my cash", "all my cash", "all in".
  const share = (value: number, en: string, id: string) =>
    s.each(new RegExp(`(?<!\\b(?:sell|exit|close|jual)\\s)(?:${USE}\\s+)?(?:${en}\\s+(?:of\\s+)?(?:my\\s+|the\\s+)?${CASH_WORD}|${id}\\s+(?:dari\\s+)?${KAS})(?:\\s+${EACH})?`), () => set("size", value));
  share(50, "(?:(?:a|one)\\s+)?half", "(?:setengah|separuh)");
  share(25, "(?:a|one)\\s+quarter", "seperempat");
  share(100, "all", "(?:semua|seluruh)");
  s.each(/\b(?:go(?:ing)?\s+)?all[- ]in\b(?!\s+(?:a|an|one|the|all)\b)/, () => set("size", 100));

  // How often (a schedule with no buy rule is a "dca" plan).
  s.each(/\b(?:every|each|tiap|setiap)\s+(?:(\d+)\s*)?(hour|day|week|month|jam|hari|minggu|bulan)s?\b|\b(hourly|daily|weekly|monthly|harian|mingguan|bulanan)\b/, (m) => {
    const unit = (m[2] ?? m[3] ?? "").toLowerCase();
    const per = /^(hour|jam)/.test(unit) ? 1 : /^(da|hari)/.test(unit) ? 24 : /^(week|minggu)/.test(unit) ? 168 : 720;
    got.cadence ??= per * (m[1] ? Number(m[1]) : 1);
  });

  // Exits that give the number first: "a 5% trailing stop", "10% profit", "a 4% stop".
  level("trail", new RegExp(`${PCT}\\s*trailing(?:\\s+stop(?:[- ]?loss)?)?${FROM_HIGH}?${TRAIL_TAIL}`));
  level("tp", new RegExp(`(?:(?:sell|exit|close|jual)\\s+(?:it\\s+)?(?:at|di|for\\s+a|with\\s+a)\\s+)?\\+?${PCT}\\s*(?:profit|gain|untung|keuntungan)`));
  level("tp", new RegExp(`\\+?${PCT}\\s*(?:take[- ]?profits?|tp\\b|target)`));
  level("sl", new RegExp(`(?:with\\s+)?(?:a\\s+|an\\s+)?${PCT}\\s*(?:stop(?:[- ]?loss)?|sl)\\b`));

  // Conditions.
  const entry: Cond[] = [];
  const exits: Cond[] = [];
  const add = (m: RegExpExecArray, c: Cond) => void (inSell(m.index) ? exits : entry).push(c);
  const cond = (signal: string, op: Op, value: number, window: number | null = null): Cond => ({ signal, op, value, window });
  const dir = (word: string): "up" | "down" => (/below|under|beneath|less|lower|<|bawah|kurang|rendah/.test(word) ? "down" : "up");

  // Distance from a recent high: "5% below its 3-day high". In a sell rule with no period it is the high since
  // buying, which is a trailing stop: "sell if it drops 5% from the peak".
  s.each(new RegExp(`${LEAD}${PCT}\\s*(?:${BELOW}|off|from|down from|dari)\\s+(?:its|the|it's)?\\s*(?:${WIN}\\s+)?(?:recent\\s+)?${HIGH}(?:\\s+${WIN})?`), (m) => {
    const w = hours(m[2], m[3]) ?? hours(m[4], m[5]);
    if (inSell(m.index) && w == null) set("trail", Number(m[1]));
    else add(m, cond("from_high_pct", "<", -Number(m[1]), w));
  });
  // Price crossing its average.
  s.each(new RegExp(`(?:(?:the\\s+)?(?:price|harga|it)\\s+)?(?:cross\\w*|menembus|melewati)\\s+(?:back\\s+|kembali\\s+|ke\\s+)?(above|over|below|under|atas|bawah)\\s+${AVGP}`), (m) =>
    add(m, cond("price_vs_sma_pct", dir(m[1]!) === "up" ? "crosses_above" : "crosses_below", 0, hours(m[2], m[3]) ?? hours(m[4], m[5]))),
  );
  // A percentage under or over the average: "a 3% dip under its 20-hour average".
  s.each(new RegExp(`${LEAD}${PCT}\\s*(?:dip\\s+|pullback\\s+)?(${BELOW}|${ABOVE})\\s+${AVGP}`), (m) =>
    add(m, cond("price_vs_sma_pct", dir(m[2]!) === "up" ? ">" : "<", dir(m[2]!) === "up" ? Number(m[1]) : -Number(m[1]), hours(m[3], m[4]) ?? hours(m[5], m[6]))),
  );
  s.each(new RegExp(`(?:the\\s+)?(?:price|harga)\\s+(?:is\\s+|trades\\s+|berada\\s+)?(${BELOW}|${ABOVE})\\s+${AVGP}`), (m) =>
    add(m, cond("price_vs_sma_pct", dir(m[1]!) === "up" ? ">" : "<", 0, hours(m[2], m[3]) ?? hours(m[4], m[5]))),
  );
  s.each(new RegExp(`(?:on\\s+)?(?:a\\s+|an\\s+)?${PCT}\\s*(?:dip|pullback|koreksi)\\b|\\b(?:dips?|pullback|koreksi)\\s+(?:of\\s+|by\\s+|sebesar\\s+)?${PCT}`), (m) =>
    add(m, cond("price_vs_sma_pct", "<", -Number(m[1] ?? m[2]))),
  );

  // RSI. Its window is part of its name ("the 14-hour RSI", "RSI(14)", "RSI 14 jam"), so the rule is read around it.
  let rsiWindow: number | null = null;
  s.each(/(\d+)\s*-?\s*(?:hours?|hrs?|h|periods?|jam)\s+(?=rsi\b)|(?<=\brsi)\s*\(\s*(\d+)\s*\)|(?<=\brsi)\s+(\d+)\s*-?\s*(?:hours?|hrs?|h|periods?|jam|periode)\b/, (m) => void (rsiWindow ??= Number(m[1] ?? m[2] ?? m[3])), " ");
  const GAP = "[^,.;%\\d]{0,30}?";
  s.each(new RegExp(`\\brsi\\b${GAP}\\b(?:cross\\w*|back|kembali|menembus|melewati)\\b[^,.;%\\d]{0,20}?(${ABOVE}|${BELOW}|atas|bawah)\\s*(?:the\\s+)?${NUM}`), (m) =>
    add(m, cond("rsi", dir(m[1]!) === "up" ? "crosses_above" : "crosses_below", Number(m[2]), rsiWindow)),
  );
  s.each(new RegExp(`\\brsi\\b${GAP}(${BELOW}|${ABOVE})\\s*(?:the\\s+)?${NUM}`), (m) => add(m, cond("rsi", dir(m[1]!) === "up" ? ">" : "<", Number(m[2]), rsiWindow)));
  s.each(/\boversold\b|\bjenuh jual\b/, (m) => add(m, cond("rsi", "<", 30, rsiWindow)));
  s.each(/\boverbought\b|\bjenuh beli\b/, (m) => add(m, cond("rsi", ">", 70, rsiWindow)));

  // Trend.
  s.each(new RegExp(`(?:in\\s+an?\\s+|during\\s+an?\\s+)?\\buptrend\\b|(?:while\\s+|is\\s+)?above\\s+(?:its|the)\\s+(?:long[- ]term\\s+|long\\s+)?trend\\b|(?:the\\s+)?(?:${WIN}\\s+)?(?:long[- ]term\\s+|long\\s+)?\\btrend\\s+(?:is\\s+)?(?:rising|up|positive|bullish|going up)\\b|\\btren\\s+(?:sedang\\s+|lagi\\s+)?naik\\b`), (m) =>
    add(m, cond("trend_pct", ">", 0, hours(m[1], m[2]))),
  );
  s.each(new RegExp(`(?:in\\s+an?\\s+)?\\bdowntrend\\b|(?:while\\s+|is\\s+)?below\\s+(?:its|the)\\s+(?:long[- ]term\\s+|long\\s+)?trend\\b|(?:the\\s+)?(?:${WIN}\\s+)?(?:long[- ]term\\s+|long\\s+)?\\btrend\\s+(?:is\\s+)?(?:falling|down|negative|bearish|going down)\\b|\\btren\\s+(?:sedang\\s+|lagi\\s+)?turun\\b`), (m) =>
    add(m, cond("trend_pct", "<", 0, hours(m[1], m[2]))),
  );

  // Volume against its average: "more than twice its 24-hour average".
  s.each(new RegExp(`\\bvolume\\b[^,.;%\\d]{0,25}?(?:(twice|double|triple)|${NUM}\\s*(?:x|times|kali)\\b)(?:\\s+(?:of\\s+|than\\s+|dari\\s+)?(?:${AVGP}|normal|usual|biasanya\\b))?`), (m) => {
    const k = m[1] ? (m[1] === "triple" ? 3 : 2) : Number(m[2]);
    add(m, cond("volume_ratio", ">", k, hours(m[3], m[4]) ?? hours(m[5], m[6])));
  });
  // Volatility and funding.
  s.each(new RegExp(`\\b(?:volatility|volatilitas)\\b[^,.;%\\d]{0,20}?(${BELOW}|${ABOVE})\\s*${PCT}`), (m) => add(m, cond("volatility_pct", dir(m[1]!) === "up" ? ">" : "<", Number(m[2]))));
  s.each(/\bfunding(?:\s+rate)?\b[^,.;%\d]{0,15}?\b(negative|positive|negatif|positif)\b|\b(negative|positive)\s+funding(?:\s+rate)?\b/, (m) =>
    add(m, cond("funding_rate", /^neg/.test(m[1] ?? m[2] ?? "") ? "<" : ">", 0)),
  );
  s.each(new RegExp(`\\bfunding(?:\\s+rate)?\\b[^,.;%\\d]{0,15}?(${BELOW}|${ABOVE})\\s*(-?\\d+(?:\\.\\d+)?)\\s*%`), (m) => add(m, cond("funding_rate", dir(m[1]!) === "up" ? ">" : "<", Number(m[2]))));

  // Price change over a period. With no period, inside a sell rule or measured from the entry price, it is the
  // stop (a fall) or the target (a rise).
  const span = (m: RegExpExecArray, i: number) => hours(m[i], m[i + 1]) ?? (m[i + 2] ? 24 : m[i + 3] ? 168 : m[i + 4] ? 1 : null);
  const MORE = "(?:by\\s+|more than\\s+|over\\s+|at least\\s+|lebih dari\\s+|sebesar\\s+)?";
  s.each(new RegExp(`(?:(?:the\\s+)?(?:price|harga|it)\\s+)?\\b(?:falls?|drops?|declines?|loses|is down|down|sinks?|slides?|tumbles?|turun|jatuh|anjlok)\\s+${MORE}${PCT}${SPAN}${FROM_ENTRY}`), (m) => {
    const w = span(m, 2);
    if (w == null && (m[7] || inSell(m.index))) set("sl", Number(m[1]));
    else add(m, cond("change_pct", "<", -Number(m[1]), w));
  });
  s.each(new RegExp(`(?:(?:the\\s+)?(?:price|harga|it)\\s+)?\\b(?:rises?|gains?|jumps?|pumps?|rallies|rally|climbs?|is up|up|naik|melonjak)\\s+${MORE}${PCT}${SPAN}${FROM_ENTRY}`), (m) => {
    const w = span(m, 2);
    if (w == null && (m[7] || inSell(m.index))) set("tp", Number(m[1]));
    else add(m, cond("change_pct", ">", Number(m[1]), w));
  });

  // Data that is not collected yet: named so the refusal can say exactly what is missing.
  s.each(/\b(?:follow(?:ing)?\s+)?(?:whales?|large wallets?|big wallets?|smart money|paus)\b(?:\s+(?:are\s+)?(?:buying|accumulating|membeli))?/, (m) => add(m, cond("wallet_net_flow_usd", ">", 0)));
  s.each(/\bliquidations?\b(?:\s+(?:spike|spikes|surge|surges|rise|rises|jump|jumps|melonjak))?/, (m) => add(m, cond("liquidations_usd", ">", 0)));
  s.each(/\bopen interest\b(?:\s+(?:is\s+)?(?:rising|rises|up|growing|naik))?/, (m) => add(m, cond("open_interest_change_pct", ">", 0)));

  // "sell when it crosses below it": the same signal as the buy rule, the other way.
  const last = entry[entry.length - 1];
  if (exits.length === 0 && last) {
    for (const c of clauses) {
      const m = /\bcross\w*\s+(?:back\s+)?(above|over|below|under)(?:\s+(?:it|that|the same|again))?/.exec(s.text.slice(c.from, c.to));
      if (!m) continue;
      s.blank(c.from + m.index, m[0].length);
      exits.push({ ...last, op: dir(m[1]!) === "up" ? "crosses_above" : "crosses_below" });
      break;
    }
  }

  const readAnything = entry.length + exits.length > 0 || got.tp != null || got.sl != null || got.trail != null || got.cadence != null || got.size != null;
  if (!markets.length && !readAnything) return refuse(null);

  // Anything that still looks like a rule was not read: say so instead of dropping it.
  const CAN_READ = "The built-in reader understands RSI, a dip under an average, the trend, a price change over a period, distance from a recent high, volume and funding";
  const unread = s.text
    .split(/\s{2,}|[,;:()]|\.(?!\d)/)
    .map((part) => part.trim())
    .find((part) => part.split(/[^a-z0-9%.<>-]+/).some((w) => /\d/.test(w) || /[<>%]/.test(w) || w.split("-").some((x) => UNREAD.has(x))));
  if (unread) return refuse(`I couldn't read this part: "${unread.slice(0, 90)}". ${CAN_READ}`);
  for (const c of clauses) {
    if (s.text.slice(c.from, c.to) === named.slice(c.from, c.to)) return refuse(`I couldn't read the sell rule: "${full.slice(c.from, c.to).trim().slice(0, 90)}". ${CAN_READ}`);
  }
  if (clash) return refuse(clash);

  return {
    understood: true,
    problem: null,
    markets,
    kind: entry.length === 0 && got.cadence != null ? "dca" : "entry_exit",
    entry,
    exit: { takeProfitPct: got.tp, stopLossPct: got.sl, trailingStopPct: got.trail, conditions: exits },
    filters,
    sizePctOfCash: got.size,
    weights: [],
    cadenceHours: got.cadence,
  };
}

/** The built-in reader as a drafter, interchangeable with the language model's. */
export const ruleDrafter: PlanDrafter = async (sentence) => readStrategy(sentence);
