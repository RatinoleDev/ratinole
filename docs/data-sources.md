# Data sources

Agents use hourly candles (price and volume) and hourly perpetual funding rates. Every decision stores
the source it used (`candleSource`, e.g. `binance:ETHUSDT`) and the open time of
the last closed candle (`candleTime`). Closed candles are saved in the `Candle`
table, so any decision or backtest can be replayed from stored data.

| Source | Used for | Endpoint | Key | Limits and caveats |
|---|---|---|---|---|
| Binance spot (primary) | ETH, BTC hourly candles | `https://data-api.binance.vision/api/v3/klines` | none | 1000 candles per request; weight-based rate limit. `api.binance.com` refuses some regions (it returned HTTP 451 from the build machine), so the market-data-only host is used. Prices are USDT pairs, standing in for USDG. |
| Hyperliquid (fallback) | Same markets when Binance fails | `POST https://api.hyperliquid.xyz/info` (`candleSnapshot`) | none | Perpetual-futures prices, close to spot but not identical. Returns at most the 5000 most recent candles. |
| Postgres `Candle` table (last resort) | When both feeds fail | local | – | Closed candles only. A decision for the current hour then holds with a fresh-data veto. |
| Hyperliquid funding | ETH, BTC hourly funding rates | `POST https://api.hyperliquid.xyz/info` (`fundingHistory`) | none | Hourly settlements, 500 per request, full history, so backtests can use it. Saved in the `FundingRate` table. Each candle carries the rate settled at its close. If the feed fails, agents carry on with price signals and funding rules do not hold. Funding evidence names its source. |

| Binance live stream (display only) | ETH, BTC live price and 24-hour change on the landing page | `wss://data-stream.binance.vision/stream` (`ethusdt@miniTicker`, `btcusdt@miniTicker`) | none | One WebSocket held by the engine; ticks about once a second. Each tick is stored in Redis for 90 seconds (`market:live:ETH`, `market:live:BTC`) and published on the `market:live` channel; the API relays them to browsers at `/api/public/market/stream` (server-sent events) and `/api/public/market/live`. While the socket is down the engine polls `https://data-api.binance.vision/api/v3/ticker/24hr` every 5 seconds. Agents never use these prices: they decide on closed hourly candles. |

Redis caches each feed response for 2 minutes, so all agents on one market
share one request per hourly run.

## Not collected yet (Phase 2)

Open interest, liquidations, large-wallet flows, news sentiment and the event
calendar. (Hyperliquid has no open-interest history and Binance's covers only
30 days, so open interest needs another source before it can be backtested.) The intake refuses strategies that depend on them and
names the missing data. Filters that need them (news, earnings week, macro
releases) are kept in the plan, marked "not checked yet" on the confirmation
screen and in every decision, and backtests are labelled with what they used
("Price signals only" or "Price and funding signals").
Choosing these providers is an open decision (HANDOFF section 9, item 6).

## Network notes for this repository's cloud sandbox

The sandbox reaches the internet through a proxy. Node's built-in `fetch` uses it
only when started with `NODE_USE_ENV_PROXY=1`; a normal VPS does not need this.
