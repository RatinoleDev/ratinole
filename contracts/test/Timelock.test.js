// HANDOFF 6.2: the factory and registry admin is a timelock run by the Safe, with a public 3-day delay.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const DAY = 86400;

describe('Admin behind a 3-day timelock', function () {
  if (process.env.FORK) return;

  let safe, operator, newOperator, stranger, timelock, factory, registry;

  beforeEach(async () => {
    [safe, operator, newOperator, stranger] = await ethers.getSigners();
    // In production `safe` is the Ratinole Safe multisig; here it is a plain account.
    timelock = await ethers.deployContract('RatinoleTimelock', [3 * DAY, [safe.address], [safe.address], ethers.ZeroAddress]);
    const usdc = await ethers.deployContract('MockToken', ['USD Coin', 'USDC', 6]);
    const feed = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
    const router = await ethers.deployContract('MockRouter');
    factory = await ethers.deployContract('AgentVaultFactory', [
      await router.getAddress(), operator.address, [await usdc.getAddress()], [await feed.getAddress()], [DAY], [0], await timelock.getAddress(),
    ]);
    registry = await ethers.deployContract('DecisionRegistry', [await timelock.getAddress(), operator.address]);
  });

  async function scheduleAndRun(target, data, wait) {
    const salt = ethers.id(`op-${Date.now()}-${Math.random()}`);
    await timelock.connect(safe).schedule(target, 0, data, ethers.ZeroHash, salt, 3 * DAY);
    if (wait) await time.increase(wait);
    return timelock.connect(safe).execute(target, 0, data, ethers.ZeroHash, salt);
  }

  it('nobody can call the factory admin directly, not even the Safe', async () => {
    await expect(factory.connect(safe).setDefaultOperator(newOperator.address)).to.be.revertedWithCustomError(factory, 'NotAdmin');
    await expect(registry.connect(safe).setPoster(newOperator.address)).to.be.revertedWithCustomError(registry, 'NotAdmin');
  });

  it('an admin change runs only after three days in the queue', async () => {
    const data = factory.interface.encodeFunctionData('setDefaultOperator', [newOperator.address]);
    await expect(scheduleAndRun(await factory.getAddress(), data, 0)).to.be.revertedWithCustomError(timelock, 'TimelockUnexpectedOperationState');
    await expect(scheduleAndRun(await factory.getAddress(), data, 3 * DAY)).to.emit(factory, 'DefaultOperatorChanged');
    expect(await factory.defaultOperator()).to.equal(newOperator.address);
  });

  it('the registry poster rotates the same way', async () => {
    const data = registry.interface.encodeFunctionData('setPoster', [newOperator.address]);
    await expect(scheduleAndRun(await registry.getAddress(), data, 3 * DAY)).to.emit(registry, 'PosterChanged');
    expect(await registry.poster()).to.equal(newOperator.address);
  });

  it('only the Safe can queue or run operations', async () => {
    const data = factory.interface.encodeFunctionData('setDefaultOperator', [stranger.address]);
    await expect(timelock.connect(stranger).schedule(await factory.getAddress(), 0, data, ethers.ZeroHash, ethers.id('x'), 3 * DAY))
      .to.be.revertedWithCustomError(timelock, 'AccessControlUnauthorizedAccount');
  });

  it('the delay itself can only be changed through the timelock', async () => {
    await expect(timelock.connect(safe).updateDelay(DAY)).to.be.revertedWithCustomError(timelock, 'TimelockUnauthorizedCaller');
  });
});
