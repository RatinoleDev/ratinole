// Deploys the Ratinole contracts: timelock (run by the Safe), vault factory and decision registry.
// Used by scripts/deploy.js (mainnet, run by the owner) and by the fork rehearsal test.
const DAY = 86400;
/** An address nobody holds, used as the sender of dry runs. Nothing is ever sent from it. */
const DRY_RUN_FROM = '0x000000000000000000000000000000000000dEaD';
const SAFE_ABI = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)'];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The real chain is never a node on this machine or a development node. With ROBINHOOD_RPC_URL pointed at a
 * local fork, the `robinhood` network would hand the real deployer key to that fork (whose signatures are valid
 * on the real chain) and record fork-only contracts as the real deployment.
 */
async function refuseDevNode({ ethers, network }) {
  let host = '';
  try {
    host = new URL(network.config.url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('The RPC address for this network is not a URL. Nothing was sent.');
  }
  if (['localhost', '::1', '0.0.0.0'].includes(host) || /^127\./.test(host)) {
    throw new Error(`The RPC for ${network.name} points at this machine (${host}). That is a rehearsal: use --network localhost. Nothing was sent.`);
  }
  const client = await ethers.provider.send('web3_clientVersion', []).catch(() => '');
  if (/hardhat|anvil|ganache|foundry/i.test(String(client))) {
    throw new Error(`The RPC for ${network.name} is a development node (${client}), not Robinhood Chain. Nothing was sent.`);
  }
}

/**
 * The owners and threshold of the Safe at `safe`, or null when there is no contract there. Throws when there is
 * a contract that does not answer like a Safe.
 */
async function readSafe({ ethers, safe }) {
  if ((await ethers.provider.getCode(safe)) === '0x') return null;
  const s = new ethers.Contract(safe, SAFE_ABI, ethers.provider);
  let owners, threshold;
  try {
    [owners, threshold] = [Array.from(await s.getOwners()), Number(await s.getThreshold())];
  } catch {
    throw new Error(`The contract at ${safe} does not answer like a Safe.`);
  }
  if (!owners.length || threshold < 1 || threshold > owners.length) throw new Error(`The Safe at ${safe} has no usable owners.`);
  return { owners, threshold };
}

/**
 * The tokens every new vault may trade, fixed for good when the factory is deployed: only the ones the site
 * trades (`vaultTokens` in the network config). A token in a vault is a token a stolen agent key could trade,
 * so the list is kept as short as it can be. The other tokens in the config are for reference and tests.
 */
function vaultTokens(cfg) {
  if (!Array.isArray(cfg.vaultTokens) || !cfg.vaultTokens.length) throw new Error('The network config has no vaultTokens list');
  const bySymbol = new Map(cfg.tokens.map((t) => [t.symbol, t]));
  const out = cfg.vaultTokens.map((symbol) => {
    const t = bySymbol.get(symbol);
    if (!t) throw new Error(`vaultTokens names ${symbol}, which is not in the token list`);
    return t;
  });
  if (!out.some((t) => t.symbol === cfg.stable && !t.feeTier)) throw new Error('vaultTokens must include the stablecoin');
  if (new Set(out.map((t) => t.address.toLowerCase())).size !== out.length) throw new Error('vaultTokens has a duplicate');
  // Exactly one token without a pool fee tier: the stablecoin everything is traded against. A second one would
  // silently become a second base token that no pool is pinned for.
  const noTier = out.filter((t) => !t.feeTier).map((t) => t.symbol);
  if (noTier.length !== 1) throw new Error(`Every vault token but ${cfg.stable} needs a feeTier; without one: ${noTier.join(', ')}`);
  for (const t of out) if (!Number.isInteger(t.maxStaleness) || t.maxStaleness <= 0) throw new Error(`${t.symbol} has no maxStaleness`);
  return out;
}

/**
 * @param {object} p
 * @param {import('ethers').Signer} p.deployer pays gas; keeps no power afterwards
 * @param {string} p.safe Safe multisig: proposer and executor of the timelock
 * @param {string} p.operator default operator for new vaults (the engine's trading key)
 * @param {string} p.poster decision registry poster (the engine's registry key)
 * @param {number} p.delay timelock delay in seconds
 * @param {object} p.cfg network config (config/<network>.json)
 * @param {(addresses: {timelock: string, factory: string, registry: string}) => void} [p.onDeployed] called as
 *        soon as the three contracts exist, before anything is checked, so their addresses are never lost
 * @param {(name: string, address: string) => void} [p.onStep] called after each single contract is deployed
 */
async function deployAll({ ethers, deployer, safe, operator, poster, delay, cfg, onDeployed, onStep }) {
  const step = onStep || (() => undefined);
  for (const [name, a] of Object.entries({ safe, operator, poster })) {
    if (!ethers.isAddress(a) || a === ethers.ZeroAddress) throw new Error(`${name} must be an address`);
  }
  const tokens = vaultTokens(cfg);
  const timelock = await ethers.deployContract('RatinoleTimelock', [delay, [safe], [safe], ethers.ZeroAddress], deployer);
  await timelock.waitForDeployment();
  step('timelock', await timelock.getAddress());
  const factory = await ethers.deployContract('AgentVaultFactory', [
    cfg.router, operator,
    tokens.map((t) => t.address), tokens.map((t) => t.feed), tokens.map((t) => t.maxStaleness), tokens.map((t) => t.feeTier || 0),
    await timelock.getAddress(),
  ], deployer);
  await factory.waitForDeployment();
  step('factory', await factory.getAddress());
  const registry = await ethers.deployContract('DecisionRegistry', [await timelock.getAddress(), poster], deployer);
  await registry.waitForDeployment();
  step('registry', await registry.getAddress());
  const out = {
    timelock: await timelock.getAddress(),
    factory: await factory.getAddress(),
    registry: await registry.getAddress(),
  };
  if (onDeployed) onDeployed(out);
  await checkDeployment({ ethers, addresses: out, safe, operator, poster, delay, deployer: await deployer.getAddress(), cfg });
  return { ...out, contracts: { timelock, factory, registry } };
}

/** Reads the deployed state back and fails loudly if anything is not as intended. */
async function checkDeployment({ ethers, addresses, safe, operator, poster, delay, deployer, cfg }) {
  const timelock = await ethers.getContractAt('RatinoleTimelock', addresses.timelock);
  const factory = await ethers.getContractAt('AgentVaultFactory', addresses.factory);
  const registry = await ethers.getContractAt('DecisionRegistry', addresses.registry);
  // Addresses are compared without regard to capital letters: the same address can be written both ways.
  const checks = [
    ['factory admin is the timelock', same(await factory.admin(), addresses.timelock)],
    ['factory default operator', same(await factory.defaultOperator(), operator)],
    ['registry admin is the timelock', same(await registry.admin(), addresses.timelock)],
    ['registry poster', same(await registry.poster(), poster)],
    ['timelock delay', (await timelock.getMinDelay()) === BigInt(delay)],
    ['Safe can propose', await timelock.hasRole(await timelock.PROPOSER_ROLE(), safe)],
    ['Safe can execute', await timelock.hasRole(await timelock.EXECUTOR_ROLE(), safe)],
    ['Safe can cancel', await timelock.hasRole(await timelock.CANCELLER_ROLE(), safe)],
    ['deployer cannot propose', !(await timelock.hasRole(await timelock.PROPOSER_ROLE(), deployer)) || same(deployer, safe)],
    ['deployer cannot execute', !(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), deployer)) || same(deployer, safe)],
    ['deployer is not timelock admin', !(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer))],
    ['nobody but the timelock is its admin', await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), addresses.timelock)],
  ];
  if (cfg) {
    const want = vaultTokens(cfg);
    const [, tokens, feeds, staleness, feeTiers] = await factory.getDefaults();
    const ok =
      tokens.length === want.length &&
      want.every((t, i) => same(tokens[i], t.address) && same(feeds[i], t.feed) && Number(staleness[i]) === t.maxStaleness && Number(feeTiers[i]) === (t.feeTier || 0));
    checks.push([`factory tokens are ${want.map((t) => t.symbol).join(', ')}`, ok]);
    checks.push(['factory router', same(await factory.router(), cfg.router)]);
  }
  // The token list can never be changed, so a factory that cannot create a vault (a feed that does not answer,
  // a wrong token address) is only good for deploying again. Try it, without sending anything.
  // It is asked of the node directly, as a wallet nobody holds: no key is needed, so the same check runs when
  // the deployment is looked at again later with no signer at all.
  let canCreate = true;
  try {
    const readOnly = new ethers.Contract(addresses.factory, factory.interface, ethers.provider);
    await readOnly.createVault.staticCall(100, 200n * 10n ** 18n, { from: DRY_RUN_FROM });
  } catch {
    canCreate = false;
  }
  checks.push(['a vault can be created', canCreate]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Deployment check failed: ${failed.join(', ')}`);
  return checks.map(([name]) => name);
}

module.exports = { deployAll, checkDeployment, vaultTokens, refuseDevNode, readSafe, DAY };
