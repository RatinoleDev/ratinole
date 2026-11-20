// Deploys the Ratinole contracts: timelock (run by the Safe), vault factory and decision registry.
// Used by scripts/deploy.js (mainnet, run by the owner) and by the fork rehearsal test.
const DAY = 86400;

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
 */
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
  return out;
}

async function deployAll({ ethers, deployer, safe, operator, poster, delay, cfg, onDeployed }) {
  for (const [name, a] of Object.entries({ safe, operator, poster })) {
    if (!ethers.isAddress(a) || a === ethers.ZeroAddress) throw new Error(`${name} must be an address`);
  }
  const tokens = vaultTokens(cfg);
  const timelock = await ethers.deployContract('RatinoleTimelock', [delay, [safe], [safe], ethers.ZeroAddress], deployer);
  await timelock.waitForDeployment();
  const factory = await ethers.deployContract('AgentVaultFactory', [
    cfg.router, operator,
    tokens.map((t) => t.address), tokens.map((t) => t.feed), tokens.map((t) => t.maxStaleness), tokens.map((t) => t.feeTier || 0),
    await timelock.getAddress(),
  ], deployer);
  await factory.waitForDeployment();
  const registry = await ethers.deployContract('DecisionRegistry', [await timelock.getAddress(), poster], deployer);
  await registry.waitForDeployment();
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
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
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
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Deployment check failed: ${failed.join(', ')}`);
  return checks.map(([name]) => name);
}

module.exports = { deployAll, checkDeployment, vaultTokens, DAY };
