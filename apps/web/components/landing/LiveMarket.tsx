"use client";

/**
 * The live market strip at the top of the landing page. Prices and 24-hour change
 * update live from the API's event stream (which relays the engine's Binance
 * feed); regime, RSI, funding and volatility are the engine's hourly reading.
 * If the stream is unavailable it polls every 5 seconds, and with no live data
 * at all it shows the hourly reading.
 */
import type { LiveTickDTO, MarketDTO } from "@rationale/config";
import { useEffect, useRef, useState } from "react";
import { pct } from "../../lib/format";
import { LiveDot, Sparkline, fundingText, priceText, regimeText } from "./marketUi";

/** A tick older than this is not shown as live. */
const STALE_MS = 90_000;

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function LiveMarketBand({ markets, initial }: { markets: MarketDTO[]; initial: LiveTickDTO[] }) {
  const [ticks, setTicks] = useState<Record<string, LiveTickDTO>>(() => Object.fromEntries(initial.map((t) => [t.market, t])));
  const [flash, setFlash] = useState<Record<string, "up" | "down" | undefined>>({});
  // Start from the newest stored tick so the server and the browser render the
  // same thing; the effect below switches to the real clock right away.
  const [now, setNow] = useState(() => Math.max(0, ...initial.map((t) => t.t)));
  const prev = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const hasMarkets = markets.length > 0;
  useEffect(() => {
    // No market reading yet means no band: do not open a stream for it.
    if (!hasMarkets) return;
    setNow(Date.now());
    let lastMessage = Date.now();
    let poll: ReturnType<typeof setInterval> | null = null;
    const accept = (t: LiveTickDTO) => {
      lastMessage = Date.now();
      setTicks((cur) => (cur[t.market] && cur[t.market]!.t >= t.t ? cur : { ...cur, [t.market]: t }));
    };
    const startPolling = () => {
      if (poll) return;
      const run = () =>
        fetch("/api/public/market/live")
          .then((r) => (r.ok ? r.json() : []))
          .then((rows: LiveTickDTO[]) => rows.forEach(accept))
          .catch(() => undefined);
      void run();
      poll = setInterval(run, 5000);
    };
    let es: EventSource | null = null;
    if ("EventSource" in window) {
      es = new EventSource("/api/public/market/stream");
      es.onmessage = (e) => {
        try {
          accept(JSON.parse(e.data) as LiveTickDTO);
        } catch {
          /* ignore malformed */
        }
      };
    } else {
      startPolling();
    }
    // If the stream goes quiet (proxy, network), fall back to polling.
    const watchdog = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastMessage > 15_000) startPolling();
    }, 1000);
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
      clearInterval(watchdog);
    };
  }, [hasMarkets]);

  // Flash the price green or red when it moves. Each market has its own timer,
  // so a tick on one market never keeps the other one coloured.
  useEffect(() => {
    for (const [m, t] of Object.entries(ticks)) {
      const before = prev.current[m];
      prev.current[m] = t.price;
      if (before == null || t.price === before) continue;
      const dir = t.price > before ? "up" : "down";
      setFlash((f) => ({ ...f, [m]: dir }));
      clearTimeout(timers.current[m]);
      timers.current[m] = setTimeout(() => setFlash((f) => ({ ...f, [m]: undefined })), 450);
    }
  }, [ticks]);
  useEffect(() => {
    const all = timers.current;
    return () => Object.values(all).forEach(clearTimeout);
  }, []);

  if (markets.length === 0) return null;
  const liveTimes = Object.values(ticks).filter((t) => now - t.t < STALE_MS).map((t) => t.t);
  const isLive = liveTimes.length > 0;
  const readAt = markets.map((m) => m.asOf).sort().at(-1)!;

  return (
    <section className="mband strip3d" id="market" aria-label="The market right now">
      <div className="wrap stripin">
        {markets.map((m) => {
          const t = ticks[m.market];
          const live = t && now - t.t < STALE_MS ? t : null;
          const price = live?.price ?? m.price;
          const change = live?.change24Pct ?? m.change24Pct;
          const series = live ? [...m.closes7d, live.price] : m.closes7d;
          return (
            <article className="mcard" key={m.market}>
              <div className="mtop">
                <span className="msym">{m.marketLabel}</span>
                {live ? <span className="livechip">Live</span> : null}
              </div>
              <div className="mrow">
                <span className={`mpx num${flash[m.market] ? ` flash-${flash[m.market]}` : ""}`}>{priceText(price)}</span>
                <span className={`mchg ${change < 0 ? "neg" : "pos"}`}>{pct(change, 2)}</span>
              </div>
              <p className="mmeta">
                <span>
                  {regimeText(m)} · RSI {m.rsi != null ? m.rsi.toFixed(1) : "—"}
                </span>
                <span>Funding {fundingText(m.funding8hPct)}</span>
              </p>
              <div className="mchart">
                <Sparkline values={series} id={m.market} height={44} />
              </div>
            </article>
          );
        })}
        <p className="mnote">
          <LiveDot />
          {isLive ? `Live from Binance, ${clock(Math.max(...liveTimes))} UTC` : "Latest hourly reading"}. Regime, RSI and funding
          read hourly ({new Date(readAt).toISOString().slice(11, 16)} UTC). Daily move {markets.map((m) => `${m.market} ${m.dailyVolPct.toFixed(1)}%`).join(", ")}.
        </p>
      </div>
    </section>
  );
}
