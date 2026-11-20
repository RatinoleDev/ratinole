// Ratinole addition: the hourly decision registry (HANDOFF 6.3).
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const HOUR = 3600;
const coder = ethers.AbiCoder.defaultAbiCoder();

// OpenZeppelin-style leaf and sorted-pair Merkle tree, matching what the engine will build.
function leaf(decisionId, agentId, hour, contentHash) {
  return ethers.keccak256(ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'uint64', 'bytes32'], [decisionId, agentId, hour, contentHash])));
}
const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));
function tree(leaves) {
  const levels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proof = (index) => {
    const out = [];
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = index ^ 1;
      if (sib < levels[l].length) out.push(levels[l][sib]);
      index = Math.floor(index / 2);
    }
    return out;
  };
  return { root: levels[levels.length - 1][0], proof };
}

describe('DecisionRegistry', function () {
  if (process.env.FORK) return;

  let admin, poster, stranger, next, reg, hour;
  const id = (s) => ethers.id(s);

  beforeEach(async () => {
    [admin, poster, stranger, next] = await ethers.getSigners();
    reg = await ethers.deployContract('DecisionRegistry', [admin.address, poster.address]);
    const now = await time.latest();
    hour = BigInt(now - (now % HOUR) - HOUR); // the newest hour that is over
  });

  it('the poster records one root per past hour, and it verifies the decisions in it', async () => {
    const leaves = [0, 1, 2].map((i) => leaf(id(`decision-${i}`), id('agent-a'), hour, id(`content-${i}`)));
    const t = tree(leaves);
    await expect(reg.connect(poster).post(hour, t.root, 3)).to.emit(reg, 'RootPosted').withArgs(hour, t.root, 3);
    for (let i = 0; i < 3; i++) expect(await reg.verify(hour, leaves[i], t.proof(i))).to.equal(true);
    const forged = leaf(id('decision-1'), id('agent-a'), hour, id('edited'));
    expect(await reg.verify(hour, forged, t.proof(1))).to.equal(false);
    expect(await reg.verify(hour - BigInt(HOUR), leaves[0], t.proof(0))).to.equal(false);
    expect(await reg.lastHour()).to.equal(hour);
  });

  it('a root can never be changed', async () => {
    await reg.connect(poster).post(hour, id('root-1'), 1);
    await expect(reg.connect(poster).post(hour, id('root-2'), 1)).to.be.revertedWithCustomError(reg, 'AlreadyPosted');
  });

  it('refuses the hour still in progress until it is over', async () => {
    const current = hour + BigInt(HOUR);
    await expect(reg.connect(poster).post(current, id('early'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await time.setNextBlockTimestamp(current + BigInt(HOUR) - 1n);
    await expect(reg.connect(poster).post(current, id('early'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await time.setNextBlockTimestamp(current + BigInt(HOUR));
    await expect(reg.connect(poster).post(current, id('complete'), 4)).to.emit(reg, 'RootPosted').withArgs(current, id('complete'), 4);
  });

  it('refuses hours that are not on the hour or still in the future, and empty roots', async () => {
    await expect(reg.connect(poster).post(hour + 60n, id('r'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await expect(reg.connect(poster).post(hour + BigInt(HOUR), id('r'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await expect(reg.connect(poster).post(hour + 2n * BigInt(HOUR), id('r'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await expect(reg.connect(poster).post(hour, ethers.ZeroHash, 1)).to.be.revertedWithCustomError(reg, 'EmptyRoot');
    await expect(reg.connect(poster).post(hour, id('r'), 0)).to.be.revertedWithCustomError(reg, 'EmptyRoot');
  });

  it('late hours can still be posted (catch-up), without moving lastHour back', async () => {
    await reg.connect(poster).post(hour, id('now'), 1);
    await reg.connect(poster).post(hour - 2n * BigInt(HOUR), id('earlier'), 1);
    expect(await reg.lastHour()).to.equal(hour);
  });

  it('history cannot be filled in long afterwards: an hour that ended more than 14 days ago is refused', async () => {
    const DAYS14 = 14n * 24n * BigInt(HOUR);
    const old = hour - DAYS14 - 2n * BigInt(HOUR);
    await expect(reg.connect(poster).post(old, id('rewritten'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    await expect(reg.connect(poster).post(0, id('rewritten'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
    // The edge, to the second: an hour can be posted until 14 days after it ended, and not one second later.
    const now = BigInt(await time.latest());
    const edge = now - (now % BigInt(HOUR)) - DAYS14 + BigInt(HOUR); // its last moment is two hours from now
    await time.setNextBlockTimestamp(edge + BigInt(HOUR) + DAYS14);
    await expect(reg.connect(poster).post(edge, id('just in time'), 1)).to.emit(reg, 'RootPosted');
    const next = edge + BigInt(HOUR);
    await time.setNextBlockTimestamp(next + BigInt(HOUR) + DAYS14 + 1n);
    await expect(reg.connect(poster).post(next, id('too late'), 1)).to.be.revertedWithCustomError(reg, 'BadHour');
  });

  it('only the poster posts; only the admin rotates the poster', async () => {
    await expect(reg.connect(stranger).post(hour, id('r'), 1)).to.be.revertedWithCustomError(reg, 'NotPoster');
    await expect(reg.connect(poster).setPoster(stranger.address)).to.be.revertedWithCustomError(reg, 'NotAdmin');
    await expect(reg.connect(admin).setPoster(next.address)).to.emit(reg, 'PosterChanged').withArgs(poster.address, next.address);
    await expect(reg.connect(poster).post(hour, id('r'), 1)).to.be.revertedWithCustomError(reg, 'NotPoster');
    await expect(reg.connect(next).post(hour, id('r'), 1)).to.emit(reg, 'RootPosted');
    await expect(reg.connect(admin).setPoster(ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, 'ZeroAddress');
  });

  it('admin moves in two steps', async () => {
    await reg.connect(admin).transferAdmin(next.address);
    expect(await reg.admin()).to.equal(admin.address);
    await expect(reg.connect(stranger).acceptAdmin()).to.be.revertedWithCustomError(reg, 'NotAdmin');
    await expect(reg.connect(next).acceptAdmin()).to.emit(reg, 'AdminTransferred').withArgs(next.address);
    await expect(reg.connect(admin).setPoster(stranger.address)).to.be.revertedWithCustomError(reg, 'NotAdmin');
  });
});
