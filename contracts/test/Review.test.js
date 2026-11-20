// Regression tests for the HEY Research Lab review of commit 0e1396a (16 Nov 2026):
// L-1 weekend vault creation, L-2 payroll recipient cap, and the informational notes for the vaults.
// The hook and LP vault sections were left out with those contracts (see contracts/README.md).
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const LATER = 2n ** 62n; // a deadline far in the future: these tests are not about it

const usd = (n) => ethers.parseUnits(String(n), 18);
const U = (n) => ethers.parseUnits(String(n), 6);
const W = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400, WEEK = 7 * DAY;

describe('Review fixes (HEY Research Lab, 0e1396a)', function () {
  if (process.env.FORK) return;

  describe('AgentVault', () => {
    let admin, owner, operator, usdc, weth, cbbtc, fUsdc, fWeth, fBtc, router, factory, vault;
    beforeEach(async () => {
      [admin, owner, operator] = await ethers.getSigners();
      usdc = await ethers.deployContract('MockToken', ['USD Coin', 'USDC', 6]);
      weth = await ethers.deployContract('MockToken', ['Wrapped Ether', 'WETH', 18]);
      cbbtc = await ethers.deployContract('MockToken', ['cbBTC', 'cbBTC', 8]);
      fUsdc = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
      fWeth = await ethers.deployContract('MockFeed', [8, 2000_0000_0000n]);
      fBtc = await ethers.deployContract('MockFeed', [8, 60000_0000_0000n]);
      router = await ethers.deployContract('MockRouter');
      await router.setRate(weth, cbbtc, 10n ** 18n);
      factory = await ethers.deployContract('AgentVaultFactory', [await router.getAddress(), operator.address,
        [await usdc.getAddress(), await weth.getAddress(), await cbbtc.getAddress()],
        [await fUsdc.getAddress(), await fWeth.getAddress(), await fBtc.getAddress()], [DAY, DAY, DAY], [0, 500, 500], (await ethers.getSigners())[0].address]);
    });

    it('L-1: a vault can be created while a feed is stale (weekend), but swaps still refuse stale prices', async () => {
      await fBtc.set(60000_0000_0000n, (await time.latest()) - 3 * DAY); // like a stock feed over a long weekend
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      expect(await vault.allowedTokens()).to.have.length(3);
      await cbbtc.mint(vault, 10n ** 8n);
      await expect(vault.connect(operator).swap(cbbtc, usdc, 500, 10n ** 8n, 0, LATER)).to.be.revertedWithCustomError(vault, 'StaleOraclePrice');
      await expect(vault.priceUsd(cbbtc)).to.be.revertedWithCustomError(vault, 'StaleOraclePrice');
    });

    it('L-1: setToken accepts a stale feed but still rejects a feed that does not answer a positive price', async () => {
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      const stock = await ethers.deployContract('MockToken', ['Stock', 'STK', 18]);
      const fStock = await ethers.deployContract('MockFeed', [8, 200_0000_0000n]);
      await fStock.set(200_0000_0000n, (await time.latest()) - 3 * DAY);
      await expect(vault.connect(owner).setToken(stock, fStock, DAY, 3000)).to.emit(vault, 'TokenSet');
      const dead = await ethers.deployContract('MockFeed', [8, 0]);
      await expect(vault.connect(owner).setToken(stock, dead, DAY, 3000)).to.be.revertedWithCustomError(vault, 'BadOraclePrice');
    });

    it('I-1: the operator can only swap against the base token, never token to token', async () => {
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      await weth.mint(vault, W(1));
      await expect(vault.connect(operator).swap(weth, cbbtc, 500, W(1), 0, LATER)).to.be.revertedWithCustomError(vault, 'PairNotAllowed');
    });
  });

  describe('PayrollVault', () => {
    let owner, alice, bob, usdg, factory, pr;
    beforeEach(async () => {
      [owner, alice, bob] = await ethers.getSigners();
      usdg = await ethers.deployContract('MockFreezableToken');
      factory = await ethers.deployContract('PayrollFactory', [await usdg.getAddress()]);
      await factory.connect(owner).createPayroll();
      pr = await ethers.getContractAt('PayrollVault', await factory.payrollOf(owner.address));
      await usdg.mint(pr, U(10_000));
    });

    it('L-2: removed recipients free their place under the 100 cap', async () => {
      for (let i = 0; i < 120; i++) {
        await pr.addRecipient(ethers.getAddress('0x' + (0x1000 + i).toString(16).padStart(40, '0')), U(1), 30 * DAY, 0);
        await pr.removeRecipient(i);
      }
      expect(await pr.activeCount()).to.equal(0);
      expect(await pr.recipientCount()).to.equal(120);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.emit(pr, 'RecipientAdded');
    });

    it('L-2: still at most 100 active recipients', async () => {
      for (let i = 0; i < 100; i++) await pr.addRecipient(ethers.getAddress('0x' + (0x2000 + i).toString(16).padStart(40, '0')), U(1), WEEK, 0);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.be.revertedWithCustomError(pr, 'TooManyRecipients');
      await pr.removeRecipient(5);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.emit(pr, 'RecipientAdded');
    });

    it('I-3: resumeAndSkipMissed unpauses without paying the periods missed while paused', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.payAllDue();
      await pr.setPaused(true);
      await time.increase(3 * WEEK + 100);
      await pr.resumeAndSkipMissed();
      expect(await pr.paused()).to.equal(false);
      await expect(pr.pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
      const r = await pr.getRecipient(0);
      expect(r.nextPayAt).to.be.greaterThan(await time.latest());
      expect(r.nextPayAt - BigInt(await time.latest())).to.be.lessThanOrEqual(BigInt(WEEK));
      expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
    });

    it('I-3: plain setPaused(false) still pays every missed period, one per call (documented)', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.payAllDue();
      await pr.setPaused(true);
      await time.increase(2 * WEEK + 100);
      await pr.setPaused(false);
      await pr.pay(0); await pr.pay(0);
      expect(await usdg.balanceOf(alice.address)).to.equal(U(300));
    });

    it('I-4: one recipient that cannot receive does not block payAllDue for the others', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.addRecipient(bob.address, U(200), WEEK, 0);
      await usdg.freeze(alice.address, true);
      await expect(pr.payAllDue()).to.emit(pr, 'PaymentFailed').withArgs(0, alice.address, U(100));
      expect(await usdg.balanceOf(bob.address)).to.equal(U(200));
      expect(await usdg.balanceOf(alice.address)).to.equal(0);
      // alice's period stays due and is paid once she can receive again
      await usdg.freeze(alice.address, false);
      await expect(pr.pay(0)).to.emit(pr, 'Paid');
      expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
      await expect(pr.pay(1)).to.be.revertedWithCustomError(pr, 'NotDue');
    });
  });

});
