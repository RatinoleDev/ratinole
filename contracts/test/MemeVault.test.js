const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const LATER = 2n ** 62n; // a deadline far in the future: most of these tests are not about it
const E = (n) => ethers.parseEther(String(n));
const ZERO = ethers.ZeroAddress;

describe('MemeVault', function () {
  if (process.env.FORK) return; // unit tests run on the local network only

  let admin, owner, operator, stranger, friend, factory, vault, venue, token, other;

  const deploy = async (name, ...args) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    return c;
  };
  const ethOf = (a) => ethers.provider.getBalance(a);

  beforeEach(async () => {
    [admin, owner, operator, stranger, friend] = await ethers.getSigners();
    token = await deploy('MockToken', 'Meme', 'MEME', 18);
    other = await deploy('MockToken', 'Other', 'OTH', 18);
    venue = await deploy('MockMemeVenue');
    await venue.setSupported(token, true);
    await admin.sendTransaction({ to: venue, value: E(50) }); // what the venue pays sales from
    factory = await deploy('MemeVaultFactory', operator.address, admin.address, [await venue.getAddress()]);
    await factory.connect(owner).createVault(E(5)); // the agent may spend 5 ETH a day
    vault = await ethers.getContractAt('MemeVault', await factory.vaultOf(owner.address));
    await owner.sendTransaction({ to: vault, value: E(10) });
    await vault.connect(owner).allowToken(token, venue, E(3)); // and 3 ETH on this token
  });

  describe('factory', () => {
    it('creates one vault per wallet, owned by the caller, with the default operator', async () => {
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.operator()).to.equal(operator.address);
      expect(await vault.factory()).to.equal(await factory.getAddress());
      expect(await vault.dailyBuyLimitWei()).to.equal(E(5));
      expect(await factory.isVault(vault)).to.equal(true);
      await expect(factory.connect(owner).createVault(E(1))).to.be.revertedWithCustomError(factory, 'VaultExists');
    });

    it('lets only the admin list venues and change the default operator', async () => {
      const v2 = await deploy('MockMemeVenue');
      await expect(factory.connect(stranger).setVenue(v2, true)).to.be.revertedWithCustomError(factory, 'NotAdmin');
      await expect(factory.connect(owner).setDefaultOperator(stranger.address)).to.be.revertedWithCustomError(factory, 'NotAdmin');
      await expect(factory.setVenue(stranger.address, true)).to.be.revertedWithCustomError(factory, 'NotAContract');
      await expect(factory.setVenue(ZERO, true)).to.be.revertedWithCustomError(factory, 'ZeroAddress');
      await factory.setVenue(v2, true);
      expect(await factory.venues()).to.deep.equal([await venue.getAddress(), await v2.getAddress()]);
      await factory.setVenue(venue, false);
      expect(await factory.venues()).to.deep.equal([await v2.getAddress()]);
      expect(await factory.isVenue(venue)).to.equal(false);
    });

    it('a new default operator reaches new vaults only', async () => {
      await factory.setDefaultOperator(friend.address);
      await factory.connect(stranger).createVault(E(1));
      const theirs = await ethers.getContractAt('MemeVault', await factory.vaultOf(stranger.address));
      expect(await theirs.operator()).to.equal(friend.address);
      expect(await vault.operator()).to.equal(operator.address);
    });

    it('hands the admin role over in two steps', async () => {
      await factory.transferAdmin(friend.address);
      await expect(factory.connect(stranger).acceptAdmin()).to.be.revertedWithCustomError(factory, 'NotAdmin');
      await factory.connect(friend).acceptAdmin();
      expect(await factory.admin()).to.equal(friend.address);
      await expect(factory.setDefaultOperator(admin.address)).to.be.revertedWithCustomError(factory, 'NotAdmin');
    });

    it('unlisting a venue does not reach into a vault that already uses it', async () => {
      await factory.setVenue(venue, false);
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      expect(await token.balanceOf(vault)).to.equal(E(1000));
      // but nothing new can be allowed on it
      await venue.setSupported(other, true);
      await expect(vault.connect(owner).allowToken(other, venue, E(1))).to.be.revertedWithCustomError(vault, 'VenueNotListed');
    });
  });

  describe('what the owner controls', () => {
    it('allows a token only on a listed venue that knows it', async () => {
      const rogue = await deploy('MockMemeVenue');
      await rogue.setSupported(other, true);
      await expect(vault.connect(owner).allowToken(other, rogue, E(1))).to.be.revertedWithCustomError(vault, 'VenueNotListed');
      await expect(vault.connect(owner).allowToken(other, venue, E(1))).to.be.revertedWithCustomError(vault, 'VenueDoesNotSupport');
      await expect(vault.connect(owner).allowToken(ZERO, venue, E(1))).to.be.revertedWithCustomError(vault, 'ZeroAddress');
      await venue.setSupported(other, true);
      await expect(vault.connect(owner).allowToken(other, venue, E(1))).to.emit(vault, 'TokenAllowed').withArgs(await other.getAddress(), await venue.getAddress(), E(1));
      expect(await vault.allowedTokens()).to.deep.equal([await token.getAddress(), await other.getAddress()]);
    });

    it('allowing a token again replaces its budget, and does not list it twice', async () => {
      await vault.connect(owner).allowToken(token, venue, E(0.5));
      expect((await vault.rules(token)).budgetLeftWei).to.equal(E(0.5));
      expect(await vault.allowedTokens()).to.deep.equal([await token.getAddress()]);
    });

    it('nobody but the owner changes anything', async () => {
      for (const who of [operator, stranger]) {
        const v = vault.connect(who);
        await expect(v.allowToken(token, venue, E(9))).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.removeToken(token)).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.setOperator(who.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.setDailyBuyLimit(E(100))).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.setPaused(false)).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.withdraw(ZERO, E(1), who.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
        await expect(v.withdraw(token, 1, who.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      }
    });

    it('withdraws ETH and tokens at any time, also while paused', async () => {
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      await vault.connect(owner).setPaused(true);
      const before = await ethOf(friend.address);
      await expect(vault.connect(owner).withdraw(ZERO, E(4), friend.address)).to.emit(vault, 'Withdrawn').withArgs(ZERO, friend.address, E(4));
      expect((await ethOf(friend.address)) - before).to.equal(E(4));
      await vault.connect(owner).withdraw(token, E(1000), friend.address);
      expect(await token.balanceOf(friend.address)).to.equal(E(1000));
      await expect(vault.connect(owner).withdraw(ZERO, E(1), ZERO)).to.be.revertedWithCustomError(vault, 'ZeroAddress');
    });

    it('says so when a withdrawal of ETH cannot be delivered', async () => {
      const refuses = await deploy('RefusesEth');
      await expect(vault.connect(owner).withdraw(ZERO, E(1), refuses)).to.be.revertedWithCustomError(vault, 'EthTransferFailed');
      await expect(vault.connect(owner).withdraw(ZERO, E(11), friend.address)).to.be.revertedWithCustomError(vault, 'EthTransferFailed');
    });

    it('removing a token stops the agent trading it, and leaves the tokens for the owner', async () => {
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      await expect(vault.connect(owner).removeToken(token)).to.emit(vault, 'TokenRemoved');
      await expect(vault.connect(owner).removeToken(token)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      expect(await vault.allowedTokens()).to.deep.equal([]);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      await expect(vault.connect(operator).sell(token, E(1000), 1, LATER)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      await vault.connect(owner).withdraw(token, E(1000), owner.address);
      expect(await token.balanceOf(owner.address)).to.equal(E(1000));
    });

    it('switching the operator off stops every trade', async () => {
      await vault.connect(owner).setOperator(ZERO);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
      await expect(vault.connect(operator).sell(token, 1, 1, LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
    });

    it('holds at most 50 tokens', async () => {
      for (let i = 0; i < 49; i++) {
        const t = await deploy('MockToken', `T${i}`, `T${i}`, 18);
        await venue.setSupported(t, true);
        await vault.connect(owner).allowToken(t, venue, 1);
      }
      await venue.setSupported(other, true);
      await expect(vault.connect(owner).allowToken(other, venue, 1)).to.be.revertedWithCustomError(vault, 'TooManyTokens');
      // an existing one can still be changed
      await vault.connect(owner).allowToken(token, venue, E(1));
    });
  });

  describe('buying', () => {
    it('spends the vault\'s ETH, receives the tokens, and counts both limits down', async () => {
      const before = await ethOf(vault);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER))
        .to.emit(vault, 'Bought')
        .withArgs(await token.getAddress(), await venue.getAddress(), E(1), E(1000));
      expect(before - (await ethOf(vault))).to.equal(E(1));
      expect(await token.balanceOf(vault)).to.equal(E(1000));
      expect((await vault.rules(token)).budgetLeftWei).to.equal(E(2));
      expect(await vault.remainingDailyWei()).to.equal(E(4));
    });

    it('reports what it bought and what it spent', async () => {
      const [tokensOut, ethSpent] = await vault.connect(operator).buy.staticCall(token, E(1), E(1000), LATER);
      expect(tokensOut).to.equal(E(1000));
      expect(ethSpent).to.equal(E(1));
    });

    it('is the operator\'s alone', async () => {
      await expect(vault.connect(owner).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
      await expect(vault.connect(stranger).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
    });

    it('refuses an order past its deadline, while paused, for nothing, or for a token not allowed', async () => {
      const now = await time.latest();
      await expect(vault.connect(operator).buy(token, E(1), E(1000), now - 1)).to.be.revertedWithCustomError(vault, 'OrderExpired');
      await expect(vault.connect(operator).buy(token, 0, E(1000), LATER)).to.be.revertedWithCustomError(vault, 'ZeroAmount');
      await expect(vault.connect(operator).buy(token, E(1), 0, LATER)).to.be.revertedWithCustomError(vault, 'ZeroAmount');
      await expect(vault.connect(operator).buy(other, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      await vault.connect(owner).setPaused(true);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'Paused');
    });

    it('cannot spend more on a token than its budget, in one buy or in several', async () => {
      await expect(vault.connect(operator).buy(token, E(3.01), E(3010), LATER)).to.be.revertedWithCustomError(vault, 'BudgetExceeded');
      await vault.connect(operator).buy(token, E(2), E(2000), LATER);
      await expect(vault.connect(operator).buy(token, E(1.5), E(1500), LATER)).to.be.revertedWithCustomError(vault, 'BudgetExceeded').withArgs(E(1.5), E(1));
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      await expect(vault.connect(operator).buy(token, 1, 1, LATER)).to.be.revertedWithCustomError(vault, 'BudgetExceeded');
    });

    it('selling does not give the budget back', async () => {
      await vault.connect(operator).buy(token, E(3), E(3000), LATER);
      await vault.connect(operator).sell(token, E(3000), E(3), LATER);
      await expect(vault.connect(operator).buy(token, E(0.1), E(100), LATER)).to.be.revertedWithCustomError(vault, 'BudgetExceeded');
    });

    it('cannot spend more than the daily limit across tokens, until a new day', async () => {
      await venue.setSupported(other, true);
      await vault.connect(owner).allowToken(other, venue, E(10));
      await vault.connect(operator).buy(token, E(3), E(3000), LATER);
      await expect(vault.connect(operator).buy(other, E(2.5), E(2500), LATER)).to.be.revertedWithCustomError(vault, 'DailyLimitExceeded').withArgs(E(2.5), E(2));
      await vault.connect(operator).buy(other, E(2), E(2000), LATER);
      expect(await vault.remainingDailyWei()).to.equal(0);
      await time.increase(24 * 3600 + 1);
      expect(await vault.remainingDailyWei()).to.equal(E(5));
      await vault.connect(operator).buy(other, E(4), E(4000), LATER);
      expect(await vault.remainingDailyWei()).to.equal(E(1));
    });

    it('a daily limit of zero stops buying and still lets the agent sell', async () => {
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      await vault.connect(owner).setDailyBuyLimit(0);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'DailyLimitExceeded');
      await vault.connect(operator).sell(token, E(1000), E(1), LATER);
    });

    it('when only part of the ETH can be spent, the rest comes back and only the part spent is counted', async () => {
      await venue.setFill(4000, 10000); // the venue uses 40% of a buy
      const before = await ethOf(vault);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER))
        .to.emit(vault, 'Bought')
        .withArgs(await token.getAddress(), await venue.getAddress(), E(0.4), E(400));
      expect(before - (await ethOf(vault))).to.equal(E(0.4));
      expect((await vault.rules(token)).budgetLeftWei).to.equal(E(2.6));
      expect(await vault.remainingDailyWei()).to.equal(E(4.6));
    });

    it('a partial fill still has to meet the price that was asked for', async () => {
      await venue.setFill(4000, 10000);
      await venue.setRate(E(900)); // 10% worse than the 1000 per ETH asked for
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'InsufficientOutput');
    });

    it('refuses a buy that returns fewer tokens than the minimum, and the ETH stays', async () => {
      await venue.setMode(2); // gives half
      const before = await ethOf(vault);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'InsufficientOutput').withArgs(E(500), E(1000));
      expect(await ethOf(vault)).to.equal(before);
      expect((await vault.rules(token)).budgetLeftWei).to.equal(E(3));
    });

    it('a venue that keeps the ETH and gives nothing gets nothing: the buy fails whole', async () => {
      await venue.setMode(1);
      const before = await ethOf(vault);
      await expect(vault.connect(operator).buy(token, E(1), 1, LATER)).to.be.revertedWithCustomError(vault, 'NothingBought');
      expect(await ethOf(vault)).to.equal(before);
    });

    it('a venue cannot use the vault from inside a trade', async () => {
      await venue.setMode(3);
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.reverted;
      // even if the venue were the operator, the vault is closed while a trade is running
      await vault.connect(owner).setOperator(venue);
      await owner.sendTransaction({ to: venue, value: E(1) });
      await expect(vault.connect(operator).buy(token, E(1), E(1000), LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
    });

    it('cannot spend ETH the vault does not hold', async () => {
      await vault.connect(owner).allowToken(token, venue, E(100));
      await vault.connect(owner).setDailyBuyLimit(E(100));
      await expect(vault.connect(operator).buy(token, E(11), E(11000), LATER)).to.be.reverted;
    });
  });

  describe('selling', () => {
    beforeEach(async () => {
      await vault.connect(operator).buy(token, E(2), E(2000), LATER);
    });

    it('sells tokens for ETH that stays in the vault, and leaves the venue no approval', async () => {
      const before = await ethOf(vault);
      await expect(vault.connect(operator).sell(token, E(500), E(0.5), LATER))
        .to.emit(vault, 'Sold')
        .withArgs(await token.getAddress(), await venue.getAddress(), E(500), E(0.5));
      expect((await ethOf(vault)) - before).to.equal(E(0.5));
      expect(await token.balanceOf(vault)).to.equal(E(1500));
      expect(await token.allowance(vault, venue)).to.equal(0);
      expect(await vault.connect(operator).sell.staticCall(token, E(500), E(0.5), LATER)).to.equal(E(0.5));
    });

    it('needs no budget: a token with nothing left to spend can still be sold', async () => {
      await vault.connect(owner).allowToken(token, venue, 0);
      await vault.connect(operator).sell(token, E(2000), E(2), LATER);
      expect(await token.balanceOf(vault)).to.equal(0);
    });

    it('is the operator\'s alone, and follows the same rules as a buy', async () => {
      await expect(vault.connect(owner).sell(token, E(1), 1, LATER)).to.be.revertedWithCustomError(vault, 'NotOperator');
      await expect(vault.connect(operator).sell(token, 0, 1, LATER)).to.be.revertedWithCustomError(vault, 'ZeroAmount');
      await expect(vault.connect(operator).sell(token, E(1), 0, LATER)).to.be.revertedWithCustomError(vault, 'ZeroAmount');
      await expect(vault.connect(operator).sell(token, E(1), 1, (await time.latest()) - 1)).to.be.revertedWithCustomError(vault, 'OrderExpired');
      await vault.connect(owner).setPaused(true);
      await expect(vault.connect(operator).sell(token, E(1), 1, LATER)).to.be.revertedWithCustomError(vault, 'Paused');
    });

    it('refuses a sale that returns less ETH than the minimum, and the tokens stay', async () => {
      await venue.setMode(2); // pays half
      await expect(vault.connect(operator).sell(token, E(1000), E(1), LATER)).to.be.revertedWithCustomError(vault, 'InsufficientOutput').withArgs(E(0.5), E(1));
      expect(await token.balanceOf(vault)).to.equal(E(2000));
    });

    it('a venue that takes the tokens and pays nothing gets nothing', async () => {
      await venue.setMode(1);
      await expect(vault.connect(operator).sell(token, E(1000), 1, LATER)).to.be.revertedWithCustomError(vault, 'NothingSold');
      expect(await token.balanceOf(vault)).to.equal(E(2000));
    });

    it('a venue cannot take more tokens than the sale was for', async () => {
      await venue.setMode(4);
      await expect(vault.connect(operator).sell(token, E(1000), 1, LATER)).to.be.reverted;
      expect(await token.balanceOf(vault)).to.equal(E(2000));
    });

    it('when only part is sold, the price asked for holds for that part', async () => {
      await venue.setFill(10000, 5000); // the venue takes half
      await vault.connect(operator).sell(token, E(1000), E(1), LATER);
      expect(await token.balanceOf(vault)).to.equal(E(1500));
      await venue.setRate(E(1250)); // 20% less ETH per token
      await expect(vault.connect(operator).sell(token, E(1000), E(1), LATER)).to.be.revertedWithCustomError(vault, 'InsufficientOutput');
    });

    it('cannot sell tokens the vault does not hold', async () => {
      await expect(vault.connect(operator).sell(token, E(2001), 1, LATER)).to.be.reverted;
    });
  });

  describe('what the operator can never do', () => {
    it('take ETH or tokens out, by any call it has', async () => {
      await vault.connect(operator).buy(token, E(1), E(1000), LATER);
      const iface = vault.interface;
      const sends = [
        iface.encodeFunctionData('withdraw', [ZERO, E(1), operator.address]),
        iface.encodeFunctionData('withdraw', [await token.getAddress(), E(1), operator.address]),
        iface.encodeFunctionData('setOperator', [stranger.address]),
        iface.encodeFunctionData('allowToken', [await other.getAddress(), await venue.getAddress(), E(9)]),
        iface.encodeFunctionData('setDailyBuyLimit', [E(1000)]),
      ];
      for (const data of sends) await expect(operator.sendTransaction({ to: vault, data })).to.be.revertedWithCustomError(vault, 'NotOwner');
      // and a buy or a sale has no recipient to name: what it produces is measured in the vault itself
      expect(iface.getFunction('buy').inputs.map((i) => i.name)).to.deep.equal(['token', 'ethIn', 'minTokensOut', 'deadline']);
      expect(iface.getFunction('sell').inputs.map((i) => i.name)).to.deep.equal(['token', 'amount', 'minEthOut', 'deadline']);
    });
  });
});

describe('PonsVenue', function () {
  if (process.env.FORK) return; // against mocks here; against the real curve and pool in meme.fork.test.js

  let user, stranger, pons, manager, curve, token, venue;
  const HOOK = '0x00000000000000000000000000000000000000AA';

  const deploy = async (name, ...args) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    return c;
  };
  const ethOf = (a) => ethers.provider.getBalance(a);

  beforeEach(async () => {
    [user, stranger] = await ethers.getSigners();
    token = await deploy('MockToken', 'Meme', 'MEME', 18);
    pons = await deploy('MockPonsFactory');
    manager = await deploy('MockPoolManager');
    curve = await deploy('MockPonsCurve', await token.getAddress());
    venue = await deploy('PonsVenue', await pons.getAddress(), await manager.getAddress(), HOOK);
    await user.sendTransaction({ to: curve, value: E(20) });
    await user.sendTransaction({ to: manager, value: E(20) });
    await pons.setLaunch(token, curve, ZERO, 0, true);
  });

  it('lists only launches the pons factory knows and that are priced in ETH', async () => {
    expect(await venue.isListed(token)).to.equal(true);
    const unknown = await deploy('MockToken', 'X', 'X', 18);
    expect(await venue.isListed(unknown)).to.equal(false);
    await pons.setLaunch(unknown, curve, await token.getAddress(), 0, true); // priced in another token
    expect(await venue.isListed(unknown)).to.equal(false);
    await expect(venue.buy(unknown, 1, { value: E(1) })).to.be.revertedWithCustomError(venue, 'NotSupported');
    await expect(venue.sell(unknown, 1, 1)).to.be.revertedWithCustomError(venue, 'NotSupported');
  });

  it('before graduation it buys on the curve: tokens to the caller, unused ETH back', async () => {
    await curve.setFill(2500); // the curve can use a quarter
    const before = await ethOf(user.address);
    const tx = await venue.buy(token, E(1000), { value: E(1) });
    const r = await tx.wait();
    expect(await token.balanceOf(user.address)).to.equal(E(250));
    expect(before - (await ethOf(user.address)) - r.gasUsed * r.gasPrice).to.equal(E(0.25));
    expect(await ethOf(venue)).to.equal(0);
  });

  it('before graduation it sells on the curve, and keeps nothing', async () => {
    await venue.buy(token, E(1000), { value: E(1) });
    await token.approve(venue, E(1000));
    const before = await ethOf(user.address);
    const tx = await venue.sell(token, E(1000), E(1));
    const r = await tx.wait();
    expect((await ethOf(user.address)) - before + r.gasUsed * r.gasPrice).to.equal(E(1));
    expect(await token.balanceOf(venue)).to.equal(0);
    expect(await token.allowance(venue, curve)).to.equal(0);
    expect(await ethOf(venue)).to.equal(0);
  });

  it('after graduation it trades in the pool the launch record describes', async () => {
    await pons.setLaunch(token, curve, ZERO, 2, true);
    await venue.buy(token, E(1000), { value: E(1) });
    expect(await token.balanceOf(user.address)).to.equal(E(1000));
    const key = await manager.lastKey();
    expect(key.currency0).to.equal(ZERO);
    expect(key.currency1).to.equal(await token.getAddress());
    expect(key.fee).to.equal(0);
    expect(key.tickSpacing).to.equal(200);
    expect(key.hooks).to.equal(HOOK);

    await token.approve(venue, E(400));
    const before = await ethOf(user.address);
    const tx = await venue.sell(token, E(400), E(0.4));
    const r = await tx.wait();
    expect((await ethOf(user.address)) - before + r.gasUsed * r.gasPrice).to.equal(E(0.4));
    expect(await token.balanceOf(user.address)).to.equal(E(600));
    expect(await token.balanceOf(venue)).to.equal(0);
    expect(await ethOf(venue)).to.equal(0);
  });

  it('holds the pool to the minimum asked for', async () => {
    await pons.setLaunch(token, curve, ZERO, 2, true);
    await expect(venue.buy(token, E(1001), { value: E(1) })).to.be.revertedWithCustomError(venue, 'InsufficientOutput');
    await venue.buy(token, E(1000), { value: E(1) });
    await token.approve(venue, E(1000));
    await expect(venue.sell(token, E(1000), E(1.01))).to.be.revertedWithCustomError(venue, 'InsufficientOutput');
  });

  it('a launch that sold out but has no pool yet is pushed into its pool first', async () => {
    await pons.setLaunch(token, curve, ZERO, 1, true);
    await venue.buy(token, E(1000), { value: E(1) });
    expect(await pons.pushes()).to.equal(1);
    expect(await token.balanceOf(user.address)).to.equal(E(1000));
  });

  it('says a launch cannot be traded when the pool cannot be made, or the launch was rescued', async () => {
    await pons.setLaunch(token, curve, ZERO, 1, true);
    await pons.setPushWorks(false);
    await expect(venue.buy(token, 1, { value: E(1) })).to.be.revertedWithCustomError(venue, 'NotTradable');
    await pons.setLaunch(token, curve, ZERO, 3, true);
    await expect(venue.buy(token, 1, { value: E(1) })).to.be.revertedWithCustomError(venue, 'NotTradable');
  });

  it('only the PoolManager can call the swap step', async () => {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(['bool', 'address', 'int24', 'uint24', 'uint256', 'address'], [true, await token.getAddress(), 200, 0, E(1), stranger.address]);
    await expect(venue.connect(stranger).unlockCallback(data)).to.be.revertedWithCustomError(venue, 'NotPoolManager');
  });

  it('refuses to be built without its three addresses', async () => {
    const F = await ethers.getContractFactory('PonsVenue');
    await expect(F.deploy(ZERO, await manager.getAddress(), HOOK)).to.be.revertedWithCustomError(venue, 'ZeroAddress');
    await expect(F.deploy(await pons.getAddress(), ZERO, HOOK)).to.be.revertedWithCustomError(venue, 'ZeroAddress');
    await expect(F.deploy(await pons.getAddress(), await manager.getAddress(), ZERO)).to.be.revertedWithCustomError(venue, 'ZeroAddress');
  });
});
