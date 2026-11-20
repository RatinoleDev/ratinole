/**
 * The built-in strategy reader. It turns common strategy sentences (English and Indonesian) into the same
 * draft the language model produces, using fixed rules, so Agent Studio works when no model is configured, when
 * the month's budget is spent, or when the model cannot be reached.
 *
 * It only translates. A number is used only where the sentence states it, and a part it cannot read (a rule
 * with a number or a comparison that matched nothing) makes it ask for a rephrase instead of dropping that part.
 * The draft then goes through the same checks as a model draft (`draftToPlan`).
 */
import type { Draft } from "./schema";
import type { PlanDrafter } from "./intake";
import type { Filter, Op } from "./types";

type Cond = Draft["entry"][number];

const NUM = "(\\d+(?:\\.\\d+)?)";
const PCT = `${NUM}\\s*%`;
/** A lookback such as "20-hour", "3 day", "20 jam": groups (count, unit). */
const WIN = "(\\d+)\\s*-?\\s*(hours?|hrs?|hr|h|jam|days?|hari|weeks?|minggu)";
const BELOW = "(?:below|under|beneath|less than|lower than|<|di\\s*bawah|kurang dari|lebih rendah dari)";
const ABOVE = "(?:above|over|greater than|more than|higher than|exceeds|exceed|>|di\\s*atas|lebih dari|lebih tinggi dari|melebihi)";
const AVG = "\\b(?:moving average|average|mean|sma|ma|rata-rata|rata rata|rerata)\\b";
/** "its 20-hour average" or "rata-rata 20 jam": the window may come before or after. Four groups. */
const AVGP = `(?:(?:its|the|it's|a|an)\\s+)?(?:${WIN}\\s+)?(?:simple\\s+|short\\s+|long\\s+|hourly\\s+)?${AVG}(?:\\s+${WIN})?`;
/** Optional lead-in words in front of a percentage, consumed with it. */
const LEAD = "(?:(?:the\\s+)?(?:price|harga|it)\\s+)?(?:(?:is|trades|sits|drops?|falls?|dips?|turun|jatuh|berada|ada)\\s+)?(?:(?:a|an)\\s+)?";
const SPAN = "(?:\\s+(?:in|over|within|during|dalam|selama)\\s+(?:the\\s+)?(?:last\\s+|past\\s+)?(?:" + WIN + "|(a day|one day|sehari)|(a week|one week|seminggu)|(an hour|one hour|sejam)))?";

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
];
/** Tickers that are also everyday words: read only when written in capitals. */
const UPPER_ONLY = ["META", "SPY", "COIN", "SOL", "ADA", "LINK", "HYPE"];

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

/** Leftover words that mean a rule was not read. A leftover number means the same. */
const UNREAD = new Set(
  (
    "above below over under beneath crosses cross crossing crossed breaks break breakout breakdown flips flip spike spikes " +
    "surge surges exceeds greater less higher lower atas bawah melewati menembus macd ema bollinger band bands stochastic " +
    "vwap fibonacci fib support resistance ichimoku atr obv adx candle candles pattern golden death divergence sentiment " +
    "twitter tweet tweets moon"
  ).split(" "),
);

/** Text where each consumed match is blanked out, so one phrase is never read twice. */
class Scan {
  constructor(public text: string) {}
  take(re: RegExp): RegExpExecArray | null {
    const m = re.exec(this.text);
    if (!m || m[0].trim() === "") return null;
    this.text = this.text.slice(0, m.index) + " ".repeat(m[0].length) + this.text.slice(m.index + m[0].length);
    return m;
  }
  each(re: RegExp, fn: (m: RegExpExecArray) => void) {
    for (let i = 0; i < 12; i++) {
      const m = this.take(re);
      if (!m) return;
      fn(m);
    }
  }
}

function normalise(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/×/g, "x")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")
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

/** Sentence to draft. Pure and deterministic. */
export function readStrategy(sentence: string): Draft {
  const full = normalise(sentence);
  const s = new Scan(full);

  if (/\bshort(?:ing|s)?\s+(?:eth|ether|ethereum|btc|bitcoin|it|the market|sell|selling|positions?)\b|\bgo(?:ing)?\s+short\b|\bleveraged?\b|\bmargin\b|\b\d+\s*x\s+(?:long|short|leverage)\b/.test(full)) {
    return refuse("Agents buy and sell spot only: short selling and leverage aren't available");
  }

  // Markets.
  const found: { at: number; ticker: string }[] = [];
  for (const [re, ticker] of TICKERS) s.each(re, (m) => found.push({ at: m.index, ticker }));
  for (const ticker of UPPER_ONLY) {
    if (new RegExp(`\\b${ticker}\\b`).test(sentence)) s.each(new RegExp(`\\b${ticker.toLowerCase()}\\b`), (m) => found.push({ at: m.index, ticker }));
  }
  const markets = [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.ticker))];

  const rebalance = /\brebalanc|\bkeep\s+\d+\s*%\s+\w+\s+and\s+\d+\s*%/.test(full);
  const grid = /\bgrid\b/.test(full);
  if (rebalance || grid) {
    return { ...EMPTY, understood: true, markets, kind: rebalance ? "rebalance" : "grid", exit: { ...EMPTY.exit, conditions: [] } };
  }

  // Where the sell rule sits: conditions found there are exits, the rest are entries.
  const sellAt = /\b(?:sell|exit|close|jual|keluar)\b\s+(?:it\s+|out\s+)?(?:when|if|once|after|as soon as|saat|kalau|ketika|jika|bila)\b/.exec(full);
  const sellEnd = sellAt ? (() => {
    const rest = full.slice(sellAt.index);
    const stop = rest.search(/[,;]|\.(?!\d)/);
    return stop === -1 ? full.length : sellAt.index + stop;
  })() : -1;
  const inSell = (at: number) => !!sellAt && at >= sellAt.index && at < sellEnd;

  // Reasons to stand aside.
  const filters: Filter[] = [];
  for (const [re, f] of FILTERS) s.each(re, () => void (filters.includes(f) || filters.push(f)));

  // Size per trade.
  const got: { size: number | null; cadence: number | null; tp: number | null; sl: number | null; trail: number | null } = { size: null, cadence: null, tp: null, sl: null, trail: null };
  const size = (m: RegExpExecArray) => void (got.size ??= Number(m[1]));
  const CASH = "(?:of\\s+(?:my\\s+|the\\s+)?(?:cash|capital|portfolio|balance|funds|account|bankroll)|dari\\s+(?:kas|modal|saldo|dana))";
  const USE = "(?:use|using|risk|risking|with|allocate|invest|buy|pakai|gunakan|memakai|menggunakan|beli)";
  const EACH = "(?:per|each|every|a|for each|setiap|tiap)\\s*(?:trade|position|purchase|buy|entry|order|transaksi|posisi|pembelian)";
  s.each(new RegExp(`(?:${USE}\\s+)?${PCT}\\s*(?:${CASH}\\s*)?${EACH}`), size);
  s.each(new RegExp(`(?:${USE}\\s+)?${PCT}\\s*${CASH}`), size);
  s.each(new RegExp(`(?:position\\s+)?size\\s*(?:of|is|:|=)?\\s*${PCT}`), size);

  // How often (a schedule with no buy rule is a "dca" plan).
  s.each(/\b(?:every|each|tiap|setiap)\s+(?:(\d+)\s*)?(hour|day|week|month|jam|hari|minggu|bulan)s?\b|\b(hourly|daily|weekly|monthly|harian|mingguan|bulanan)\b/, (m) => {
    const unit = (m[2] ?? m[3] ?? "").toLowerCase();
    const per = /^(hour|jam)/.test(unit) ? 1 : /^(da|hari)/.test(unit) ? 24 : /^(week|minggu)/.test(unit) ? 168 : 720;
    got.cadence ??= per * (m[1] ? Number(m[1]) : 1);
  });

  // Exits.
  s.each(new RegExp(`trailing\\s+stop(?:[- ]?loss)?\\s*(?:of|at|:|=)?\\s*${PCT}|${PCT}\\s*trailing(?:\\s+stop(?:[- ]?loss)?)?|\\btrail(?:ing)?\\s+(?:it\\s+)?(?:by\\s+)?${PCT}`), (m) => {
    got.trail ??= Number(m[1] ?? m[2] ?? m[3]);
  });
  s.each(new RegExp(`(?:exit|sell|close|out|jual)\\s+at\\s+(?:plus\\s*|\\+\\s*)${PCT}\\s+(?:or|and|atau|dan)\\s+(?:minus\\s*|-\\s*)${PCT}`), (m) => {
    got.tp ??= Number(m[1]);
    got.sl ??= Number(m[2]);
  });
  const tp = (m: RegExpExecArray) => void (got.tp ??= Number(m[1]));
  s.each(new RegExp(`(?:take|taking)[- ]?profits?\\s*(?:at|of|is|:|=|di|pada)?\\s*\\+?${PCT}`), tp);
  s.each(new RegExp(`ambil\\s+(?:untung|profit|keuntungan)\\s*(?:di|pada|saat)?\\s*\\+?${PCT}`), tp);
  s.each(new RegExp(`\\btp\\s*(?:at|of|is|:|=|di)?\\s*\\+?${PCT}`), tp);
  s.each(new RegExp(`(?:profit\\s+)?target\\s*(?:at|of|is|:|=)?\\s*\\+?${PCT}`), tp);
  s.each(new RegExp(`(?:(?:sell|exit|close|jual)\\s+(?:it\\s+)?(?:at|di|for\\s+a|with\\s+a)\\s+)?\\+?${PCT}\\s*(?:profit|gain|untung|keuntungan)`), tp);
  const sl = (m: RegExpExecArray) => void (got.sl ??= Number(m[1]));
  s.each(new RegExp(`stop[- ]?loss(?:es)?\\s*(?:at|of|is|:|=|di|pada)?\\s*-?${PCT}`), sl);
  s.each(new RegExp(`\\bsl\\s*(?:at|of|is|:|=|di)?\\s*-?${PCT}`), sl);
  s.each(new RegExp(`(?:cut\\s+loss(?:es)?|cutloss|batas\\s+rugi)\\s*(?:at|di|pada)?\\s*${PCT}`), sl);
  s.each(new RegExp(`(?:with\\s+)?(?:a\\s+|an\\s+)?${PCT}\\s*stop(?:[- ]?loss)?`), sl);
  s.each(new RegExp(`\\bstop\\s*(?:out\\s+)?(?:at|of|is|:|=|di)?\\s*-?${PCT}`), sl);

  // Conditions.
  const entry: Cond[] = [];
  const exits: Cond[] = [];
  const add = (m: RegExpExecArray, c: Cond) => void (inSell(m.index) ? exits : entry).push(c);
  const cond = (signal: string, op: Op, value: number, window: number | null = null): Cond => ({ signal, op, value, window });
  const dir = (word: string): "up" | "down" => (/below|under|beneath|less|lower|<|bawah|kurang|rendah/.test(word) ? "down" : "up");

  // Distance from a recent high: "5% below its 3-day high".
  s.each(new RegExp(`${LEAD}${PCT}\\s*(?:${BELOW}|off|from|down from|dari)\\s+(?:its|the|it's)?\\s*(?:${WIN}\\s+)?(?:recent\\s+)?(?:high|peak|top|harga tertinggi|tertinggi|puncak)(?:\\s+${WIN})?`), (m) =>
    add(m, cond("from_high_pct", "<", -Number(m[1]), hours(m[2], m[3]) ?? hours(m[4], m[5]))),
  );
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

  // RSI.
  let rsiWindow: number | null = null;
  s.each(/(\d+)\s*-?\s*(?:hours?|periods?|jam)\s+(?=rsi\b)|(?<=\brsi)\s*\(\s*(\d+)\s*\)/, (m) => void (rsiWindow ??= Number(m[1] ?? m[2])));
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

  // Price change over a period. Inside a sell rule with no period it is the stop or the target.
  const span = (m: RegExpExecArray, i: number) => hours(m[i], m[i + 1]) ?? (m[i + 2] ? 24 : m[i + 3] ? 168 : m[i + 4] ? 1 : null);
  const MORE = "(?:by\\s+|more than\\s+|over\\s+|at least\\s+|lebih dari\\s+|sebesar\\s+)?";
  s.each(new RegExp(`(?:(?:the\\s+)?(?:price|harga|it)\\s+)?\\b(?:falls?|drops?|declines?|loses|is down|down|sinks?|slides?|tumbles?|turun|jatuh|anjlok)\\s+${MORE}${PCT}${SPAN}`), (m) => {
    const w = span(m, 2);
    if (inSell(m.index) && w == null) got.sl ??= Number(m[1]);
    else add(m, cond("change_pct", "<", -Number(m[1]), w));
  });
  s.each(new RegExp(`(?:(?:the\\s+)?(?:price|harga|it)\\s+)?\\b(?:rises?|gains?|jumps?|pumps?|rallies|rally|climbs?|is up|up|naik|melonjak)\\s+${MORE}${PCT}${SPAN}`), (m) => {
    const w = span(m, 2);
    if (inSell(m.index) && w == null) got.tp ??= Number(m[1]);
    else add(m, cond("change_pct", ">", Number(m[1]), w));
  });

  // Data that is not collected yet: named so the refusal can say exactly what is missing.
  s.each(/\b(?:follow(?:ing)?\s+)?(?:whales?|large wallets?|big wallets?|smart money|paus)\b(?:\s+(?:are\s+)?(?:buying|accumulating|membeli))?/, (m) => add(m, cond("wallet_net_flow_usd", ">", 0)));
  s.each(/\bliquidations?\b(?:\s+(?:spike|spikes|surge|surges|rise|rises|jump|jumps|melonjak))?/, (m) => add(m, cond("liquidations_usd", ">", 0)));
  s.each(/\bopen interest\b(?:\s+(?:is\s+)?(?:rising|rises|up|growing|naik))?/, (m) => add(m, cond("open_interest_change_pct", ">", 0)));

  // "sell when it crosses below it": the same signal as the buy rule, the other way.
  if (sellAt && exits.length === 0) {
    const m = /\bcross\w*\s+(?:back\s+)?(above|over|below|under)(?:\s+(?:it|that|the same|again))?/.exec(s.text.slice(sellAt.index, sellEnd));
    const last = entry[entry.length - 1];
    if (m && last) {
      s.text = s.text.slice(0, sellAt.index + m.index) + " ".repeat(m[0].length) + s.text.slice(sellAt.index + m.index + m[0].length);
      exits.push({ ...last, op: dir(m[1]!) === "up" ? "crosses_above" : "crosses_below" });
    }
  }

  const readAnything = entry.length + exits.length > 0 || got.tp != null || got.sl != null || got.trail != null || got.cadence != null || got.size != null;
  if (!markets.length && !readAnything) return refuse(null);

  // Anything that still looks like a rule was not read: say so instead of dropping it.
  const CAN_READ = "The built-in reader understands RSI, a dip under an average, the trend, a price change over a period, distance from a recent high, volume and funding";
  const unread = s.text
    .split(/\s{2,}|[,;:()]|\.(?!\d)/)
    .map((part) => part.trim())
    .find((part) => part.split(/[^a-z0-9%.<>-]+/).some((w) => /\d/.test(w) || /[<>]/.test(w) || UNREAD.has(w)));
  if (unread) return refuse(`I couldn't read this part: "${unread.slice(0, 90)}". ${CAN_READ}`);
  if (sellAt) {
    const original = full.slice(sellAt.index, sellEnd);
    if (s.text.slice(sellAt.index, sellEnd) === original) return refuse(`I couldn't read the sell rule: "${original.slice(0, 90)}". ${CAN_READ}`);
  }

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
