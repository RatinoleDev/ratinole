// Rehearses the Phase 3 "done" bar on a local fork of Robinhood Chain (real pools and Chainlink feeds, fake
// money, nothing is sent): deploy with the timelock and Safe, a $10 vault, one sell and one buy by the operator,
// both decisions recorded in the registry and verified, an admin change through the 3-day timelock, and a
// full withdrawal by the owner.
//   pnpm --filter @rationale/contracts test:fork
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const netConfig = require('../scripts/netconfig');
const { deployAll, DAY } = require('../scripts/lib/deploy');

const coder = ethers.AbiCoder.defaultAbiCoder();
const leaf = (decisionId, agentId, hour, contentHash) =>
  ethers.keccak256(ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'uint64', 'bytes32'], [decisionId, agentId, hour, contentHash])));
const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

describe('Phase 3 rehearsal on a Robinhood Chain fork', function () {
  if (!process.env.FORK) return;

  const cfg = netConfig(network.name);
  const T = Object.fromEntries(cfg.tokens.map((t) => [t.symbol, t]));
  let deployer, safe, operator, poster, owner, newOperator, d, vault, weth, usdg;

  before(async () => {
    [deployer, safe, operator, poster, owner, newOperator] = await ethers.getSigners();
    d = await deployAll({ ethers, deployer, safe: safe.address, operator: operator.address, poster: poster.address, delay: 3 * DAY, cfg });
    weth = await ethers.getContractAt(['function deposit() payable', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], T.WETH.address);
    usdg = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], T.USDG.address);
  });

  it('deploys with every admin power behind the timelock', async () => {
    expect(await d.contracts.factory.admin()).to.equal(d.timelock);
    expect(await d.contracts.registry.admin()).to.equal(d.timelock);
  });

  it('a $10 vault: one sell and one buy through the real pools', async () => {
    await d.contracts.factory.connect(owner).createVault(100, ethers.parseUnits('25', 18)); // 1% slippage, $25 a day
    vault = await ethers.getContractAt('AgentVault', await d.contracts.factory.vaultOf(owner.address));
    const ethPrice = await vault.priceUsd(T.WETH.address); // 18 decimals
    const tenDollars = (ethers.parseUnits('10', 18) * 10n ** 18n) / ethPrice;
    await weth.connect(owner).deposit({ value: tenDollars });
    await weth.connect(owner).transfer(await vault.getAddress(), tenDollars);
    console.log(`      deposited ${ethers.formatEther(tenDollars)} WETH (~$10 at $${Number(ethers.formatUnits(ethPrice, 18)).toFixed(2)})`);

    const sell = await (await vault.connect(operator).swap(T.WETH.address, T.USDG.address, T.WETH.feeTier, tenDollars, 0)).wait();
    const got = await usdg.balanceOf(await vault.getAddress());
    console.log(`      sold for ${ethers.formatUnits(got, await usdg.decimals())} USDG`);
    expect(got).to.be.gt(0n);
    const buy = await (await vault.connect(operator).swap(T.USDG.address, T.WETH.address, T.WETH.feeTier, got, 0)).wait();
    console.log(`      bought back ${ethers.formatEther(await weth.balanceOf(await vault.getAddress()))} WETH`);

    // Record both decisions for this hour and verify them, as the engine and the site will.
    const now = await time.latest();
    const hour = BigInt(now - (now % 3600));
    const agent = ethers.id('agent-rehearsal');
    const leaves = [
      leaf(ethers.id('decision-sell'), agent, hour, ethers.keccak256(ethers.toUtf8Bytes(sell.hash))),
      leaf(ethers.id('decision-buy'), agent, hour, ethers.keccak256(ethers.toUtf8Bytes(buy.hash))),
    ];
    const root = hashPair(leaves[0], leaves[1]);
    await expect(d.contracts.registry.connect(poster).post(hour, root, 2)).to.emit(d.contracts.registry, 'RootPosted');
    expect(await d.contracts.registry.verify(hour, leaves[0], [leaves[1]])).to.equal(true);
    expect(await d.contracts.registry.verify(hour, leaves[1], [leaves[0]])).to.equal(true);
  });

  it('the Safe rotates the operator for new vaults only after three days; existing vaults keep theirs', async () => {
    const data = d.contracts.factory.interface.encodeFunctionData('setDefaultOperator', [newOperator.address]);
    const salt = ethers.id('rotate-operator');
    await d.contracts.timelock.connect(safe).schedule(d.factory, 0, data, ethers.ZeroHash, salt, 3 * DAY);
    await expect(d.contracts.timelock.connect(safe).execute(d.factory, 0, data, ethers.ZeroHash, salt)).to.be.reverted;
    await time.increase(3 * DAY);
    await d.contracts.timelock.connect(safe).execute(d.factory, 0, data, ethers.ZeroHash, salt);
    expect(await d.contracts.factory.defaultOperator()).to.equal(newOperator.address);
    expect(await vault.operator()).to.equal(operator.address);
  });

  it('the owner withdraws everything', async () => {
    const bal = await weth.balanceOf(await vault.getAddress());
    await vault.connect(owner).withdraw(T.WETH.address, bal, owner.address);
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(0n);
  });
});
