// Checks a deployment again, from its record in deployments/<network>.json. It only reads the chain: it needs no
// private key and sends nothing. The owner runs it through `node scripts/go-live.mjs verify` when the deploy
// step created the contracts but stopped before its checks had all passed (one slow answer from the node is
// enough for that).
//
//   pnpm --filter @rationale/contracts exec hardhat run scripts/verify-deployment.js --network robinhood
//
// The record is marked verified only when every check passes. A failed check never changes the record.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const netConfig = require('./netconfig');
const { checkDeployment, refuseDevNode, readSafe } = require('./lib/deploy');

async function main() {
  const live = network.name === 'robinhood';
  const file = path.join(__dirname, '..', 'deployments', `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`There is no deployment record for ${network.name} (${file}). Nothing to check.`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of ['timelock', 'factory', 'registry', 'safe', 'operator', 'poster', 'deployer']) {
    if (!ethers.isAddress(record[name])) throw new Error(`The record has no ${name} address. It cannot be checked.`);
  }
  if (!Number.isInteger(record.timelockDelaySeconds)) throw new Error('The record has no timelock delay. It cannot be checked.');

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== record.chainId) throw new Error(`The record is for chain ${record.chainId}, but this node answers for chain ${chainId}.`);
  if (live) await refuseDevNode({ ethers, network });

  console.log(`Checking the deployment recorded for ${network.name} (chain ${chainId})`);
  for (const name of ['timelock', 'factory', 'registry']) {
    if ((await ethers.provider.getCode(record[name])) === '0x') throw new Error(`There is no contract at the recorded ${name} address ${record[name]} on this chain.`);
  }
  const safe = await readSafe({ ethers, safe: record.safe });
  if (!safe) throw new Error(`There is no contract at the Safe's address ${record.safe} on this chain. The admin of these contracts is an address nobody controls here.`);
  console.log(`  ok  the admin is a Safe on this chain: ${safe.threshold} of ${safe.owners.length} owners must approve`);
  // The agent's key must never own the Safe. The deployer key may, as its one owner, when the owner chose two
  // wallets and no third: it is then the admin key, kept by the owner and taken off the server before opening.
  const isOwner = (address) => safe.owners.some((o) => o.toLowerCase() === address.toLowerCase());
  for (const [what, address] of Object.entries({ operator: record.operator, poster: record.poster })) {
    if (isOwner(address)) throw new Error(`The ${what} key (${address}) is an owner of the Safe. The key that trades must not hold the admin: replace that owner in the Safe before going on.`);
  }
  if (isOwner(record.deployer)) {
    if (safe.owners.length !== 1) throw new Error(`The deployer key (${record.deployer}) is one of several owners of the Safe. It may only be its one owner, or not an owner at all.`);
    console.log(`  ok  the agent's key is not an owner of the Safe`);
    console.log(`  note  the Safe's one owner is the deployer key (${record.deployer}): it is the ADMIN key. Keep its backup safe and keep it off the server.`);
  } else {
    console.log('  ok  no key that sits on the server is an owner of the Safe');
  }

  const passed = await checkDeployment({
    ethers,
    addresses: { timelock: record.timelock, factory: record.factory, registry: record.registry },
    safe: record.safe,
    operator: record.operator,
    poster: record.poster,
    delay: record.timelockDelaySeconds,
    deployer: record.deployer,
    cfg: netConfig(network.name),
  });
  for (const name of passed) console.log(`  ok  ${name}`);

  if (record.verified === true) {
    console.log('\nEvery check passed. The record was already marked as verified.');
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify({ ...record, verified: true, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`\nEvery check passed. The record is now marked as verified: ${file}`);
}

main().catch((e) => {
  console.error(`\n${e.message || e}\nThe record was left as it was.`);
  process.exitCode = 1;
});
