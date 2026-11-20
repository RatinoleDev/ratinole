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
  it can make bad trades in every vault, each up to that vault's daily limit and slippage limit. The daily
  limit is counted in fixed 24-hour windows, so around the end of a window up to twice the limit can trade
  within a short time. Keep the server locked down (docs/deploy.md), and move the key to a KMS before real
  volume. Only the engine reads the key: the API and the website drop it from their own process at start.
- **New vaults can trade USDG, WETH and cbBTC, and nothing else.** That list is fixed when the factory is
  deployed and can never be changed. Trading other tokens later means deploying a new factory.

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
   takes about 0.3 million gas. Sending 0.002 ETH to each is plenty to start. The site will not open while the
   agent's address holds less than 0.001 ETH. Check what arrived:

   ```bash
   node scripts/go-live.mjs status
   ```

5. **Create your Safe**, the admin of the contracts. List the wallet or wallets that must approve admin changes:

   ```bash
   node scripts/go-live.mjs safe 0xYourWallet,0xSecondSigner 2
   ```

   The last number is how many of them must approve; with more than one wallet you must give it. One wallet
   alone works (`safe 0xYourWallet`), but it is not a multisig: whoever holds that wallet controls the admin.
   Add a second signer as soon as you can. Keep the `SAFE_ADDRESS` it prints.

   **Use wallets you hold yourself, away from this server**: your own wallet app, or a hardware wallet. Never
   give the operator or deployer address printed in steps 2 and 3. The script refuses them. Those keys sit on
   the server, so whoever gets into the server would get the admin too, and the deployer key is removed after
   deploying, which would throw the admin away for good.

6. **Deploy the contracts**:

   ```bash
   node scripts/go-live.mjs deploy 0xYourSafeAddress
   ```

   It first checks that the address is a Safe on Robinhood Chain and shows its owners: **check that they are
   wallets you control** before you type `DEPLOY`. A Safe created on another network does not exist here, and
   a Safe that one of this server's keys owns is refused.
   It then deploys the timelock (3-day delay, driven only by your Safe), the vault factory and the decision
   registry. The three addresses are printed and saved in `contracts/deployments/robinhood.json` as soon as
   the contracts exist; then everything is read back, and the record is marked `"verified": true` only if
   every power is where it should be. Commit the record file.

   If it stops after printing the addresses, the contracts exist but their checks have not all passed. One
   slow answer from the network is enough for that. Do not deploy again and do not open the site. Run the
   checks again, as often as needed. This only reads the chain, uses no key and sends nothing:

   ```bash
   node scripts/go-live.mjs verify
   ```

   When every check passes it marks the record as verified. If a check keeps failing, stop and ask for help.

   The deployer key has no power afterwards. Move any ETH left on it, then take it off the server:

   ```bash
   node scripts/keys.mjs remove deployer
   ```

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

   Before it asks, it checks on-chain that the factory hands new vaults this server's agent key, that the
   factory's admin is the timelock, that its tokens are the ones the site trades, that the agent can pay fees,
   and that a vault can be created. Then it asks you to type `OPEN`. From then on any visitor can create a
   vault and trade real money.

To pause it (no live agent starts or trades; everyone can still see their vault on the site and withdraw):

```bash
node scripts/go-live.mjs close
pm2 reload ecosystem.config.cjs --update-env
```

The pause only takes effect after the reload. `close` writes the setting to `.env` and reads it back the way
the app will. It stops without changing anything if `.env` names a setting twice: the app would use the last
line, so keep one line for each setting.

Type the commands exactly. Without `--network localhost` they act on the real chain and on this site, so the
script stops at anything it does not recognise: a misspelt option, or a word too many.

## Keeping it running

- **The agent's fee money.** `node scripts/go-live.mjs status` shows how much ETH the operator address holds.
  If it runs out, orders stop going through and decisions say so. Top it up.
- **The chain connection.** The server and visitors' browsers read the chain through the public RPC, which is
  rate-limited. Before real volume, get a dedicated endpoint: `LIVE_RPC_URL` in `.env` for the server, and
  `NEXT_PUBLIC_CHAIN_RPC_URL` set when the website is built for the browser.
- **One engine only.** Exactly one engine process signs with the operator key. The manual `tick` command never
  trades live.
- **What a user sees when an order fails.** The decision for that hour is a hold with the reason (the vault is
  paused, its daily limit is used up, the pool price was outside its slippage limit, and so on). Nothing is
  retried later in the hour.
- **Missed hours are never traded late.** An order is only placed in the first 20 minutes of its hour, and the
  vault itself refuses it 25 minutes into the hour. An order that was signed but got stuck on the way can
  therefore never trade later. Until that moment the engine treats it as "not known yet" and places nothing
  else for that agent.
- **Tokens somebody else sends to a vault** do not make an agent think it is invested, unless they are worth at
  least one of the plan's own orders. Smaller amounts are left alone and join the position the next time the
  agent buys.
- **An agent stops itself**, with the reason shown to its owner, when the vault is emptied, the agent's access
  is revoked, the vault changes owner, or the vault's token settings are changed.
- **Orders fit the vault's daily limit.** A buy is made smaller, and a sale is split over the following hours,
  when the limit has less room than the order needs. The decision says so.
- **A vault that changes owner** (a transfer the new wallet accepts within 7 days, or a recovery) starts with
  the agent's access switched off. The new owner switches it on again on the Vault page and launches their
  own agent.

## Rehearsing with fake money

The Safe, deploy and open steps can be rehearsed against a local copy of Robinhood Chain (real pools and price
feeds, fake money):

```bash
FORK=1 pnpm --filter @rationale/contracts exec hardhat node            # terminal 1
node scripts/go-live.mjs status --network localhost                    # terminal 2, and so on
```

A rehearsal never reads this server's keys and never writes `.env`. The real commands refuse to run against a
node on this machine or a development node, whatever `ROBINHOOD_RPC_URL` says. A rehearsal signs with Hardhat's
public test accounts only: the local copy has the real chain's id, so anything signed for it with a real key would also
be valid on the real chain. `contracts/scripts/fork-setup.js` deploys with the same test accounts, gives a
wallet fake USDG, and prints the test operator key for a local engine.
