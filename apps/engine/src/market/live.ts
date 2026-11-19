/**
 * Live prices for the landing page. The engine holds one WebSocket to Binance's
 * public market-data stream (no key) and publishes each tick through Redis; the
 * API fans ticks out to browsers, so visitors never connect to Binance
 * themselves. If the stream drops, the engine reconnects with backoff and polls
 * the REST ticker every few seconds until it is back.
 *
 * These are display prices only. Agents decide on closed hourly candles.
 */
import { MARKETS, MARKET_IDS, type MarketId } from "@rationale/config";
import type { Redis } from "ioredis";
import { log } from "../log";

export interface LiveTick {
  market: string;
  price: number;
  open24h: number;
  change24Pct: number;
  high24h: number;
  low24h: number;
  /** Exchange event time, ms. */
  t: number;
  source: "binance";
}

export const LIVE_CHANNEL = "market:live";
export const liveKey = (market: string) => `market:live:${market}`;

const STREAM_URL = process.env.BINANCE_STREAM_URL ?? "wss://data-stream.binance.vision/stream";
const REST_URL = process.env.BINANCE_DATA_URL ?? "https://data-api.binance.vision";

const bySymbol = new Map<string, MarketId>(MARKET_IDS.map((m) => [MARKETS[m].binanceSymbol, m]));

function tick(market: string, price: number, open: number, high: number, low: number, t: number): LiveTick | null {
  if (![price, open, high, low, t].every((x) => Number.isFinite(x)) || price <= 0 || open <= 0) return null;
  return { market, price, open24h: open, change24Pct: (price / open - 1) * 100, high24h: high, low24h: low, t, source: "binance" };
}

/** A combined-stream miniTicker message, e.g. {"stream":"ethusdt@miniTicker","data":{...}}. */
export function parseMiniTicker(raw: string): LiveTick | null {
  try {
    const msg = JSON.parse(raw) as { data?: { e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; E?: number } };
    const d = msg.data;
    if (!d || d.e !== "24hrMiniTicker" || !d.s) return null;
    const market = bySymbol.get(d.s);
    if (!market) return null;
    return tick(market, Number(d.c), Number(d.o), Number(d.h), Number(d.l), Number(d.E));
  } catch {
    return null;
  }
}

/** The REST 24h ticker, used while the stream is down. */
export function parseRestTickers(rows: unknown): LiveTick[] {
  if (!Array.isArray(rows)) return [];
  const out: LiveTick[] = [];
  for (const r of rows as { symbol?: string; lastPrice?: string; openPrice?: string; highPrice?: string; lowPrice?: string; closeTime?: number }[]) {
    const market = r.symbol ? bySymbol.get(r.symbol) : undefined;
    if (!market) continue;
    const t = tick(market, Number(r.lastPrice), Number(r.openPrice), Number(r.highPrice), Number(r.lowPrice), Number(r.closeTime));
    if (t) out.push(t);
  }
  return out;
}

export async function storeTick(redis: Pick<Redis, "set" | "publish">, t: LiveTick): Promise<void> {
  const json = JSON.stringify(t);
  // Expire quickly: if the engine stops, the site falls back to the hourly reading.
  await redis.set(liveKey(t.market), json, "EX", 90);
  await redis.publish(LIVE_CHANNEL, json);
}

/** Runs until stop() is called. */
export function startLivePrices(redis: Redis): { stop: () => void } {
  const streams = MARKET_IDS.map((m) => `${MARKETS[m].binanceSymbol.toLowerCase()}@miniTicker`).join("/");
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let lastMessage = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    try {
      const symbols = encodeURIComponent(JSON.stringify(MARKET_IDS.map((m) => MARKETS[m].binanceSymbol)));
      const res = await fetch(`${REST_URL}/api/v3/ticker/24hr?symbols=${symbols}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const t of parseRestTickers(await res.json())) await storeTick(redis, t);
    } catch (err) {
      log("warn", "live price poll failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const startPolling = () => {
    if (pollTimer || stopped) return;
    void poll();
    pollTimer = setInterval(poll, 5000);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`${STREAM_URL}?streams=${streams}`);
    ws.onopen = () => {
      backoff = 1000;
      lastMessage = Date.now();
      stopPolling();
      log("info", "live price stream connected");
    };
    ws.onmessage = (m) => {
      lastMessage = Date.now();
      const t = parseMiniTicker(String(m.data));
      if (t) void storeTick(redis, t).catch(() => undefined);
    };
    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      startPolling();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };

  // Binance closes streams after 24 hours, and a silent socket is a dead one.
  const watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessage > 30_000) {
      log("warn", "live price stream silent; reconnecting");
      ws.close();
    }
  }, 10_000);

  connect();
  return {
    stop: () => {
      stopped = true;
      clearInterval(watchdog);
      stopPolling();
      ws?.close();
    },
  };
}
