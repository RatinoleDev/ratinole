# Data sources (Phase 1)

Phase 1 agents use hourly candles only: price and volume. Every decision stores
the source it used (`candleSource`, e.g. `binance:ETHUSDT`) and the open time of
the last closed candle (`candleTime`). Closed candles are saved in the `Candle`
table, so any decision or backtest can be replayed from stored data.

| Source | Used for | Endpoint | Key | Limits and caveats |
|---|---|---|---|---|
| Binance spot (primary) | ETH, BTC hourly candles | `https://data-api.binance.vision/api/v3/klines` | none | 1000 candles per request; weight-based rate limit. `api.binance.com` refuses some regions (it returned HTTP 451 from the build machine), so the market-data-only host is used. Prices are USDT pairs, standing in for USDG. |
| Hyperliquid (fallback) | Same markets when Binance fails | `POST https://api.hyperliquid.xyz/info` (`candleSnapshot`) | none | Perpetual-futures prices, close to spot but not identical. Returns at most the 5000 most recent candles. |
| Postgres `Candle` table (last resort) | When both feeds fail | local | – | Closed candles only. A decision for the current hour then holds with a fresh-data veto. |

Redis caches each feed response for 2 minutes, so all agents on one market
share one request per hourly run.

## Not collected yet (Phase 2)

Funding rates, open interest, liquidations, large-wallet flows, news sentiment
and the event calendar. The intake refuses strategies that depend on them and
names the missing data. Filters that need them (news, earnings week, macro
releases) are kept in the plan, marked "not checked yet" on the confirmation
screen and in every decision, and backtests are labelled "Price signals only".
Choosing these providers is an open decision (HANDOFF section 9, item 6).

## Network notes for this repository's cloud sandbox

The sandbox reaches the internet through a proxy. Node's built-in `fetch` uses it
only when started with `NODE_USE_ENV_PROXY=1`; a normal VPS does not need this.
