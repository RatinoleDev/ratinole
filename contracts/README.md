# Ratinole contracts

Vault contracts for Phase 3 (live trading) on Robinhood Chain (chain 4663).

## Origin

`AgentVault`, `AgentVaultFactory`, `PayrollVault`, `PayrollFactory`, the mocks, the
tests and `scripts/check-config.js` come from
[nounyagent/nouny-agent](https://github.com/nounyagent/nouny-agent) at commit
`083f56407e163f4d891df7ab17bba44ec2582d2e`, under the MIT licence (`LICENSE-NOUNY`, kept as required). The
Uniswap v4 hook, the hooked pool, the LP vault and their tests are left out, as
HANDOFF section 6 decides.

## Commands

```bash
pnpm --filter @rationale/contracts test
```

Against a local fork of Robinhood Chain (real pools and Chainlink feeds, fake money, nothing is sent):

```bash
pnpm --filter @rationale/contracts test:fork
```

In a sandbox whose outbound traffic goes through an HTTPS proxy, prefix commands with
`NODE_USE_ENV_PROXY=1` so Hardhat can download the compiler and reach the RPC.
