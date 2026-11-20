require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// Compiles and tests the vault contracts. The only key it can read is DEPLOYER_PRIVATE_KEY, on the owner's machine.
const RPC = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org';

module.exports = {
  solidity: {
    compilers: [{ version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' } }],
  },
  networks: {
    // FORK=1 runs the tests against a local copy of Robinhood Chain (real Uniswap pools and Chainlink feeds, fake money).
    hardhat: process.env.FORK ? { forking: { url: RPC }, chainId: 4663 } : {},
    // Only the owner's machine sets DEPLOYER_PRIVATE_KEY, for scripts/deploy.js. The build never does.
    robinhood: { url: RPC, chainId: 4663, accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [] },
  },
  mocha: { timeout: 300_000 },
};
