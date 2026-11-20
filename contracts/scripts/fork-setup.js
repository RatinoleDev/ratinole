// LOCAL FORK ONLY. Sets up a rehearsal of live trading on a local copy of Robinhood Chain: deploys the contracts
// with Hardhat's public test accounts and gives a wallet fake ETH and USDG (bought through the real pool on the
// fork). Nothing is sent to the real chain, and it refuses to run against one.
//
//   Terminal 1:  FORK=1 pnpm --filter @rationale/contracts exec hardhat node
//   Terminal 2:  pnpm --filter @rationale/contracts exec hardhat run scripts/fork-setup.js --network localhost
//
// Options (environment): FUND=0xWallet to fund that wallet instead of test account 4; USD=200 for the amount;
// VAULT=1 to also create a vault for test account 4 and move the USDG into it.
const { ethers, network } = require('hardhat');
const netConfig = require('./netconfig');
const { deployAll, DAY } = require('./lib/deploy');

const TEST_MNEMONIC = 'test test test test test test test test test test test junk'; // Hardhat's public test accounts

async function main() {
  if (network.name !== 'localhost') throw new Error('fork-setup only runs against a local node (--network localhost)');
  const client = await ethers.provider.send('web3_clientVersion', []);
  if (!/hardhat/i.test(client)) throw new Error(`Refusing to run: the node is not a Hardhat fork (${client})`);

  const cfg = netConfig(network.name);
  const T = Object.fromEntries(cfg.tokens.map((t) => [t.symbol, t]));
  const [deployer, safe, operator, poster, owner] = await ethers.getSigners();
  const d = await deployAll({ ethers, deployer, safe: safe.address, operator: operator.address, poster: poster.address, delay: 3 * DAY, cfg });

  const target = process.env.FUND || owner.address;
  const usd = Number(process.env.USD || 200);
  const weth = await ethers.getContractAt(['function deposit() payable', 'function approve(address,uint256) returns (bool)'], T.WETH.address);
  const usdg = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], T.USDG.address);
  const router = await ethers.getContractAt(
    ['function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'],
    cfg.router,
  );
  // Buy exactly `usd` USDG for the wallet with wrapped test ETH, through the real WETH/USDG pool.
  const spend = ethers.parseEther('5');
  await (await weth.connect(deployer).deposit({ value: spend })).wait();
  await (await weth.connect(deployer).approve(cfg.router, spend)).wait();
  await (
    await router.connect(deployer).exactOutputSingle({
      tokenIn: T.WETH.address, tokenOut: T.USDG.address, fee: T.WETH.feeTier, recipient: target,
      amountOut: ethers.parseUnits(String(usd), 6), amountInMaximum: spend, sqrtPriceLimitX96: 0,
    })
  ).wait();
  if (target.toLowerCase() !== owner.address.toLowerCase()) await (await deployer.sendTransaction({ to: target, value: ethers.parseEther('1') })).wait();

  let vault = null;
  if (process.env.VAULT) {
    await (await d.contracts.factory.connect(owner).createVault(100, ethers.parseUnits('1000', 18))).wait();
    vault = await d.contracts.factory.vaultOf(owner.address);
    await (await usdg.connect(owner).transfer(vault, await usdg.balanceOf(owner.address))).wait();
  }

  const operatorKey = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0/2").privateKey;
  console.log(JSON.stringify({ factory: d.factory, registry: d.registry, timelock: d.timelock, operator: operator.address, operatorKey, owner: owner.address, funded: target, usd, vault }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
