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
| DecisionRegistry: one Merkle root per finished hour, never overwritable, verifiable by anyone | Done, tested |
| RatinoleTimelock (OpenZeppelin TimelockController) run by the Safe | Done, tested |
| Deploy script with post-deploy checks and a mainnet guard | Done, dry-run on a fork |
| Rehearsal of the Phase 3 done bar on a Robinhood Chain fork | Passes: $10 vault, one sell and one buy through real pools, both decisions verified in the registry, a timelocked admin change, full withdrawal |

Test counts: 75 unit tests, a 2,000-step fuzz test, and 11 fork tests (real
Uniswap pools and Chainlink feeds on a local copy of the chain, fake money).

An internal review of the whole real-money path (contracts, engine, API, website, owner's
scripts) was done on 20 Nov 2026 and its findings fixed. It is not an independent audit.

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
figure. The default daily limit for a new vault is $200.

## Open decisions

1. **Profit fee.** "10% of profit above the high-water mark" needs a contract-level
   mechanism, because the operator cannot withdraw from a vault (HANDOFF section 6).
2. **Token.** Whether there is one, what it does, and when.
3. **KMS provider** for the operator and poster keys.
4. **Audit:** which firm, budget and timing.
5. **Legal:** terms and risk pages for live trading, and the regulation that applies
   where users live.
6. **Copy trading and payroll** (Phase 4).
