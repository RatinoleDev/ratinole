# Opening live trading (real money)

What the owner does to take Ratinole from paper trading to real money on Robinhood Chain. Everything here is
run by the owner, on the server, as the app's user. Nothing in the build or in CI deploys, signs or moves funds.

Live trading stays closed on the site until the last step. Until then the Vault page is a preview and every
agent is a paper agent.

## How real-money trading works

- A user creates a **vault**: a contract on Robinhood Chain that belongs to their wallet. Only that wallet can
  withdraw from it.
- They deposit USDG into the vault and launch one **live agent** on it.
- Once an hour the agent decides, exactly as a paper agent does. If it wants to trade, the server's **operator
  key** sends one swap inside the vault. The vault contract only lets that key swap, between the tokens the
  vault allows, at a price checked against Chainlink, and up to the vault's daily limit. It can never withdraw.
- The agent never trades straight from a user's wallet. A wallet's money is only at stake once its owner has
  moved it into their vault.

## Before you start

- **The contracts have not had an independent security audit.** You chose to open to everyone before one. A bug
  in a contract could lose users' money, and you would answer for it. While unaudited, a live agent only starts
  on a vault holding at most $500 (`LIVE_MAX_VAULT_USD` in `.env`; `none` removes the cap). Book an audit, and
  keep the cap until it is done.
- **Legal.** Running a service where software trades other people's money is regulated in many countries. Get
  advice for the places your users live before you promote it. The terms and risk pages are still drafts.
- **The operator key lives on this server.** Anyone who gets into the server can use it. It cannot withdraw, but
  it can make bad trades in every vault, each up to that vault's daily limit and slippage limit. Keep the
  server locked down (docs/deploy.md), and move the key to a KMS before real volume.

## Steps

All commands are run in the app folder as the app's user:

```bash
sudo -u ratinole -H bash -lc 'cd ~/app && <command>'
```

1. **Update the server** to the latest code (the usual update command in docs/deploy.md).

2. **Create the agent's key** and note its address:

   ```bash
   node scripts/keys.mjs create operator
   ```

   Back it up somewhere safe (a password manager, or on paper). This prints the private key on your screen:

   ```bash
   node scripts/keys.mjs show operator
   ```

   Never paste it into a chat, an email, a screenshot or a commit. If it is ever exposed, close live trading
   and have the Safe rotate the operator.

3. **Create the one-time deployer key**:

   ```bash
   node scripts/keys.mjs create deployer
   ```

4. **Send ETH on Robinhood Chain** to both addresses printed above. Fees there are very low (about 0.02 gwei
   when this was written): creating the Safe and deploying takes about 5.8 million gas, a few cents; one trade
   takes about 0.3 million gas. Sending 0.002 ETH to each is plenty to start. Check what arrived:

   ```bash
   node scripts/go-live.mjs status
   ```

5. **Create your Safe**, the admin of the contracts. List the wallet or wallets that must approve admin changes:

   ```bash
   node scripts/go-live.mjs safe 0xYourWallet,0xSecondSigner 2
   ```

   The last number is how many of them must approve. One wallet alone works (`safe 0xYourWallet`), but it is
   not a multisig; add a second signer as soon as you can. Keep the `SAFE_ADDRESS` it prints.

6. **Deploy the contracts**:

   ```bash
   node scripts/go-live.mjs deploy 0xYourSafeAddress
   ```

   It shows what it will do and asks you to type `DEPLOY`. It deploys the timelock (3-day delay, driven only by
   your Safe), the vault factory and the decision registry, then reads everything back and stops if any power
   is not where it should be. The addresses are saved in `contracts/deployments/robinhood.json`; commit that
   file. The deployer key has no power afterwards.

7. **Test with your own money first.** Open live trading only for yourself by doing step 8 at a quiet time,
   then: connect your wallet, create your vault on the Vault page, deposit $10 of USDG, launch a live agent
   from Agent Studio (the "Weekly ETH buyer" example buys in its first hour), and after the next hour check
   My agents (Live): the decision, its transaction on the explorer, and your vault's balances. Then pause the
   vault and withdraw. If anything looks wrong, run `node scripts/go-live.mjs close`.

8. **Open live trading on the site**:

   ```bash
   node scripts/go-live.mjs open
   pm2 reload ecosystem.config.cjs --update-env
   ```

   It asks you to type `OPEN`. From then on any visitor can create a vault and trade real money.

To close it again (vaults and their money stay on-chain, and owners can always withdraw):

```bash
node scripts/go-live.mjs close
pm2 reload ecosystem.config.cjs --update-env
```

## Keeping it running

- **The agent's fee money.** `node scripts/go-live.mjs status` shows how much ETH the operator address holds.
  If it runs out, orders stop going through and decisions say so. Top it up.
- **One engine only.** Exactly one engine process signs with the operator key. The manual `tick` command never
  trades live.
- **What a user sees when an order fails.** The decision for that hour is a hold with the reason (the vault is
  paused, its daily limit is used up, the pool price was outside its slippage limit, and so on). Nothing is
  retried later in the hour.
- **Missed hours are never traded late.** An order is only placed in the first 20 minutes of its hour.
- **An agent stops itself**, with the reason shown to its owner, when the vault is emptied, the agent's access
  is revoked, the vault changes owner, or the token is no longer allowed.

## Rehearsing with fake money

Everything above can be rehearsed against a local copy of Robinhood Chain (real pools and price feeds, fake
money):

```bash
FORK=1 pnpm --filter @rationale/contracts exec hardhat node            # terminal 1
node scripts/go-live.mjs status --network localhost                    # terminal 2, and so on
```

`contracts/scripts/fork-setup.js` deploys with Hardhat's public test accounts and gives a wallet fake USDG.
