// Creates the Safe that will own every admin power of the contracts (through the timelock). The Safe's own
// contracts (v1.4.1) are already on Robinhood Chain; this only creates your instance of it.
//
//   SAFE_OWNERS=0xYourWallet[,0xSecondSigner,...] SAFE_THRESHOLD=2 DEPLOYER_PRIVATE_KEY=... \
//     pnpm --filter @rationale/contracts exec hardhat run scripts/create-safe.js --network robinhood
//
// The owners are the wallets that must approve admin changes; the threshold is how many of them are needed.
// One owner with a threshold of 1 works, but it is not a multisig: add a second signer as soon as you can.
// The deployer only pays the fee and has no power over the Safe. An owner must be a wallet held away from the
// server: the deployer's own address is refused, and so is any address in SAFE_FORBIDDEN_OWNERS (the agent's key).
// One exception, chosen by the owner and never by default: SAFE_OWNER_IS_DEPLOYER=1 creates a Safe whose one
// owner is the deployer key itself. That key is then the admin key, and must be backed up and kept off the server.
const fs = require('fs');
const { ethers, network } = require('hardhat');

const SAFE = {
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', // SafeL2 1.4.1
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
};

async function main() {
  const owners = (process.env.SAFE_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!owners.length || !owners.every((o) => ethers.isAddress(o))) throw new Error('Set SAFE_OWNERS to one or more wallet addresses, separated by commas');
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) throw new Error('SAFE_OWNERS lists the same wallet twice');
  // With more than one owner the number of approvals is a decision, so it is never guessed.
  if (owners.length > 1 && !process.env.SAFE_THRESHOLD) throw new Error(`Set SAFE_THRESHOLD: how many of the ${owners.length} owners must approve`);
  if (owners.some((o) => o === ethers.ZeroAddress)) throw new Error('SAFE_OWNERS contains the zero address');
  const threshold = Number(process.env.SAFE_THRESHOLD || 1);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) throw new Error('SAFE_THRESHOLD must be between 1 and the number of owners');
  if (Number((await ethers.provider.getNetwork()).chainId) !== 4663) throw new Error('This is not Robinhood Chain (4663)');
  for (const [name, addr] of Object.entries(SAFE)) {
    if ((await ethers.provider.getCode(addr)) === '0x') throw new Error(`Safe's ${name} is not deployed on this chain at ${addr}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('Set DEPLOYER_PRIVATE_KEY (it only pays the network fee)');
  // The Safe will be the admin of the contracts. A key that sits on the server must not own it: the deployer key
  // is thrown away after deploying, and whoever gets into the server must not get the admin with it.
  const deployerAddr = await deployer.getAddress();
  const ownerIsDeployer = process.env.SAFE_OWNER_IS_DEPLOYER === '1';
  if (ownerIsDeployer && !(owners.length === 1 && owners[0].toLowerCase() === deployerAddr.toLowerCase())) {
    throw new Error('SAFE_OWNER_IS_DEPLOYER is only for a Safe whose one owner is the deployer key. Nothing was sent.');
  }
  const forbidden = [...(ownerIsDeployer ? [] : [deployerAddr]), ...(process.env.SAFE_FORBIDDEN_OWNERS || '').split(',').map((a) => a.trim()).filter(Boolean)];
  for (const owner of owners) {
    if (forbidden.some((f) => f.toLowerCase() === owner.toLowerCase())) {
      throw new Error(`${owner} is a key that sits on this server (the deployer or the agent). Give a wallet you hold yourself, away from the server. Nothing was sent.`);
    }
  }
  const safeAbi = [
    'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
  ];
  const init = new ethers.Interface(safeAbi).encodeFunctionData('setup', [owners, threshold, ethers.ZeroAddress, '0x', SAFE.fallbackHandler, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const factory = await ethers.getContractAt(
    ['function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address)', 'event ProxyCreation(address indexed proxy,address singleton)'],
    SAFE.proxyFactory,
    deployer,
  );
  console.log(`Creating a Safe on ${network.name}: ${owners.length} owner(s), ${threshold} needed to approve...`);
  const receipt = await (await factory.createProxyWithNonce(SAFE.singleton, init, BigInt(Date.now()))).wait();
  const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'ProxyCreation');
  if (!created) throw new Error('The Safe was not created (no ProxyCreation event)');
  const address = created.args.proxy;
  // Shown before the read-back: if the connection drops now, the address is not lost.
  console.log(`Created at ${address}. Checking it...`);
  // Written down too, when asked: the next step then finds it without anyone carrying it over by hand.
  if (process.env.SAFE_ADDRESS_FILE) {
    fs.writeFileSync(process.env.SAFE_ADDRESS_FILE, `${JSON.stringify({ safe: address, owners, threshold, network: network.name, createdAt: new Date().toISOString() }, null, 2)}\n`);
  }

  // Read it back: the owners and threshold must be exactly what was asked for.
  const safe = await ethers.getContractAt(safeAbi, address);
  const got = (await safe.getOwners()).map((o) => o.toLowerCase()).sort();
  if (JSON.stringify(got) !== JSON.stringify(owners.map((o) => o.toLowerCase()).sort()) || Number(await safe.getThreshold()) !== threshold) {
    throw new Error(`The Safe at ${address} does not have the owners or threshold that were asked for. Do not use it.`);
  }
  console.log(`\nSAFE_ADDRESS=${address}\n`);
  if (ownerIsDeployer) console.log('Its one owner is the deployer key: that key is now your admin key. Keep its backup safe.');
  else console.log(owners.length === 1 ? 'One owner only: this is not a multisig yet. Add a second signer in the Safe as soon as you can.' : `Any ${threshold} of the ${owners.length} owners can approve.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
