// Deploys Ratinole to Robinhood Chain. Run by the OWNER on their own machine, never by the build:
//
//   SAFE_ADDRESS=0x... OPERATOR_ADDRESS=0x... POSTER_ADDRESS=0x... \
//   DEPLOYER_PRIVATE_KEY=... CONFIRM_MAINNET=deploy-ratinole-mainnet \
//   pnpm --filter @rationale/contracts exec hardhat run scripts/deploy.js --network robinhood
//
// The deployer only pays gas: every admin power goes to the timelock, which only the Safe can drive, with a
// 3-day public delay. Check the printed summary, then wait for the script to verify the deployment.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const netConfig = require('./netconfig');
const { deployAll, vaultTokens, refuseDevNode, readSafe, DAY } = require('./lib/deploy');

async function main() {
  const live = network.name === 'robinhood';
  if (live && process.env.CONFIRM_MAINNET !== 'deploy-ratinole-mainnet') {
    throw new Error('Mainnet deploy needs CONFIRM_MAINNET=deploy-ratinole-mainnet. Nothing was sent.');
  }
  const cfg = netConfig(network.name);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployer: set DEPLOYER_PRIVATE_KEY in the environment.');
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (live && chainId !== 4663n) throw new Error(`Expected chain 4663, got ${chainId}`);
  if (live) await refuseDevNode({ ethers, network });

  const safe = process.env.SAFE_ADDRESS;
  const operator = process.env.OPERATOR_ADDRESS;
  const poster = process.env.POSTER_ADDRESS;
  const delay = Number(process.env.TIMELOCK_DELAY_SECONDS || 3 * DAY);
  if (!Number.isInteger(delay) || delay < 0) throw new Error('TIMELOCK_DELAY_SECONDS must be a whole number of seconds.');
  if (live && delay < 3 * DAY) throw new Error('Mainnet timelock delay must be at least 3 days.');
  // The delay can only be changed through the timelock itself, after waiting it out. A mistaken huge value
  // (milliseconds instead of seconds, say) would freeze the admin for years.
  if (delay > 30 * DAY) throw new Error('The timelock delay may not be more than 30 days.');
  for (const [name, a] of Object.entries({ SAFE_ADDRESS: safe, OPERATOR_ADDRESS: operator, POSTER_ADDRESS: poster })) {
    if (!ethers.isAddress(a) || a === ethers.ZeroAddress) throw new Error(`${name} must be an address. Nothing was sent.`);
  }
  if (safe.toLowerCase() === operator.toLowerCase() || safe.toLowerCase() === poster.toLowerCase()) throw new Error('The Safe and the agent\'s key must be different addresses. Nothing was sent.');
  const file = path.join(__dirname, '..', 'deployments', `${network.name}.json`);
  if (live && fs.existsSync(file)) throw new Error(`Already deployed on ${network.name} (${file}). Deploying again would create a second, separate set. Nothing was sent.`);

  // The admin must be a Safe that exists on THIS chain: a Safe made on another network has no contract here,
  // and powers handed to an address nobody controls are gone for good.
  const found = await readSafe({ ethers, safe }).catch((e) => {
    throw new Error(`${e.message} Nothing was sent.`);
  });
  let safeNote = 'not a contract (allowed off mainnet only)';
  if (found) {
    // The Safe is the admin. A key that sits on the server (the deployer, the agent) must not be one of its
    // owners: whoever gets into the server would get the admin too, and the deployer key is thrown away after.
    // The owner may choose the deployer key as the Safe's one owner (ADMIN_KEY_IS_DEPLOYER=1): it is then the
    // admin key, backed up by the owner and taken off the server before the site opens. Never the agent's key.
    const adminIsDeployer = process.env.ADMIN_KEY_IS_DEPLOYER === '1';
    const deployerAddr = await deployer.getAddress();
    if (adminIsDeployer && !(found.owners.length === 1 && found.owners[0].toLowerCase() === deployerAddr.toLowerCase())) {
      throw new Error('ADMIN_KEY_IS_DEPLOYER is only for a Safe whose one owner is the deployer key. Nothing was sent.');
    }
    const onServer = { ...(adminIsDeployer ? {} : { 'the deployer': deployerAddr }), 'the operator': operator, 'the poster': poster };
    for (const [what, address] of Object.entries(onServer)) {
      if (found.owners.some((o) => o.toLowerCase() === address.toLowerCase())) {
        throw new Error(`${address} is ${what}'s address and also an owner of the Safe. The Safe's owners must be wallets held away from the server. Nothing was sent.`);
      }
    }
    safeNote = `${found.threshold} of ${found.owners.length} owners must approve: ${found.owners.join(', ')}`;
  } else if (live) {
    throw new Error(`There is no contract at ${safe} on Robinhood Chain. Create the Safe on this chain first (scripts/create-safe.js). Nothing was sent.`);
  }

  console.log(`Network ${network.name} (chain ${chainId})`);
  console.log(`Deployer ${await deployer.getAddress()}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer))} ETH`);
  console.log(`Safe ${safe} (${safeNote})\nOperator ${operator}\nPoster ${poster}\nTimelock delay ${delay / DAY} days`);
  console.log(`Tokens every new vault may trade: ${vaultTokens(cfg).map((t) => t.symbol).join(', ')}`);

  const base = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: await deployer.getAddress(),
    safe, operator, poster, timelockDelaySeconds: delay,
  };
  const save = (record) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  };
  // The addresses reach the screen and the record as soon as the contracts exist, before any check: whatever
  // happens next, they are not lost. The record is marked verified only once every check has passed.
  let deployed = false;
  const d = await deployAll({
    ethers, deployer, safe, operator, poster, delay, cfg,
    // Each address is printed the moment its contract exists: if a later step fails, nothing already paid for is lost.
    onStep: (name, address) => console.log(`  deployed ${name} at ${address}`),
    onDeployed: (a) => {
      deployed = true;
      console.log(`\nDeployed (not checked yet):\n  timelock ${a.timelock}\n  factory  ${a.factory}\n  registry ${a.registry}`);
      try {
        save({ ...base, ...a, verified: false });
      } catch (e) {
        console.log(`Could not write ${file} (${e.message}). Keep the addresses above.`);
      }
    },
  }).catch((e) => {
    if (!deployed) throw e;
    // Deployed, but a check failed or could not be read (a node that is a moment behind is enough). Nothing is
    // lost: the record is there, marked as not verified, and the checks can be run again.
    throw new Error(`${e.message}\n\nThe contracts ARE deployed (addresses above), but they are not marked as verified.\nRun the checks again:  node scripts/go-live.mjs verify${live ? '' : ' --network localhost'}`);
  });
  save({ ...base, timelock: d.timelock, factory: d.factory, registry: d.registry, verified: true });
  console.log(`\nEvery check passed. Written to ${file}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
