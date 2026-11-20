#!/usr/bin/env node
/**
 * The owner's steps to open live trading, run ON THE SERVER as the app's user. Each step that sends a
 * transaction or opens live trading asks you to type a word first. Nothing here is run by the build or by CI.
 *
 *   node scripts/go-live.mjs status                   what is set up, and what is missing
 *   node scripts/go-live.mjs safe 0xYou               create your Safe (the admin of the contracts), one owner
 *   node scripts/go-live.mjs safe 0xYou,0xOther 2     ... or several owners, and how many of them must approve
 *   node scripts/go-live.mjs deploy 0xSafeAddress     deploy the contracts to Robinhood Chain
 *   node scripts/go-live.mjs open                     turn live trading on for this site
 *   node scripts/go-live.mjs close                    pause live trading (everyone can still see and empty their vault)
 *
 * Keys come from .env (scripts/keys.mjs creates them). They are passed to the deploy tool in memory and are
 * never printed.
 *
 * Add `--network localhost` to rehearse against a local fork with fake money. A rehearsal never reads this
 * server's keys and never writes .env: it signs with Hardhat's public test accounts only. (A transaction signed
 * with a real key for a local copy of the chain is also valid on the real chain, so real keys stay out of it.)
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const require = createRequire(join(root, "apps", "engine", "package.json"));
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, formatEther, http, parseEther } = require("viem");

const fail = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const netAt = args.indexOf("--network");
const network = netAt >= 0 ? args.splice(netAt, 2)[1] : "robinhood";
if (!["robinhood", "localhost"].includes(network)) fail("--network must be robinhood (the default) or localhost (a rehearsal on a local fork).");
const [cmd, arg, third] = args;
const mainnet = network === "robinhood";
const RPC = mainnet ? process.env.ROBINHOOD_RPC_URL || "https://robinhood.drpc.org" : "http://127.0.0.1:8545";
const deploymentFile = join(root, "contracts", "deployments", `${network}.json`);
/** Hardhat's public test account 2: the agent's address in a rehearsal. Its key is public and holds nothing real. */
const TEST_OPERATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
/** The least ETH the agent's address must hold before the site is opened: about 160 trades at usual fees. */
const MIN_OPERATOR_ETH = "0.001";

const envText = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
const envGet = (name) => envText().match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() || null;
/** Changes .env in one step, so it is never half written, and never readable by other users. */
function envSet(pairs) {
  let text = envText();
  for (const [name, value] of Object.entries(pairs)) {
    const line = `${name}=${value}`;
    const has = new RegExp(`^${name}=.*$`, "m");
    text = has.test(text) ? text.replace(has, line) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`;
  }
  const tmp = `${envFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envFile);
}
const keyOf = (name) => (/^0x[0-9a-fA-F]{64}$/.test(envGet(name) ?? "") ? envGet(name) : null);
const addressOf = (name) => (keyOf(name) ? privateKeyToAccount(keyOf(name)).address : null);
const operatorAddress = () => (mainnet ? addressOf("OPERATOR_PRIVATE_KEY") : TEST_OPERATOR);
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function confirm(word, what) {
  if (!mainnet) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${what}\nType ${word} to continue, anything else to stop: `);
  rl.close();
  if (answer.trim() !== word) fail("Stopped. Nothing was sent.");
}

/** Runs a contracts script. On mainnet it gets the deployer key, in its environment only; a rehearsal gets no key at all. */
function hardhat(script, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.DEPLOYER_PRIVATE_KEY;
  delete env.OPERATOR_PRIVATE_KEY;
  if (mainnet) {
    const deployer = keyOf("DEPLOYER_PRIVATE_KEY");
    if (!deployer) fail("No deployer key yet. Create it with: node scripts/keys.mjs create deployer");
    env.DEPLOYER_PRIVATE_KEY = deployer;
  }
  const res = spawnSync("pnpm", ["--filter", "@rationale/contracts", "exec", "hardhat", "run", `scripts/${script}`, "--network", network], { cwd: root, stdio: "inherit", env });
  if (res.status !== 0) fail("That step failed. Read the message above. If it printed contract addresses, keep them.");
}

const pub = createPublicClient({ transport: http(RPC) });
const balance = async (a) => (a ? `${Number(formatEther(await pub.getBalance({ address: a }))).toFixed(5)} ETH` : "-");
const deployment = () => (existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) : null);
const view = (name, outputs, inputs = []) => ({ type: "function", name, stateMutability: "view", inputs, outputs });
const FACTORY_ABI = [
  view("defaultOperator", [{ type: "address" }]),
  view("admin", [{ type: "address" }]),
  view("getDefaults", [{ type: "address" }, { type: "address[]" }, { type: "address[]" }, { type: "uint32[]" }, { type: "uint24[]" }]),
  { type: "function", name: "createVault", stateMutability: "nonpayable", inputs: [{ type: "uint16" }, { type: "uint256" }], outputs: [{ type: "address" }] },
];
const SAFE_ABI = [view("getOwners", [{ type: "address[]" }]), view("getThreshold", [{ type: "uint256" }])];

/** A rehearsal only ever talks to a local Hardhat fork. */
async function checkNode() {
  if (mainnet) {
    const id = await pub.getChainId().catch(() => fail(`Robinhood Chain could not be reached at ${new URL(RPC).host}. Try again in a moment.`));
    if (id !== 4663) fail(`The RPC answers for chain ${id}, not Robinhood Chain (4663). Nothing was done.`);
    return;
  }
  const client = await pub.request({ method: "web3_clientVersion" }).catch(() => null);
  if (!client) fail("No local node at http://127.0.0.1:8545. Start one:  FORK=1 pnpm --filter @rationale/contracts exec hardhat node");
  if (!/hardhat/i.test(client)) fail(`The node at 127.0.0.1:8545 is not a Hardhat fork (${client}). A rehearsal only runs against one.`);
}

/** The owners and threshold of the Safe at `address`. Stops if there is no Safe there on this chain. */
async function readSafe(address) {
  const code = await pub.getCode({ address });
  if (!code || code === "0x") fail(`There is no contract at ${address} on this chain. A Safe created on another network does not exist here: create one with  node scripts/go-live.mjs safe 0xYourWallet`);
  try {
    const [owners, threshold] = await Promise.all([
      pub.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }),
      pub.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }),
    ]);
    if (!owners.length || threshold < 1n || threshold > BigInt(owners.length)) throw new Error("bad owners");
    return { owners, threshold: Number(threshold) };
  } catch {
    return fail(`The contract at ${address} does not answer like a Safe. Nothing was sent.`);
  }
}

/** Everything that must be true on-chain before the site is opened. Returns the factory's address. */
async function checkBeforeOpen(d, operator) {
  if (d.verified !== true) fail(`The deployment record (${deploymentFile}) is not marked as verified: the deploy step did not finish its checks. Do not open. Read the deploy output again, or ask for help.`);
  const factory = { address: d.factory, abi: FACTORY_ABI };
  const [onChainOperator, admin, defaults] = await Promise.all([
    pub.readContract({ ...factory, functionName: "defaultOperator" }),
    pub.readContract({ ...factory, functionName: "admin" }),
    pub.readContract({ ...factory, functionName: "getDefaults" }),
  ]).catch(() => fail(`The factory at ${d.factory} could not be read on this chain. Do not open.`));
  if (!same(onChainOperator, operator)) fail(`The factory gives new vaults the operator ${onChainOperator}, which is not this server's agent key (${operator}).\nDo not open until they match: vaults would be created for a key this server does not hold.`);
  if (!same(admin, d.timelock)) fail(`The factory's admin is ${admin}, not the timelock in the record (${d.timelock}). Do not open.`);
  const cfg = JSON.parse(readFileSync(join(root, "contracts", "config", "robinhood.json"), "utf8"));
  const want = cfg.vaultTokens.map((symbol) => cfg.tokens.find((t) => t.symbol === symbol));
  const [, tokens, feeds, , feeTiers] = defaults;
  const got = new Map(tokens.map((t, i) => [t.toLowerCase(), { feed: feeds[i].toLowerCase(), feeTier: Number(feeTiers[i]) }]));
  const tokensOk = got.size === want.length && want.every((t) => got.get(t.address.toLowerCase())?.feed === t.feed.toLowerCase() && got.get(t.address.toLowerCase())?.feeTier === (t.feeTier || 0));
  if (!tokensOk) fail("The factory's token list is not the one in contracts/config/robinhood.json (vaultTokens). The agent would refuse to trade those vaults. Do not open.");
  const held = await pub.getBalance({ address: operator });
  if (held < parseEther(MIN_OPERATOR_ETH)) {
    fail(`The agent's address ${operator} holds ${formatEther(held)} ETH. It pays the network fee of every trade and needs at least ${MIN_OPERATOR_ETH} ETH before the site opens. Send it ETH on Robinhood Chain first.`);
  }
  // A dry run of what every new user will do first. Nothing is sent.
  await pub
    .simulateContract({ ...factory, functionName: "createVault", args: [100, 200n * 10n ** 18n], account: "0x000000000000000000000000000000000000dEaD" })
    .catch((e) => fail(`A dry run of creating a vault failed (${e.shortMessage ?? "unknown reason"}). Do not open: users could not create vaults.`));
  return d.factory;
}

if (!["status", "safe", "deploy", "open", "close"].includes(cmd)) {
  fail("Usage: node scripts/go-live.mjs <status|safe|deploy|open|close> [address] [approvals] [--network localhost]");
}
if (cmd !== "close") await checkNode();
if (!mainnet) console.log("REHEARSAL on a local fork: fake money, Hardhat's public test accounts. This server's keys and .env are not touched.\n");

if (cmd === "status") {
  const operator = operatorAddress();
  const deployer = mainnet ? addressOf("DEPLOYER_PRIVATE_KEY") : null;
  const d = deployment();
  console.log(`Network: ${network}`);
  if (mainnet) {
    console.log(`Operator key (the agent):  ${operator ?? "missing: node scripts/keys.mjs create operator"}${operator ? `, holds ${await balance(operator)} for fees` : ""}`);
    console.log(`Deployer key (one-time):   ${deployer ?? (d ? "not on this server (not needed any more)" : "missing: node scripts/keys.mjs create deployer")}${deployer ? `, holds ${await balance(deployer)}` : ""}`);
    if (deployer && d) console.log("                           The contracts are deployed, so this key is no longer needed here: node scripts/keys.mjs remove deployer");
  } else {
    console.log(`Agent (test account 2):    ${operator}, holds ${await balance(operator)}`);
  }
  console.log(`Contracts:                 ${d ? `deployed ${d.deployedAt.slice(0, 10)}${d.verified === true ? "" : " (NOT VERIFIED: the deploy step did not finish its checks)"}; factory ${d.factory}; admin Safe ${d.safe}` : "not deployed yet"}`);
  if (d) {
    const onChain = await pub.readContract({ address: d.factory, abi: FACTORY_ABI, functionName: "defaultOperator" }).catch(() => null);
    console.log(`Factory's operator:        ${onChain ?? "could not be read on this chain"}${onChain ? (same(onChain, operator) ? " (matches the agent's key)" : " (DOES NOT match the agent's key)") : ""}`);
    const safe = isAddress(d.safe) ? await pub.readContract({ address: d.safe, abi: SAFE_ABI, functionName: "getOwners" }).catch(() => null) : null;
    if (safe) console.log(`Admin Safe:                ${safe.length} owner(s), ${await pub.readContract({ address: d.safe, abi: SAFE_ABI, functionName: "getThreshold" })} needed to approve`);
  }
  if (mainnet) {
    const open = envGet("LIVE_FACTORY_ADDRESS");
    const paused = /^(1|true|yes)$/i.test(envGet("LIVE_TRADING_PAUSED") ?? "");
    console.log(`Live trading on this site: ${!open ? "not opened yet" : paused ? `PAUSED (vaults stay reachable; factory ${open})` : `OPEN (factory ${open})`}`);
    if (open && d && !same(open, d.factory)) console.log("                           WARNING: .env names a different factory than the deployment record.");
  }
} else if (cmd === "safe") {
  const owners = (arg ?? "").split(",").filter(Boolean);
  if (!owners.length || !owners.every(isAddress)) fail("Give the wallet(s) that will own the Safe: node scripts/go-live.mjs safe 0xYourWallet   or   safe 0xYourWallet,0xSecondSigner 2");
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) fail("The same wallet is listed twice.");
  if (owners.length > 1 && !third) fail(`Say how many of the ${owners.length} wallets must approve, for example: node scripts/go-live.mjs safe ${owners.join(",")} 2`);
  const threshold = Number(third ?? 1);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) fail(`The number of approvals must be between 1 and ${owners.length}.`);
  await confirm(
    "CREATE",
    `This creates a Safe on Robinhood Chain owned by:\n  ${owners.join("\n  ")}\n${threshold} of ${owners.length} must approve each admin change.${owners.length === 1 ? " One owner is not a multisig: whoever holds that one wallet controls the admin." : ""}\nIt costs a small network fee, paid by the deployer key.`,
  );
  hardhat("create-safe.js", { SAFE_OWNERS: owners.join(","), SAFE_THRESHOLD: String(threshold) });
  console.log("Keep the SAFE_ADDRESS above. Next: node scripts/go-live.mjs deploy <that address>");
} else if (cmd === "deploy") {
  if (!isAddress(arg)) fail("Give your Safe's address: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = operatorAddress();
  if (!operator) fail("No operator key yet. Create it with: node scripts/keys.mjs create operator");
  if (mainnet && deployment()) fail(`Contracts are already deployed on ${network} (${deploymentFile}). Deploying again would create a second, separate set.`);
  if (same(arg, operator)) fail("The Safe and the agent's key must be different addresses.");
  const safe = await readSafe(arg);
  await confirm(
    "DEPLOY",
    `This deploys the Ratinole contracts to Robinhood Chain MAINNET.\n  Admin: your Safe ${arg}, behind a 3-day timelock\n    Safe owners (${safe.threshold} of ${safe.owners.length} must approve):\n      ${safe.owners.join("\n      ")}\n  Agent (operator and registry poster): ${operator}\nCheck that the owners above are wallets you control. It cannot be undone. It costs a small network fee, paid by the deployer key.`,
  );
  hardhat("deploy.js", { SAFE_ADDRESS: arg, OPERATOR_ADDRESS: operator, POSTER_ADDRESS: operator, ...(mainnet ? { CONFIRM_MAINNET: "deploy-ratinole-mainnet" } : {}) });
  console.log(`\nDeployed. Live trading is still closed on the site. Check \`node scripts/go-live.mjs status${mainnet ? "" : " --network localhost"}\`, then open it with \`node scripts/go-live.mjs open${mainnet ? "" : " --network localhost"}\`.`);
  if (mainnet) console.log("The deployer key is not needed any more. Move any ETH left on it, then: node scripts/keys.mjs remove deployer");
} else if (cmd === "open") {
  const d = deployment();
  if (!d) fail("The contracts are not deployed yet: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = operatorAddress();
  if (!operator) fail("No operator key on this server. Create it with: node scripts/keys.mjs create operator");
  const factory = await checkBeforeOpen(d, operator);
  console.log("Checked on-chain: the factory's operator is this server's agent key, its admin is the timelock, its tokens are the ones the site trades, the agent can pay fees, and a vault can be created.");
  if (!mainnet) {
    console.log(`\nRehearsal: nothing is written to .env. To run a local engine and API against the fork, start them with\n  LIVE_FACTORY_ADDRESS=${factory} LIVE_RPC_URL=${RPC}\nand the test operator key that contracts/scripts/fork-setup.js prints (never a real key).`);
  } else {
    await confirm("OPEN", "This opens live trading on the site for EVERYONE: any visitor can create a vault and trade real money.\nThe contracts have not had an independent security audit.");
    envSet({ LIVE_FACTORY_ADDRESS: factory, LIVE_TRADING_PAUSED: "" });
    console.log(`\nSet LIVE_FACTORY_ADDRESS=${factory} in .env.\nRestart to apply:  pm2 reload ecosystem.config.cjs --update-env`);
  }
} else if (cmd === "close") {
  if (!mainnet) fail("Nothing to close in a rehearsal: it never opened this site.");
  // The factory stays configured on purpose: taking it away would hide people's own vaults from them.
  envSet({ LIVE_TRADING_PAUSED: "1" });
  console.log("Live trading is paused after a restart:  pm2 reload ecosystem.config.cjs --update-env\nNo live agent will start or trade. Everyone can still see their vault on the site and withdraw from it.\nOpen again with: node scripts/go-live.mjs open");
}
