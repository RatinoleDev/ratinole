# Rationale (working name)

Trading agents that show their reasoning, on Robinhood Chain. This repository is
**Phase 1: the site and paper trading** from [HANDOFF.md](HANDOFF.md). The visual
source of truth is [prototype/rationale-v6.html](prototype/rationale-v6.html).

The brand name and domain live in one place:
[packages/config/src/brand.ts](packages/config/src/brand.ts) (the spelling is
still the owner's decision, HANDOFF section 9).

## Layout

```
apps/web        Next.js 14 site and app (landing + Overview, Agent Studio, My agents, Leaderboard, Vault, Payroll)
apps/api        Fastify API: Sign-In with Ethereum, intake, backtests, agents, decisions, leaderboard, health
apps/engine     BullMQ worker: hourly agent runs, backtests, candle feeds
packages/brain  Plan/Decision types, intake validation, regime, evidence, guard, paper accounting, walk-forward backtester (pure, unit tested)
packages/config Brand, chain, markets, paper settings, API response types
packages/db     Prisma schema and client (PostgreSQL)
docs/           Data sources, deployment guide
brand/          Logo files (SVG, PNG), colours and usage rules
deploy/         Nginx site config
scripts/        Database backup and health check
```

## Run it locally

Requirements: Node 22 (22.9 or later), pnpm 10, PostgreSQL 16, Redis 7.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create `.env` from the example and set `SESSION_SECRET` to a long random string:

   ```bash
   cp .env.example .env
   ```

   ```bash
   openssl rand -hex 32
   ```

   `ANTHROPIC_API_KEY` is optional. Without it, Agent Studio reads sentences
   with the built-in reader (`packages/brain/src/reader.ts`): fixed rules for
   common English and Indonesian phrasing, the same checks, and a refusal that
   names any part it cannot read. With a key, the language model reads the
   sentence (`LLM_MODEL`, default `claude-opus-5-5`), which copes with freer
   wording; when the month's `LLM_MONTHLY_BUDGET_USD` is spent or the model
   cannot be reached, the built-in reader takes over.

3. Start Postgres and Redis (or use local installs with the same URLs):

   ```bash
   pnpm dev:infra
   ```

4. Apply the database migrations:

   ```bash
   pnpm db:deploy
   ```

5. Start the engine, the API and the web app, each in its own terminal:

   ```bash
   pnpm dev:engine
   ```

   ```bash
   pnpm dev:api
   ```

   ```bash
   pnpm dev:web
   ```

6. Open http://localhost:3000. Health is at http://localhost:3000/api/health.

The engine runs every active agent at minute 1 of each hour (`ENGINE_RUN_MINUTE`),
catches up any hours it missed (marked late), and refreshes the landing page's
example backtest daily. To run owed agents immediately without waiting:

```bash
pnpm --filter @rationale/engine tick
```

Each hourly run also stores a market reading for ETH and BTC (price, regime,
RSI, funding) that the landing page shows. To store one right away:

```bash
pnpm --filter @rationale/engine tick market
```

The market band at the top of the landing page shows live prices. The engine
keeps one WebSocket open to Binance's public market-data stream and publishes
each tick through Redis, and the API relays ticks to browsers as server-sent
events, so a visitor's browser only talks to this site. Live prices are for
display; agents still decide on closed hourly candles. If the engine is
stopped, the band falls back to the latest hourly reading after 90 seconds.

To launch the house paper agents (run by the team, labelled "House" on the
site) so visitors can read real decisions from the first hour:

```bash
pnpm --filter @rationale/engine tick house
```

In a sandbox where outbound traffic goes through an HTTPS proxy, start the
engine with `NODE_USE_ENV_PROXY=1` so Node's fetch uses it.

## Tests

The API and engine tests use a separate database named by `TEST_DATABASE_URL`
(they wipe it) and Redis database 15. Create it once and apply migrations:

```bash
createdb rationale_test
```

```bash
DATABASE_URL=postgresql://rationale:rationale@localhost:5432/rationale_test pnpm db:deploy
```

Then run every package's tests, one package at a time:

```bash
pnpm test
```

Type-check and lint everything:

```bash
pnpm typecheck
```

```bash
pnpm lint
```

Browser smoke tests for the web app. Build it pointed at a closed port, so the
landing page is rendered with its empty states, then run the tests (browser API
calls are mocked):

```bash
API_INTERNAL_URL=http://127.0.0.1:9 pnpm --filter @rationale/web build
```

```bash
pnpm --filter @rationale/web test:e2e
```

GitHub Actions runs all of the above on every push (`.github/workflows/ci.yml`).

## Checking the strategy reader

`apps/api/eval/cases.json` holds 29 realistic sentences (English and Indonesian,
plus prompt-injection attempts) with the plan each should produce. With
`ANTHROPIC_API_KEY` set, a dry run prints the worst-case cost; `--yes` spends it:

```bash
pnpm --filter @rationale/api eval:intake
```

```bash
pnpm --filter @rationale/api eval:intake --yes
```

## How a decision is made

Each hour, for each active paper agent (HANDOFF 5.2, steps 1 to 4):

1. **Sense**: hourly candles from Binance (Hyperliquid if Binance fails) and hourly funding rates from Hyperliquid. See [docs/data-sources.md](docs/data-sources.md).
2. **Regime**: trending, ranging or stressed from the 200-hour trend slope and realised volatility (`packages/brain/src/regime.ts`).
3. **Weigh**: each entry or exit rule and context signals (trend, volatility, volume, funding) scored from -100 to +100, combined into a confidence from 0 to 100 (`evidence.ts`).
4. **Guard**: fresh data, position size, daily loss cap, market stress (if the plan asks), pool depth. A veto always wins; limits on new risk never block an exit (`guard.ts`).

The result is one `Decision` row per agent per hour, with evidence, guard checks and
a plain-language explanation built from those facts. Trades fill at the next
hour's opening price with a 0.1% cost. The backtester replays exactly this code
over history, tuning only what the sentence left open (a lookback, the confidence
needed) on the first 60 days and scoring the last 30 days unseen.

## Deployment

[docs/deploy.md](docs/deploy.md) walks through a VPS install: Postgres, Redis,
PM2 (`ecosystem.config.cjs`), Nginx with TLS and rate limits
(`deploy/nginx.conf`), daily backups (`scripts/backup-db.sh`) and a health check
for cron (`scripts/healthcheck.sh`). Run exactly one engine: it holds the live
price stream as well as the hourly runs.
