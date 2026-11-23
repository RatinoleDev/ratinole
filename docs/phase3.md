# Phase 3: live trading on Robinhood Chain

Status and the path to mainnet. Nothing is deployed on mainnet, and live trading is
closed on the site until the owner opens it. Paper trading is unaffected. The owner's
steps are in [go-live.md](go-live.md).

## Decisions taken (owner, 20 Nov 2026)

| Topic | Decision |
|---|---|
| Contracts | Fork NOUNY's AgentVault and PayrollVault (MIT), with OpenZeppelin Contracts and the Chainlink interface |
| Admin | A Safe multisig behind a timelock with a 3-day public delay |
| Launch gate | First decision: only the owner's own $10 test until an independent security audit. **Changed by the owner on 20 Nov 2026: open to everyone before an audit.** A live agent only starts on a vault holding at most $500 while unaudited (`LIVE_MAX_VAULT_USD`), and the site says plainly that the contracts are unaudited |
| Bot keys | First decision: a KMS before mainnet. **Changed by the owner on 20 Nov 2026: the operator key is created on the server by the owner and kept in `.env`.** A KMS is still the plan before real volume |
| Signing library | viem in the engine (already used for wallet sign-in), approved by the owner |

## What is done

| Part | State |
|---|---|
| `contracts/`: AgentVault, factory, PayrollVault, payroll factory (from NOUNY) | Done, original tests kept green |
| Two-step vault ownership transfer (the offer lapses after 7 days) and a recovery wallet with a 2 to 90 day delay (any owner action ends a claim; a ready claim lapses after 30 days) | Done, tested |
| A new owner starts with the agent's access off; the agent's key can never be the recovery wallet | Done, tested |
| Factory admin set at deployment (the timelock); `vaultOf` follows ownership and can never block an ownership change | Done, tested |
| New vaults trade USDG, WETH and cbBTC only, fixed at deployment | Done, checked after deploying |
| Every swap carries a deadline the vault enforces: an order signed for one hour cannot trade later than 25 minutes into it | Done, tested |
| The factory's list of vaults always follows an ownership change (the call asks for enough gas), and can never block one | Done, tested at every gas amount |
| DecisionRegistry: one Merkle root per finished hour, posted within 14 days, never overwritable, verifiable by anyone | Done, tested |
| RatinoleTimelock (OpenZeppelin TimelockController) run by the Safe | Done, tested |
| Deploy script with post-deploy checks and a mainnet guard | Done, dry-run on a fork |
| Rehearsal of the Phase 3 done bar on a Robinhood Chain fork | Passes: $10 vault, one sell and one buy through real pools, both decisions verified in the registry, a timelocked admin change, full withdrawal |

Test counts: 80 unit tests, a 2,000-step fuzz test, and 11 fork tests (real
Uniswap pools and Chainlink feeds on a local copy of the chain, fake money).

Three rounds of internal review of the whole real-money path (contracts, engine, API,
website, owner's scripts) were done on 20 Nov 2026 and their findings fixed. They are
not an independent audit.

## Live trading: built and rehearsed

| Part | State |
|---|---|
| Engine live executor | Done. One crash-safe order per live agent per hour, placed with the operator key through `AgentVault.swap`; the position is read from the vault; deposits and withdrawals are flows, never gains; the stored decision carries the real amounts and the transaction |
| API | Done. Live launch and resume are checked against the vault on-chain; paper and live are never added together |
| Vault screens | Done. Create, deposit, withdraw, limits, pause, agent access, all signed in the user's wallet |
| Owner's scripts | Done. `scripts/keys.mjs` (create, show and remove the keys), `scripts/go-live.mjs` (status, Safe, deploy, open, close) |
| Rehearsal on a fork | Done, through the real website and the real engine process: sign in, create a vault, deposit, launch a live agent, the engine's hourly run buys through the real WETH/USDG pool, the decision links to its transaction, then pause and withdraw. Also the owner's steps with test accounts: a 2-of-2 Safe, deploy, the checks before opening |

## What is left

1. **The owner's go-live steps** ([go-live.md](go-live.md)): keys, ETH for fees, Safe, deploy, own-money test, open.
2. **Registry poster.** After each hourly run, build the Merkle tree over that hour's decisions, post the root,
   and store each decision's proof so the site can show "verified on-chain". The registry is deployed with the
   operator as poster until this ships.
3. **Keys in a KMS** before real volume.
4. **Independent audit**, then raise or remove the per-vault cap.
5. **Recovery wallet screen** (the contract supports it; the screen is not built).
6. **Landing page and legal copy for live trading**: the landing page still says paper trading only.

## Mainnet deploy (the owner runs this)

The short way is `node scripts/go-live.mjs deploy 0xSafe` on the server ([go-live.md](go-live.md)). It runs the
command below with the keys from `.env`.

The deployer only pays gas. Every admin power goes to the timelock, which only the
Safe can drive, with a 3-day public delay. The script checks the chain, refuses a
shorter delay, reads the state back after deploying, and stops if any power is not
where intended.

```bash
SAFE_ADDRESS=0x... OPERATOR_ADDRESS=0x... POSTER_ADDRESS=0x... DEPLOYER_PRIVATE_KEY=... CONFIRM_MAINNET=deploy-ratinole-mainnet pnpm --filter @rationale/contracts exec hardhat run scripts/deploy.js --network robinhood
```

Then verify the three contracts on the explorer and run the owner's own-money test
before opening the site to everyone.

## Worst case if the engine's operator key is stolen

The key can only swap a vault's tokens against USDG through the pinned pools. It can
never withdraw or send funds anywhere. Each swap must return at least the Chainlink
value minus the vault's slippage limit, and the vault caps the value traded per
24-hour window. Rough bound: `dailyLimitUsd × (maxSlippageBps + pool fee + oracle lag)`
per window, until the owner pauses the vault or revokes the operator (from NOUNY's
SECURITY.md). The windows are fixed, not rolling: around the end of one, up to twice
the limit can trade within a short time, so the bound for a single day is twice that
figure. The Vault page suggests a daily limit of $500 for a new vault; the owner picks it.

That bound holds while the price feeds keep up with the market, which is the normal
case (Chainlink updates a feed when the price moves by its threshold). The vault
accepts a feed's last answer for up to 25 hours (27 for USDG). If a feed stopped
updating while the market moved, a stolen key could trade against the old price, and
the loss per window could be as large as the daily limit times that move. The
engine itself is not exposed to this: it adds its own minimum from the pool's price
at the moment of the order, and a swap the vault's oracle disagrees with is refused.

## What is known and not fixed

- **No screen for handing a vault over or for a recovery wallet.** The contract
  supports both; today they can only be used through the explorer. The Vault page
  does show a recovery claim or a hand-over offer in progress, with a button to stop it.
- **A wallet that receives a second vault** keeps its first one listed on the site.
  The second is its property all the same; listing it means calling `listVault` on
  the factory through the explorer.
- **Tokens moved while the engine is down** (not paused: down) are valued at the
  price of the hour the engine sees them. Dollars are always counted exactly.
- **The API runs as the same server user as the engine.** It drops the keys from its
  own process at start, but it could still read the `.env` file. A KMS is the fix.
- **One engine process.** Two engines with the same operator key would fight over
  transaction numbers. Nothing enforces "one" beyond the PM2 setup.
- **An order nobody confirmed** is written off only once the chain's own clock is two
  minutes past the order's deadline. On a chain that has stopped making blocks, that
  moment does not come, and the agent places nothing else until it does. This is on
  purpose: the order is never written off while it could still trade.
- **A vault received from someone else** keeps their token list and limits. The engine
  refuses a vault whose settings for the traded tokens differ from the factory's, but a
  new owner should look at the limits on the Vault page before switching access on.
- **The last round of fixes** (resuming after tokens were taken out, an emptied vault
  with an order on record, two readings of node errors) is covered by tests, but was
  not read again by an independent reviewer.
- **Exits are checked once an hour, on the hourly close.** A stop is not a resting
  order: a price that falls through it and comes back inside the hour is not seen, and
  a fall straight through it is sold at the price of the next hour, not at the stop.
- **A stop that was reached stays an order to sell for up to 48 hours.** If the vault
  is paused on-chain with a stop reached and unpaused a day later, the position is sold
  in the first hour after, whatever the price is then. Tokens the owner adds meanwhile
  are part of the position and are sold with it. That includes a stop recorded in an
  hour when the vault could not be read: it is judged on the position on record, so a
  deposit made in that same hour does not soften it. After 48 hours, or when the agent
  is paused and resumed, the stop is checked afresh. A take profit is never kept open.
- **Closes the agent never looked at** (the engine was down, or no feed was current)
  count for the high a trailing stop follows, but a stop that was breached only at such
  a close, and not at the one the agent sees when it is back, is not acted on.
- **A plan that buys on a schedule and has an exit** stops adding to its position once
  the position is as large as the vault's daily limit can still sell. Raising the limit
  lets it go on. A position that outgrew the limit some other way (the price rose a
  lot, or the owner lowered the limit) is sold over more than one 24-hour window.
- **Tokens the owner adds to a position** are counted as bought at that hour's price
  (the average entry moves), but the high the trailing stop follows does not: it stays
  the high since the agent's own buy.
- **When both price feeds are behind**, the agent waits and no exit is checked. Each
  such decision says so. Binance (spot) and Hyperliquid (perpetual) prices differ a
  little, so a trailing high can span the two when the feed changes.
- **Explanations are written by template**, from the stored facts of each decision.
  No language model writes them yet.

## Open decisions

1. **Profit fee.** "10% of profit above the high-water mark" needs a contract-level
   mechanism, because the operator cannot withdraw from a vault (HANDOFF section 6).
2. **Token.** The owner launched $RATINOLE on Robinhood Chain on 23 Nov 2026
   (`0xcEc856b8a7f6946d4E589F400678D9CC43455d58`; the address is in
   `packages/config/src/brand.ts` and on the landing page). It has no function in the
   app or the contracts: it is not needed to trade and gives no claim on anything, and
   the site says so next to the address. What it will do, if anything, is still open.
3. **KMS provider** for the operator and poster keys.
4. **Audit:** which firm, budget and timing.
5. **Legal:** terms and risk pages for live trading, and the regulation that applies
   where users live.
6. **Copy trading and payroll** (Phase 4).
