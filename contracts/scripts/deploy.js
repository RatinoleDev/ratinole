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
const { deployAll, vaultTokens, DAY } = require('./lib/deploy');

const SAFE_ABI = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'];

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
  const safeCode = await ethers.provider.getCode(safe);
  let safeNote = 'not a contract (allowed off mainnet only)';
  if (safeCode !== '0x') {
    const s = new ethers.Contract(safe, SAFE_ABI, ethers.provider);
    let owners, threshold;
    try {
      [owners, threshold] = [await s.getOwners(), Number(await s.getThreshold())];
    } catch {
      throw new Error(`The contract at ${safe} does not answer like a Safe. Nothing was sent.`);
    }
    if (!owners.length || threshold < 1 || threshold > owners.length) throw new Error(`The Safe at ${safe} has no usable owners. Nothing was sent.`);
    safeNote = `${threshold} of ${owners.length} owners must approve: ${owners.join(', ')}`;
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
  const d = await deployAll({
    ethers, deployer, safe, operator, poster, delay, cfg,
    onDeployed: (a) => {
      console.log(`\nDeployed (not checked yet):\n  timelock ${a.timelock}\n  factory  ${a.factory}\n  registry ${a.registry}`);
      try {
        save({ ...base, ...a, verified: false });
      } catch (e) {
        console.log(`Could not write ${file} (${e.message}). Keep the addresses above.`);
      }
    },
  });
  save({ ...base, timelock: d.timelock, factory: d.factory, registry: d.registry, verified: true });
  console.log(`\nEvery check passed. Written to ${file}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
