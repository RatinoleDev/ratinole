// Ratinole additions to AgentVault: two-step ownership transfer and a recovery wallet with a delay (HANDOFF 6.1).
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const usd = (n) => ethers.parseUnits(String(n), 18);
const U = (n) => ethers.parseUnits(String(n), 6);
const W = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400;

describe('AgentVault ownership and recovery', function () {
  if (process.env.FORK) return;

  let admin, owner, operator, newOwner, rescue, stranger, usdc, weth, fUsdc, fWeth, router, factory, vault;

  beforeEach(async () => {
    [admin, owner, operator, newOwner, rescue, stranger] = await ethers.getSigners();
    usdc = await ethers.deployContract('MockToken', ['USD Coin', 'USDC', 6]);
    weth = await ethers.deployContract('MockToken', ['Wrapped Ether', 'WETH', 18]);
    fUsdc = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
    fWeth = await ethers.deployContract('MockFeed', [8, 2000_0000_0000n]);
    router = await ethers.deployContract('MockRouter');
    await router.setRate(usdc, weth, 5n * 10n ** 26n);
    await router.setRate(weth, usdc, 2n * 10n ** 9n);
    await usdc.mint(router, U(1_000_000));
    await weth.mint(router, W(1_000));
    factory = await ethers.deployContract('AgentVaultFactory', [
      await router.getAddress(), operator.address,
      [await usdc.getAddress(), await weth.getAddress()], [await fUsdc.getAddress(), await fWeth.getAddress()], [DAY, 3600], [0, 500],
      admin.address,
    ]);
    await factory.connect(owner).createVault(100, usd(10_000));
    vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
    await usdc.mint(vault, U(5_000));
  });

  describe('two-step transfer', () => {
    it('moves only when the new owner accepts; the factory follows the vault', async () => {
      await expect(vault.connect(owner).transferOwnership(newOwner.address))
        .to.emit(vault, 'OwnershipTransferStarted').withArgs(owner.address, newOwner.address);
      expect(await vault.owner()).to.equal(owner.address); // nothing moves yet
      await expect(vault.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(vault, 'NotPendingOwner');
      await expect(vault.connect(newOwner).acceptOwnership())
        .to.emit(vault, 'OwnershipTransferred').withArgs(owner.address, newOwner.address)
        .and.to.emit(factory, 'VaultOwnerChanged').withArgs(await vault.getAddress(), owner.address, newOwner.address);
      expect(await vault.owner()).to.equal(newOwner.address);
      expect(await vault.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await factory.vaultOf(newOwner.address)).to.equal(await vault.getAddress());
      expect(await factory.vaultOf(owner.address)).to.equal(ethers.ZeroAddress);
    });

    it('the old owner loses every power; the new owner can withdraw', async () => {
      await vault.connect(owner).transferOwnership(newOwner.address);
      await vault.connect(newOwner).acceptOwnership();
      await expect(vault.connect(owner).withdraw(usdc, U(1), owner.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(owner).setPaused(true)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(newOwner).withdraw(usdc, U(5_000), newOwner.address)).to.emit(vault, 'Withdrawn');
      expect(await usdc.balanceOf(newOwner.address)).to.equal(U(5_000));
    });

    it('the previous owner can open a new vault after handing the old one over', async () => {
      await vault.connect(owner).transferOwnership(newOwner.address);
      await vault.connect(newOwner).acceptOwnership();
      await expect(factory.connect(owner).createVault(100, usd(1_000))).to.emit(factory, 'VaultCreated');
    });

    it('a wallet that already owns a vault cannot accept another', async () => {
      await factory.connect(newOwner).createVault(100, usd(1_000));
      await vault.connect(owner).transferOwnership(newOwner.address);
      await expect(vault.connect(newOwner).acceptOwnership()).to.be.revertedWithCustomError(factory, 'VaultExists');
      expect(await vault.owner()).to.equal(owner.address);
    });

    it('only the owner can start a transfer, and address(0) cancels it', async () => {
      await expect(vault.connect(operator).transferOwnership(operator.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await vault.connect(owner).transferOwnership(newOwner.address);
      await vault.connect(owner).transferOwnership(ethers.ZeroAddress);
      await expect(vault.connect(newOwner).acceptOwnership()).to.be.revertedWithCustomError(vault, 'NotPendingOwner');
    });

    it('only vaults created by the factory can report an owner change', async () => {
      await expect(factory.connect(stranger).onOwnerChanged(owner.address, stranger.address)).to.be.revertedWithCustomError(factory, 'NotVault');
    });
  });

  describe('recovery wallet', () => {
    it('claims the vault only after the delay', async () => {
      await expect(vault.connect(owner).setRecovery(rescue.address, 7 * DAY)).to.emit(vault, 'RecoverySet').withArgs(rescue.address, 7 * DAY);
      await expect(vault.connect(rescue).completeRecovery()).to.be.revertedWithCustomError(vault, 'RecoveryNotReady');
      await expect(vault.connect(rescue).startRecovery()).to.emit(vault, 'RecoveryStarted');
      await time.increase(7 * DAY - 60);
      await expect(vault.connect(rescue).completeRecovery()).to.be.revertedWithCustomError(vault, 'RecoveryNotReady');
      await time.increase(120);
      await expect(vault.connect(rescue).completeRecovery()).to.emit(vault, 'OwnershipTransferred').withArgs(owner.address, rescue.address);
      expect(await vault.owner()).to.equal(rescue.address);
      expect(await factory.vaultOf(rescue.address)).to.equal(await vault.getAddress());
      await expect(vault.connect(owner).withdraw(usdc, U(1), owner.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
    });

    it('the owner can cancel a claim during the delay', async () => {
      await vault.connect(owner).setRecovery(rescue.address, 3 * DAY);
      await vault.connect(rescue).startRecovery();
      await expect(vault.connect(owner).cancelRecovery()).to.emit(vault, 'RecoveryCancelled');
      await time.increase(4 * DAY);
      await expect(vault.connect(rescue).completeRecovery()).to.be.revertedWithCustomError(vault, 'RecoveryNotReady');
      expect(await vault.owner()).to.equal(owner.address);
    });

    it('only the recovery wallet can start or complete a claim', async () => {
      await vault.connect(owner).setRecovery(rescue.address, 3 * DAY);
      await expect(vault.connect(stranger).startRecovery()).to.be.revertedWithCustomError(vault, 'NotRecovery');
      await expect(vault.connect(operator).startRecovery()).to.be.revertedWithCustomError(vault, 'NotRecovery');
      await vault.connect(rescue).startRecovery();
      await time.increase(3 * DAY);
      await expect(vault.connect(stranger).completeRecovery()).to.be.revertedWithCustomError(vault, 'NotRecovery');
    });

    it('delays outside 2 to 90 days are refused; the owner cannot be their own recovery', async () => {
      await expect(vault.connect(owner).setRecovery(rescue.address, DAY)).to.be.revertedWithCustomError(vault, 'BadRecoveryDelay');
      await expect(vault.connect(owner).setRecovery(rescue.address, 91 * DAY)).to.be.revertedWithCustomError(vault, 'BadRecoveryDelay');
      await expect(vault.connect(owner).setRecovery(owner.address, 3 * DAY)).to.be.revertedWithCustomError(vault, 'BadRecoveryWallet');
      await expect(vault.connect(operator).setRecovery(operator.address, 3 * DAY)).to.be.revertedWithCustomError(vault, 'NotOwner');
    });

    it('turning recovery off or changing it cancels a claim in progress', async () => {
      await vault.connect(owner).setRecovery(rescue.address, 3 * DAY);
      await vault.connect(rescue).startRecovery();
      await vault.connect(owner).setRecovery(ethers.ZeroAddress, 0);
      await time.increase(4 * DAY);
      await expect(vault.connect(rescue).completeRecovery()).to.be.revertedWithCustomError(vault, 'NotRecovery');
    });

    it("a new owner starts clean: the previous owner's recovery wallet has no power", async () => {
      await vault.connect(owner).setRecovery(rescue.address, 3 * DAY);
      await vault.connect(owner).transferOwnership(newOwner.address);
      await vault.connect(newOwner).acceptOwnership();
      expect(await vault.recovery()).to.equal(ethers.ZeroAddress);
      await expect(vault.connect(rescue).startRecovery()).to.be.revertedWithCustomError(vault, 'NotRecovery');
    });

    it('the operator still only swaps, whoever owns the vault', async () => {
      await vault.connect(owner).setRecovery(rescue.address, 3 * DAY);
      await vault.connect(rescue).startRecovery();
      await time.increase(3 * DAY);
      await vault.connect(rescue).completeRecovery();
      const now = await time.latest(); // three days passed: give the feeds a fresh answer
      await fUsdc.set(1_0000_0000n, now);
      await fWeth.set(2000_0000_0000n, now);
      await expect(vault.connect(operator).withdraw(usdc, U(1), operator.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(100), 0)).to.emit(vault, 'Swapped');
    });
  });
});
