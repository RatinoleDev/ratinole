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
const { deployAll, DAY } = require('./lib/deploy');

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
  if (live && delay < 3 * DAY) throw new Error('Mainnet timelock delay must be at least 3 days.');

  console.log(`Network ${network.name} (chain ${chainId})`);
  console.log(`Deployer ${await deployer.getAddress()}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer))} ETH`);
  console.log(`Safe ${safe}\nOperator ${operator}\nPoster ${poster}\nTimelock delay ${delay / DAY} days`);
  console.log(`Tokens: ${cfg.tokens.map((t) => t.symbol).join(', ')}`);

  const d = await deployAll({ ethers, deployer, safe, operator, poster, delay, cfg });
  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: await deployer.getAddress(),
    safe, operator, poster, timelockDelaySeconds: delay,
    timelock: d.timelock, factory: d.factory, registry: d.registry,
  };
  // Print first: the addresses must reach the screen even if the record file cannot be written.
  console.log(`\nDeployed and verified:\n  timelock ${d.timelock}\n  factory  ${d.factory}\n  registry ${d.registry}`);
  const file = path.join(__dirname, '..', 'deployments', `${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Written to ${file}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
