// Runs against a local fork of Robinhood Chain: the REAL pons factory, a real launch's bonding curve and the real
// Uniswap v4 PoolManager, with fake money. Nothing is sent on-chain.
//
//   FORK=1 npx hardhat test test/meme.fork.test.js
//   MEME_TOKEN=0x... to use another pons v2 launch priced in ETH (default: RATINOLE).
//
// It follows one launch through its whole life: a buy and a sale on the curve, buying until the curve sells out,
// the move into its Uniswap v4 pool, and a sale and a buy there. If the launch has already graduated on the real
// chain, the curve steps are skipped and the pool steps still run.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const netConfig = require('../scripts/netconfig');

const LATER = 2n ** 62n;
const E = (n) => ethers.parseEther(String(n));
const fmt = (v, d = 18) => Number(ethers.formatUnits(v, d));
const PHASE = ['on its curve', 'sold out, pool not made yet', 'in its Uniswap v4 pool', 'rescued'];

describe('MemeVault with pons on a mainnet fork', function () {
  if (!process.env.FORK) return;

  const cfg = netConfig(network.name);
  const TOKEN = process.env.MEME_TOKEN || '0xcEc856b8a7f6946d4E589F400678D9CC43455d58';
  let owner, operator, admin, pons, venue, factory, vault, token, startPhase;

  const ethOf = (a) => ethers.provider.getBalance(a);
  const launch = () => pons.getLaunchedToken(TOKEN);
  const held = () => token.balanceOf(vault);

  /** Buys through the vault for what a simulation says the buy returns, less 1%. */
  async function buy(ethIn) {
    const [quote] = await vault.connect(operator).buy.staticCall(TOKEN, ethIn, 1, LATER);
    const before = [await ethOf(vault), await held()];
    await (await vault.connect(operator).buy(TOKEN, ethIn, (quote * 99n) / 100n, LATER, { gasLimit: 6_000_000 })).wait();
    return { quote, spent: before[0] - (await ethOf(vault)), got: (await held()) - before[1] };
  }
  async function sell(amount) {
    const quote = await vault.connect(operator).sell.staticCall(TOKEN, amount, 1, LATER);
    const before = [await ethOf(vault), await held()];
    await (await vault.connect(operator).sell(TOKEN, amount, (quote * 99n) / 100n, LATER, { gasLimit: 6_000_000 })).wait();
    return { quote, got: (await ethOf(vault)) - before[0], sold: before[1] - (await held()) };
  }

  before(async () => {
    [admin, , operator] = await ethers.getSigners();
    // A fresh fork cannot answer a call at the very block it was forked from: mine one first.
    await network.provider.send('evm_mine');
    // The owner is a fresh wallet. Hardhat's well-known test addresses carry delegated code on the real chain
    // that refuses incoming ETH, so a withdrawal to one of them fails for a reason that has nothing to do with us.
    owner = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.send('hardhat_setBalance', [owner.address, '0x' + E(30).toString(16)]);

    pons = await ethers.getContractAt('IPonsFactory', cfg.pons.factory);
    token = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'], TOKEN);
    const manager = await ethers.getContractAt(['function poolManager() view returns (address)'], cfg.pons.factory);
    expect((await manager.poolManager()).toLowerCase(), 'the PoolManager in the config is the one the pons factory uses').to.equal(cfg.pons.poolManager.toLowerCase());

    venue = await ethers.deployContract('PonsVenue', [cfg.pons.factory, cfg.pons.poolManager, cfg.pons.hook]);
    factory = await ethers.deployContract('MemeVaultFactory', [operator.address, admin.address, [await venue.getAddress()]]);
    await (await factory.connect(owner).createVault(E(20))).wait();
    vault = await ethers.getContractAt('MemeVault', await factory.vaultOf(owner.address));
    await (await owner.sendTransaction({ to: vault, value: E(12) })).wait();

    const l = await launch();
    startPhase = Number(l.phase);
    console.log(`      launch: ${await token.symbol()} ${TOKEN}, ${PHASE[startPhase]}; creator tax ${Number(l.creatorTaxBps) / 100}%`);
  });

  it('knows a genuine launch from an address that is not one', async () => {
    expect(await venue.isListed(TOKEN)).to.equal(true);
    expect(await venue.isListed(cfg.router)).to.equal(false);
    const usdg = cfg.tokens.find((t) => t.symbol === cfg.stable).address;
    expect(await venue.isListed(usdg)).to.equal(false);
    await expect(vault.connect(owner).allowToken(usdg, venue, E(1))).to.be.revertedWithCustomError(vault, 'VenueDoesNotSupport');
    await (await vault.connect(owner).allowToken(TOKEN, venue, E(12))).wait();
  });

  it('buys on the curve for exactly what a simulation said', async function () {
    if (startPhase !== 0) return this.skip();
    const r = await buy(E(0.01));
    console.log(`      0.01 ETH -> ${fmt(r.got).toFixed(2)} tokens`);
    expect(r.got).to.equal(r.quote);
    expect(r.spent).to.equal(E(0.01));
    expect((await vault.rules(TOKEN)).budgetLeftWei).to.equal(E(12) - E(0.01));
  });

  it('refuses a curve buy that asks for more than the curve gives', async function () {
    if (startPhase !== 0) return this.skip();
    const [quote] = await vault.connect(operator).buy.staticCall(TOKEN, E(0.01), 1, LATER);
    await expect(vault.connect(operator).buy(TOKEN, E(0.01), quote + quote / 50n, LATER, { gasLimit: 3_000_000 })).to.be.reverted;
  });

  it('sells on the curve, and the ETH comes back to the vault', async function () {
    if (startPhase !== 0) return this.skip();
    const half = (await held()) / 2n;
    const r = await sell(half);
    console.log(`      ${fmt(half).toFixed(2)} tokens -> ${fmt(r.got).toFixed(6)} ETH (the round trip costs the curve's fee and the creator's tax, both ways)`);
    expect(r.got).to.equal(r.quote);
    expect(r.sold).to.equal(half);
    expect(await token.balanceOf(venue)).to.equal(0n);
    expect(await ethOf(venue)).to.equal(0n);
  });

  it('buys the curve out: the last buy is filled in part and the rest of the ETH comes back', async function () {
    if (startPhase !== 0) return this.skip();
    let last;
    for (let i = 0; i < 8 && Number((await launch()).phase) === 0; i++) {
      last = await buy(E(1.5));
      console.log(`      buy of 1.5 ETH spent ${fmt(last.spent).toFixed(4)} ETH -> ${PHASE[Number((await launch()).phase)]}`);
    }
    expect(Number((await launch()).phase), 'the curve sold out').to.not.equal(0);
    expect(last.spent).to.be.lessThan(E(1.5));
    expect(last.got).to.be.greaterThan(0n);
    expect(await ethOf(venue)).to.equal(0n);
  });

  it('once the curve has sold out, the next trade goes to the Uniswap v4 pool by itself', async () => {
    const before = Number((await launch()).phase);
    expect(before).to.be.oneOf([1, 2]);
    if ((await held()) === 0n) await buy(E(0.05));
    const r = await sell((await held()) / 4n);
    console.log(`      sold ${fmt(r.sold).toFixed(0)} tokens in the pool for ${fmt(r.got).toFixed(6)} ETH`);
    expect(Number((await launch()).phase)).to.equal(2);
    expect(r.got).to.equal(r.quote);
    expect(r.got).to.be.greaterThan(0n);
    expect(await token.balanceOf(venue)).to.equal(0n);
    expect(await ethOf(venue)).to.equal(0n);
  });

  it('buys in the pool for exactly what a simulation said', async () => {
    const r = await buy(E(0.05));
    console.log(`      0.05 ETH -> ${fmt(r.got).toFixed(2)} tokens in the pool`);
    expect(r.got).to.equal(r.quote);
    expect(r.spent).to.equal(E(0.05));
    expect(await ethOf(venue)).to.equal(0n);
  });

  it('holds a pool trade to its minimum', async () => {
    const [quote] = await vault.connect(operator).buy.staticCall(TOKEN, E(0.05), 1, LATER);
    await expect(vault.connect(operator).buy(TOKEN, E(0.05), quote + 1n, LATER, { gasLimit: 3_000_000 })).to.be.reverted;
    const amount = (await held()) / 10n;
    const out = await vault.connect(operator).sell.staticCall(TOKEN, amount, 1, LATER);
    await expect(vault.connect(operator).sell(TOKEN, amount, out + 1n, LATER, { gasLimit: 3_000_000 })).to.be.reverted;
  });

  it('a round trip in the pool costs what the launch charges, and no more', async () => {
    const l = await launch();
    const [tokens] = await vault.connect(operator).buy.staticCall(TOKEN, E(0.01), 1, LATER);
    const b = await buy(E(0.01));
    const s = await sell(b.got);
    const cost = 1 - fmt(s.got) / 0.01;
    console.log(`      0.01 ETH in, ${fmt(s.got).toFixed(6)} ETH out: ${(cost * 100).toFixed(2)}% (creator tax ${Number(l.creatorTaxBps) / 100}% each way, plus the launch fee and price impact)`);
    expect(tokens).to.equal(b.got);
    expect(cost).to.be.greaterThan(0);
    expect(cost).to.be.lessThan(0.2);
  });

  it('the agent can never take anything out, and the owner can take everything', async () => {
    await expect(vault.connect(operator).withdraw(ethers.ZeroAddress, 1, operator.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
    await expect(vault.connect(operator).withdraw(TOKEN, 1, operator.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
    const tokens = await held();
    const eth = await ethOf(vault);
    const ownerBefore = await ethOf(owner.address);
    await (await vault.connect(owner).withdraw(TOKEN, tokens, owner.address)).wait();
    const r = await (await vault.connect(owner).withdraw(ethers.ZeroAddress, eth, owner.address)).wait();
    expect(await token.balanceOf(owner.address)).to.equal(tokens);
    expect(await held()).to.equal(0n);
    expect(await ethOf(vault)).to.equal(0n);
    expect((await ethOf(owner.address)) - ownerBefore).to.be.greaterThan(eth - E(0.01));
    expect(r.status).to.equal(1);
  });
});
