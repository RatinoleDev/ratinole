# Rationale: build handoff

Trading agents that show their reasoning, on Robinhood Chain.
This document plus `prototype/rationale-v6.html` is everything needed to start the build.

> **Confirm before anything is registered or deployed:** the owner typed the brand as "ratinole" and the domain as "ratinole.trade". The prototype uses the spelling **Rationale**. Keep the brand name and domain in one config constant (`BRAND_NAME`, `BRAND_DOMAIN`) so the spelling can be changed in one place.

---

## 1. What we are building

A website and agent engine that does what NOUNY (nounyagent.com) does, and more:

| Area | NOUNY today | Rationale |
|---|---|---|
| Agent logic | 5 fixed indicator rules, hourly | Strategy written in plain English, evidence from several data sources, written reasons for every decision |
| Proof | Closed engine, empty public stats | Every decision logged, hashed on-chain, ranked against simply holding |
| Admin and bot keys | Single keys | Multisig with timelock for admin, bot key in a KMS |
| Vault ownership | Cannot be moved, lost key locks funds | Transferable, optional recovery wallet |
| Social | Leaderboard only | Copy trading with the author paid from profit only |
| Access | Website | Website and Telegram bot |
| Revenue | None | Fee on profit above the high-water mark |

The product must never promise profit. What it promises is a loss limit the contract enforces, a backtest scored on unseen days, and an open record.

---

## 2. What exists now

`prototype/rationale-v6.html` is a single-file design prototype. It is the visual and UX source of truth.

**Landing sections, in order:** floating nav, centered hero with 3D mark, "Runs on" strip, decision ticker, product preview in a browser frame, one full decision, five-step walkthrough (interactive), feature bento, comparison table, safety, pricing, FAQ, closing panel, footer.

**App views:** Overview, Agent Studio, My agents, Leaderboard, Vault, Payroll.

**What is fake in the prototype and must be built for real:**

- All numbers are sample data.
- The strategy reader is a keyword matcher (`understand()` in the script). Production uses an LLM, see section 5.
- Backtests are random walks. Production uses real candles.
- Wallet, vault and payroll are not connected to any chain.
- "Runs on" names and the pricing tiers are proposals, not decisions (section 9).

**Design tokens (keep exactly):**

| Token | Value |
|---|---|
| Background | `#F3F1EC` |
| Surface | `#FCFBF8`, cards `#FFFFFF` |
| Ink | `#0B0B0C` |
| Secondary text | `#4B4944`, muted `#8A867D` |
| Hairline | `#DEDAD0` |
| Accent | lime `#C6F432`, highlight `#CDF545` |
| Gain / loss | `#0B8A5C` / `#D8433A` |
| Display font | Bricolage Grotesque 700 to 800 |
| Body font | Instrument Sans 400 to 700 |

Light theme only. No dark mode, no navy, no gold.

---

## 3. Stack

Use the house stack. Do not introduce alternatives without asking.

- **Web:** Next.js 14 (App Router), TypeScript
- **API:** Fastify, TypeScript
- **Data:** PostgreSQL with Prisma, Redis for queues and caches
- **Chain:** viem, wagmi, Sign-In with Ethereum for login
- **Contracts:** Hardhat (the forked repo already uses it), Solidity 0.8.24 / 0.8.26
- **Hosting:** Hostinger VPS, PM2, Nginx
- **Jobs:** BullMQ on Redis for the hourly engine

Suggested repo layout:

```
apps/web        Next.js site and app
apps/api        Fastify API
apps/engine     hourly agent engine and keepers
packages/brain  strategy parsing, evidence, scoring, risk gate (pure TypeScript, fully unit tested)
packages/db     Prisma schema and client
contracts/      fork of nounyagent/nouny-agent with our changes
```

---

## 4. Chain facts (Robinhood Chain)

Taken from the public NOUNY repository and its config. Re-verify each on-chain before use.

| Item | Value |
|---|---|
| Chain ID | 4663 |
| Public RPC | `https://robinhood.drpc.org` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| Uniswap V3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |

Full token, Chainlink feed and pool fee tier list: `config/robinhood.json` in `github.com/nounyagent/nouny-agent`. Run their `scripts/check-config.js` against the chain before trusting it.

Things that are true of this chain and affect the build:

- It is an Arbitrum Orbit chain. `block.number` is the L1 block; use the ArbSys precompile for the L2 block.
- Stock token Chainlink feeds pause on weekends, so stock swaps must be refused until the feed updates.
- There is no sequencer-uptime feed, so staleness checks are the only protection.
- Uniswap pools are small. Keep trade sizes modest and always enforce a slippage limit against the oracle.

---

## 5. The agent brain

This is the product. Build it as `packages/brain`, pure and testable, with no network calls inside the scoring and risk code.

### 5.1 Strategy intake

The user writes a sentence. An LLM converts it to a strict JSON plan. The user sees the plan and must confirm it before anything runs.

```ts
type Plan = {
  markets: string[];                 // e.g. ["ETH"]
  kind: "entry_exit" | "rebalance" | "dca" | "grid";
  entry: Condition[];                // all must hold
  exit: { takeProfitPct?: number; stopLossPct?: number; trailingStopPct?: number; conditions?: Condition[] };
  filters: Filter[];                 // reasons to stand aside
  sizePctOfCash: number;             // 1 to 100
  weights?: Record<string, number>;  // for rebalance
};
type Condition = { signal: string; op: "<" | ">" | "crosses_above" | "crosses_below"; value: number; window?: number };
type Filter = "negative_news" | "earnings_week" | "stressed_regime" | "macro_print";
```

Rules:

- Validate the LLM output with zod. On failure, ask the user to rephrase; never guess.
- If the plan has no loss limit, add a 5% stop and tell the user.
- Refuse plans with `sizePctOfCash` above the user's cap.
- The LLM never receives keys and never triggers a transaction.

### 5.2 The five steps, run once per hour per agent

1. **Sense.** Collect evidence for the market: hourly candles, volume, funding rate, open interest, liquidation clusters, large-wallet net flow, headlines with a sentiment score, and the event calendar (earnings, macro prints).
2. **Regime.** Classify as `trending`, `ranging` or `stressed` from trend slope and realised volatility. Deterministic code, not the LLM.
3. **Weigh.** Score each piece of evidence from −100 to +100 for the action the plan asks for. Combine into a confidence from 0 to 100. Deterministic scoring; the LLM may only summarise headlines into a sentiment number.
4. **Guard.** A separate deterministic risk gate that can veto: position size, daily loss cap, pool depth for the size, event risk, stale data. A veto always wins.
5. **Explain and learn.** Write the decision and its reasons in plain language. Once a week, review closed trades and propose (never auto-apply) a change to the plan.

Every run produces one record:

```ts
type Decision = {
  agentId: string; at: string;            // ISO time
  action: "buy" | "sell" | "hold";
  confidence: number;                     // 0 to 100
  regime: "trending" | "ranging" | "stressed";
  evidence: { name: string; value: string; score: number }[];
  guard: { check: string; pass: boolean; detail: string }[];
  explanation: string;                    // what the user reads
  txHash?: string;                        // live trades only
};
```

### 5.3 Where the LLM is allowed

| Task | LLM | Deterministic code |
|---|---|---|
| Sentence to plan | Yes, schema-validated | Validation |
| Headline sentiment | Yes, returns a number | |
| Regime, scoring, risk gate, sizing | | Yes |
| Decision explanation text | Yes, written from the Decision record only | |
| Sending a transaction | | Yes |

The LLM explains decisions; it does not make them. This keeps results reproducible and backtestable, and it means a prompt injection in a headline cannot move money.

### 5.4 Backtesting

- Tune on the first two thirds of the window, score on the last third the tuner never saw. Show both numbers and the holding benchmark.
- Simulate fees and slippage (start at 0.1% per trade for paper, the real pool fee for live markets).
- News and wallet-flow signals have no reliable history at first. Label any backtest that excludes them as "price signals only".

### 5.5 Data sources to evaluate

Candles and funding: Binance, Hyperliquid. Stocks: Finnhub or Yahoo Finance. On-chain prices: Chainlink feeds and Uniswap pools. Wallet flows and liquidations: pick a provider and document its limits. News: pick a provider with an API and usage rights. Cache everything in Redis and record the source and timestamp with each evidence item.

---

## 6. Contracts

Fork `github.com/nounyagent/nouny-agent` (MIT licence, keep the licence file and attribution). Their `AgentVault` and `PayrollVault` are sound: the operator can only swap inside the vault, the minimum output comes from Chainlink, pools are pinned per token, there is a daily value cap, and only the owner withdraws.

Changes to make:

1. **Transferable ownership.** Two-step `transferOwnership` on `AgentVault` and `PayrollVault`, plus an optional recovery wallet with a time delay.
2. **Admin behind a multisig and timelock.** Factory admin is a Safe behind an OpenZeppelin `TimelockController` with a 3-day delay.
3. **Decision registry.** A small contract where the engine posts an hourly Merkle root of all Decision records. Anyone can verify a decision against it.
4. **Copy trading.** A follower's vault mirrors a leader's trades with the follower's own limits. No pooled funds.
5. **Leave out for version 1:** the Uniswap v4 hook, the hooked pool and the LP vault. In NOUNY's own setup the site's swap button does not route through that pool, and the LP vault cannot swap when it rebalances, so capital goes idle once price leaves the range.

**Open design problem: the profit fee.** Charging "10% of profit above the high-water mark" from a vault the operator cannot withdraw from needs a contract-level mechanism (for example a fee settled by the vault itself when the owner withdraws, computed from deposits and withdrawals it has recorded). Propose a design and get the owner's approval before writing it. Do not add any path that lets the operator move funds out.

Testing bar: keep their unit, fuzz and fork tests green, add tests for every change, and run the fork tests against real Robinhood Chain pools.

---

## 7. Build phases

Each phase ends with something the owner can open and click.

**Phase 1. Site and paper trading**
- Port the prototype to Next.js, matching it closely at 1360px and 390px widths.
- Wallet sign-in, create an agent from a sentence, see the plan, run a real backtest, launch in paper mode.
- Hourly engine with deterministic steps 1 to 4 on price signals, decisions stored and shown.
- Leaderboard computed against holding.
- Done when: an agent launched in paper mode produces a real decision with reasons every hour for 48 hours with no missed runs.

**Phase 2. Full reasoning**
- Add funding, liquidations, wallet flow, news sentiment and the event calendar.
- LLM explanations and the weekly self-review.
- Telegram bot: decision messages, pause, resume, "why".
- Done when: every decision shows at least four evidence items with sources and times.

**Phase 3. Live trading**
- Contract changes from section 6, deployed to a fork first, then mainnet with the owner's approval.
- Vault creation, deposit, limits, pause, revoke, withdraw from the app.
- Bot key in a KMS, per-vault nonce management, retry and alerting.
- Decision registry posting hourly.
- Done when: a $10 live agent completes a buy and a sell on mainnet and both appear in the registry.

**Phase 4. Copy trading, payroll, fee**
- Copy trading, payroll with CSV import, the approved fee mechanism, token holder discount.

---

## 8. Rules for the build

- Never commit keys or `.env` files. Read secrets from the environment.
- Never deploy to mainnet, move funds, or register a domain without the owner's explicit approval in that session.
- Never show invented statistics on the public site. Empty states say what to do next.
- No profit claims anywhere in copy. Keep the risk line in the footer.
- Every number shown to a user must be traceable to a stored record.
- An external security review is required before live trading is promoted publicly.
- Ask before adding a dependency that handles keys, signing or money.

---

## 9. Decisions the owner still has to make

1. Brand spelling and domain: Rationale / rationale.trade, or Ratinole / ratinole.trade.
2. Pricing: the prototype proposes free paper trading, 10% of profit for live, 5% for token holders.
3. Token: whether there is one, what it does, and when.
4. Which names appear in the "Runs on" strip. Only list what is really used.
5. Which LLM provider powers intake and explanations, and the monthly budget for it.
6. Data providers for news, wallet flows and liquidations.

---

## 10. Reference findings from the NOUNY review

Useful when positioning against them:

- Their repo contains contracts only. The website and engine are closed.
- Agents use five indicator rules on hourly closes. Their docs do not mention AI.
- Factory admin and the hooked-pool owner are a single wallet. The pool owner can route up to 50% of swap fees to any address.
- Vault ownership cannot be transferred.
- Their security review is by HEY Research Lab and is described as a review, not an audit.
- Public usage figures on their homepage were empty when checked on 19 Nov 2026.
