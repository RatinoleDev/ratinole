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
 */
async function deployAll({ ethers, deployer, safe, operator, poster, delay, cfg }) {
  for (const [name, a] of Object.entries({ safe, operator, poster })) {
    if (!ethers.isAddress(a) || a === ethers.ZeroAddress) throw new Error(`${name} must be an address`);
  }
  const timelock = await ethers.deployContract('RatinoleTimelock', [delay, [safe], [safe], ethers.ZeroAddress], deployer);
  await timelock.waitForDeployment();
  const factory = await ethers.deployContract('AgentVaultFactory', [
    cfg.router, operator,
    cfg.tokens.map((t) => t.address), cfg.tokens.map((t) => t.feed), cfg.tokens.map((t) => t.maxStaleness), cfg.tokens.map((t) => t.feeTier || 0),
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
  await checkDeployment({ ethers, addresses: out, safe, operator, poster, delay, deployer: await deployer.getAddress() });
  return { ...out, contracts: { timelock, factory, registry } };
}

/** Reads the deployed state back and fails loudly if anything is not as intended. */
async function checkDeployment({ ethers, addresses, safe, operator, poster, delay, deployer }) {
  const timelock = await ethers.getContractAt('RatinoleTimelock', addresses.timelock);
  const factory = await ethers.getContractAt('AgentVaultFactory', addresses.factory);
  const registry = await ethers.getContractAt('DecisionRegistry', addresses.registry);
  const checks = [
    ['factory admin is the timelock', (await factory.admin()) === addresses.timelock],
    ['factory default operator', (await factory.defaultOperator()) === operator],
    ['registry admin is the timelock', (await registry.admin()) === addresses.timelock],
    ['registry poster', (await registry.poster()) === poster],
    ['timelock delay', (await timelock.getMinDelay()) === BigInt(delay)],
    ['Safe can propose', await timelock.hasRole(await timelock.PROPOSER_ROLE(), safe)],
    ['Safe can execute', await timelock.hasRole(await timelock.EXECUTOR_ROLE(), safe)],
    ['deployer cannot propose', !(await timelock.hasRole(await timelock.PROPOSER_ROLE(), deployer)) || deployer === safe],
    ['deployer is not timelock admin', !(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer))],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`Deployment check failed: ${failed.join(', ')}`);
  return checks.map(([name]) => name);
}

module.exports = { deployAll, checkDeployment, DAY };
