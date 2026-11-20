# Phase 3: live trading on Robinhood Chain

Status and the path to mainnet. Nothing is deployed on mainnet. Paper trading is
unaffected.

## Decisions taken (owner, 20 Nov 2026)

| Topic | Decision |
|---|---|
| Contracts | Fork NOUNY's AgentVault and PayrollVault (MIT), with OpenZeppelin Contracts and the Chainlink interface |
| Admin | A Safe multisig behind a timelock with a 3-day public delay |
| Launch gate | On mainnet, only the owner's own $10 test until an independent security audit; public deposits after the audit |
| Bot keys | Test keys on a fork only for now; a KMS is chosen before mainnet |

## What is done

| Part | State |
|---|---|
| `contracts/`: AgentVault, factory, PayrollVault, payroll factory (from NOUNY) | Done, original tests kept green |
| Two-step vault ownership transfer and a recovery wallet with a 2 to 90 day delay | Done, tested |
| Factory admin set at deployment (the timelock); `vaultOf` follows ownership | Done, tested |
| DecisionRegistry: one Merkle root per past hour, never overwritable, verifiable by anyone | Done, tested |
| RatinoleTimelock (OpenZeppelin TimelockController) run by the Safe | Done, tested |
| Deploy script with post-deploy checks and a mainnet guard | Done, dry-run on a fork |
| Rehearsal of the Phase 3 done bar on a Robinhood Chain fork | Passes: $10 vault, one sell and one buy through real pools, both decisions verified in the registry, a timelocked admin change, full withdrawal |

Test counts: 67 unit tests, a 2,000-step fuzz test, and 11 fork tests (real
Uniswap pools and Chainlink feeds on a local copy of the chain, fake money).

## What is left before the $10 mainnet test

1. **Engine live executor.** For agents in live mode, turn a decision's fill into
   `AgentVault.swap` through the operator key, with nonce handling, retries and
   alerts.
2. **Registry poster.** After each hourly run, build the Merkle tree over that
   hour's decisions, post the root, and store each decision's proof so the site
   can show "verified on-chain".
3. **Vault screens.** Create a vault, deposit, set limits, pause, set a recovery
   wallet, withdraw, all signed by the user's own wallet. Hidden until launch.
4. **Keys in a KMS.** The operator and poster keys live in a KMS chosen by the
   owner. The engine refuses raw keys outside a local fork.
5. **Safe on Robinhood Chain.** Confirm that Safe's contracts and interface are
   available on chain 4663, then create the Safe and choose its signers and
   threshold.

## Mainnet deploy (the owner runs this, on their own machine)

The deployer only pays gas. Every admin power goes to the timelock, which only the
Safe can drive, with a 3-day public delay. The script checks the chain, refuses a
shorter delay, reads the state back after deploying, and stops if any power is not
where intended.

```bash
SAFE_ADDRESS=0x... OPERATOR_ADDRESS=0x... POSTER_ADDRESS=0x... DEPLOYER_PRIVATE_KEY=... CONFIRM_MAINNET=deploy-ratinole-mainnet pnpm --filter @rationale/contracts exec hardhat run scripts/deploy.js --network robinhood
```

Then verify the three contracts on the explorer, run the $10 test (one buy, one
sell, both in the registry), and keep deposits limited to the owner until the
audit is complete.

## Worst case if the engine's operator key is stolen

The key can only swap a vault's tokens against USDG through the pinned pools. It can
never withdraw or send funds anywhere. Each swap must return at least the Chainlink
value minus the vault's slippage limit, and the vault caps the value traded per day.
Rough bound: `dailyLimitUsd × (maxSlippageBps + pool fee + oracle lag)` per day,
until the owner pauses the vault or revokes the operator (from NOUNY's SECURITY.md).

## Open decisions

1. **Profit fee.** "10% of profit above the high-water mark" needs a contract-level
   mechanism, because the operator cannot withdraw from a vault (HANDOFF section 6).
2. **Token.** Whether there is one, what it does, and when.
3. **KMS provider** for the operator and poster keys.
4. **Audit:** which firm, budget and timing.
5. **Legal:** terms and risk pages for live trading, and the regulation that applies
   where users live.
6. **Copy trading and payroll** (Phase 4).
