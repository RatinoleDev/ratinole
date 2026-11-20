#!/usr/bin/env node
/**
 * The owner's steps to open live trading, run ON THE SERVER as the app's user. Each step that sends a
 * transaction or opens live trading asks you to type a word first. Nothing here is run by the build or by CI.
 *
 *   node scripts/go-live.mjs status                 what is set up, and what is missing
 *   node scripts/go-live.mjs safe 0xYou[,0xOther]   create your Safe (the admin of the contracts)
 *   node scripts/go-live.mjs deploy 0xSafeAddress   deploy the contracts to Robinhood Chain
 *   node scripts/go-live.mjs open                   turn live trading on for this site
 *   node scripts/go-live.mjs close                  turn it off again (vaults stay where they are)
 *
 * Keys come from .env (scripts/keys.mjs creates them). They are passed to the deploy tool in memory and are
 * never printed. Add `--network localhost` to rehearse against a local fork with fake money.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const require = createRequire(join(root, "apps", "engine", "package.json"));
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, formatEther, http } = require("viem");

const args = process.argv.slice(2);
const netAt = args.indexOf("--network");
const network = netAt >= 0 ? args.splice(netAt, 2)[1] : "robinhood";
const [cmd, arg] = args;
const mainnet = network === "robinhood";
const RPC = mainnet ? "https://robinhood.drpc.org" : "http://127.0.0.1:8545";
const deploymentFile = join(root, "contracts", "deployments", `${network}.json`);

const envText = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
const envGet = (name) => envText().match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() || null;
function envSet(name, value) {
  const text = envText();
  const line = `${name}=${value}`;
  const has = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(envFile, has.test(text) ? text.replace(has, line) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`);
}
const keyOf = (name) => (/^0x[0-9a-fA-F]{64}$/.test(envGet(name) ?? "") ? envGet(name) : null);
const addressOf = (name) => (keyOf(name) ? privateKeyToAccount(keyOf(name)).address : null);
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
const fail = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

async function confirm(word, what) {
  if (!mainnet) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${what}\nType ${word} to continue, anything else to stop: `);
  rl.close();
  if (answer.trim() !== word) fail("Stopped. Nothing was sent.");
}

/** Runs a contracts script with the deployer key in its environment only. */
function hardhat(script, extraEnv) {
  const deployer = keyOf("DEPLOYER_PRIVATE_KEY");
  if (!deployer) fail("No deployer key yet. Create it with: node scripts/keys.mjs create deployer");
  const res = spawnSync("pnpm", ["--filter", "@rationale/contracts", "exec", "hardhat", "run", `scripts/${script}`, "--network", network], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv, DEPLOYER_PRIVATE_KEY: deployer },
  });
  if (res.status !== 0) fail("That step failed. Read the message above; nothing else was changed.");
}

const pub = createPublicClient({ transport: http(RPC) });
const balance = async (a) => (a ? `${Number(formatEther(await pub.getBalance({ address: a }))).toFixed(5)} ETH` : "-");
const deployment = () => (existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) : null);

if (cmd === "status") {
  const operator = addressOf("OPERATOR_PRIVATE_KEY");
  const deployer = addressOf("DEPLOYER_PRIVATE_KEY");
  const d = deployment();
  const open = envGet("LIVE_FACTORY_ADDRESS");
  console.log(`Network: ${network}`);
  console.log(`Operator key (the agent):  ${operator ?? "missing: node scripts/keys.mjs create operator"}${operator ? `, holds ${await balance(operator)} for fees` : ""}`);
  console.log(`Deployer key (one-time):   ${deployer ?? "missing: node scripts/keys.mjs create deployer"}${deployer ? `, holds ${await balance(deployer)}` : ""}`);
  console.log(`Contracts:                 ${d ? `deployed ${d.deployedAt.slice(0, 10)}; factory ${d.factory}; admin Safe ${d.safe}` : "not deployed yet"}`);
  if (d) {
    const onChain = await pub.readContract({ address: d.factory, abi: [{ type: "function", name: "defaultOperator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "defaultOperator" });
    console.log(`Factory's operator:        ${onChain}${operator && onChain.toLowerCase() === operator.toLowerCase() ? " (matches this server's key)" : " (DOES NOT match this server's operator key)"}`);
  }
  console.log(`Live trading on this site: ${open ? `OPEN (factory ${open})` : "closed"}`);
} else if (cmd === "safe") {
  const owners = (arg ?? "").split(",").filter(Boolean);
  if (!owners.length || !owners.every(isAddress)) fail("Give the wallet(s) that will own the Safe: node scripts/go-live.mjs safe 0xYourWallet[,0xSecondSigner]");
  await confirm("CREATE", `This creates a Safe on Robinhood Chain owned by:\n  ${owners.join("\n  ")}\nIt costs a small network fee, paid by the deployer key.`);
  hardhat("create-safe.js", { SAFE_OWNERS: owners.join(","), ...(args[2] ? { SAFE_THRESHOLD: args[2] } : {}) });
  console.log("Keep the SAFE_ADDRESS above. Next: node scripts/go-live.mjs deploy <that address>");
} else if (cmd === "deploy") {
  if (!isAddress(arg)) fail("Give your Safe's address: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = addressOf("OPERATOR_PRIVATE_KEY");
  if (!operator) fail("No operator key yet. Create it with: node scripts/keys.mjs create operator");
  if (deployment()) fail(`Contracts are already deployed on ${network} (${deploymentFile}). Deploying again would create a second, separate set.`);
  await confirm(
    "DEPLOY",
    `This deploys the Ratinole contracts to Robinhood Chain MAINNET.\n  Admin: your Safe ${arg}, behind a 3-day timelock\n  Agent (operator and registry poster): ${operator}\nIt cannot be undone. It costs a small network fee, paid by the deployer key.`,
  );
  hardhat("deploy.js", { SAFE_ADDRESS: arg, OPERATOR_ADDRESS: operator, POSTER_ADDRESS: operator, ...(mainnet ? { CONFIRM_MAINNET: "deploy-ratinole-mainnet" } : {}) });
  console.log("\nDeployed. Live trading is still closed on the site. Check `node scripts/go-live.mjs status`, then open it with `node scripts/go-live.mjs open`.");
} else if (cmd === "open") {
  const d = deployment();
  if (!d) fail("The contracts are not deployed yet: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = addressOf("OPERATOR_PRIVATE_KEY");
  if (!operator || operator.toLowerCase() !== d.operator.toLowerCase()) fail("This server's operator key is not the one the contracts were deployed with. Do not open until they match.");
  if ((await pub.getBalance({ address: operator })) === 0n) fail(`The agent's address ${operator} holds no ETH, so it could not pay for a single trade. Send it a little ETH on Robinhood Chain first.`);
  await confirm("OPEN", "This opens live trading on the site for EVERYONE: any visitor can create a vault and trade real money.\nThe contracts have not had an independent security audit.");
  envSet("LIVE_FACTORY_ADDRESS", d.factory);
  if (!mainnet) envSet("LIVE_RPC_URL", RPC);
  console.log(`\nSet LIVE_FACTORY_ADDRESS=${d.factory} in .env.\nRestart to apply:  pm2 reload ecosystem.config.cjs --update-env`);
} else if (cmd === "close") {
  envSet("LIVE_FACTORY_ADDRESS", "");
  console.log("Live trading is closed on this site after a restart:  pm2 reload ecosystem.config.cjs --update-env\nVaults and their money stay on-chain; owners can still withdraw with any wallet tool.");
} else {
  fail("Usage: node scripts/go-live.mjs <status|safe|deploy|open|close> [address] [--network localhost]");
}
