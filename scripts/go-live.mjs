#!/usr/bin/env node
/**
 * The owner's steps to open live trading, run ON THE SERVER as the app's user. Each step that sends a
 * transaction or opens live trading asks you to type a word first. Nothing here is run by the build or by CI.
 *
 *   node scripts/go-live.mjs status                   what is set up, and what is missing
 *   node scripts/go-live.mjs safe 0xYou               create your Safe (the admin of the contracts), one owner
 *   node scripts/go-live.mjs safe 0xYou,0xOther 2     ... or several owners, and how many of them must approve
 *   node scripts/go-live.mjs deploy 0xSafeAddress     deploy the contracts to Robinhood Chain
 *   node scripts/go-live.mjs verify                   run the checks on the deployed contracts again (reads only)
 *   node scripts/go-live.mjs open                     turn live trading on for this site
 *   node scripts/go-live.mjs close                    pause live trading (everyone can still see and empty their vault)
 *
 * Keys come from .env (scripts/keys.mjs creates them). They are passed to the deploy tool in memory and are
 * never printed. The Safe's owners must be wallets you hold away from this server, never one of those keys.
 *
 * Add `--network localhost` to rehearse against a local fork with fake money. A rehearsal never reads this
 * server's keys and never writes .env: it signs with Hardhat's public test accounts only. (A transaction signed
 * with a real key for a local copy of the chain is also valid on the real chain, so real keys stay out of it.)
 * Without that exact option the script acts on the real chain, so anything it does not recognise stops it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const require = createRequire(join(root, "apps", "engine", "package.json"));
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, formatEther, http, parseEther } = require("viem");

const USAGE = [
  "Usage: node scripts/go-live.mjs <command> [--network localhost]",
  "  status                    what is set up, and what is missing",
  "  safe 0xYou                create your Safe with one owner",
  "  safe 0xYou,0xOther 2      ... or several owners, and how many must approve",
  "  deploy 0xSafeAddress      deploy the contracts",
  "  verify                    run the checks on the deployed contracts again",
  "  open                      turn live trading on for this site",
  "  close                     pause live trading",
  "--network localhost rehearses on a local fork. Without it, the command acts on Robinhood Chain and this site.",
].join("\n");

const fail = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

// ---- What was asked. Without `--network localhost` this script acts on the real chain and on this site, so
// anything it does not recognise (a misspelt option, a word too many) stops it before it does anything at all.
/** How many words each command takes after its name: least, most. */
const COMMANDS = { status: [0, 0], safe: [1, 2], deploy: [1, 1], verify: [0, 0], open: [0, 0], close: [0, 0] };
let chosenNetwork = null;
const words = [];
{
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    let value;
    if (a === "--network") value = raw[++i] ?? "";
    else if (a.startsWith("--network=")) value = a.slice("--network=".length);
    else if (a.startsWith("-")) fail(`Unknown option "${a}". The only option is --network localhost (a rehearsal). Nothing was done.\n\n${USAGE}`);
    else {
      words.push(a);
      continue;
    }
    if (chosenNetwork !== null) fail("--network is given twice. Nothing was done.");
    if (value !== "robinhood" && value !== "localhost") fail(`--network must be robinhood (the default) or localhost (a rehearsal on a local fork), not "${value}". Nothing was done.`);
    chosenNetwork = value;
  }
}
const network = chosenNetwork ?? "robinhood";
const [cmd, arg, third] = words;
if (!cmd || !Object.hasOwn(COMMANDS, cmd)) fail(cmd ? `Unknown command "${cmd}". Nothing was done.\n\n${USAGE}` : USAGE);
{
  const [least, most] = COMMANDS[cmd];
  const given = words.length - 1;
  if (given < least || given > most) {
    const takes = most === 0 ? "takes nothing after it" : least === most ? `takes ${least} word after it` : `takes ${least} or ${most} words after it`;
    fail(`"${cmd}" ${takes}, but ${given} ${given === 1 ? "was" : "were"} given: ${words.slice(1).join(" ") || "(none)"}. Nothing was done.\n\n${USAGE}`);
  }
}

const mainnet = network === "robinhood";
const RPC = mainnet ? process.env.ROBINHOOD_RPC_URL || "https://robinhood.drpc.org" : "http://127.0.0.1:8545";
const deploymentFile = join(root, "contracts", "deployments", `${network}.json`);
const rehearsalFlag = mainnet ? "" : " --network localhost";
/** Hardhat's public test accounts 0 and 2: the deployer and the agent in a rehearsal. Their keys are public and hold nothing real. */
const TEST_DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_OPERATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
/** The least ETH the agent's address must hold before the site is opened: about 160 trades at usual fees. */
const MIN_OPERATOR_ETH = "0.001";

// ---- .env, read and written the way Node reads it when the app starts (`node --env-file`).
const envText = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
/** Every line that sets `name`, with or without `export` and spaces. */
const assignments = (name) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "gm");
/**
 * A name written twice is a trap: the app uses the last line, and a tool that edits the first changes nothing
 * that matters (a "pause" that does not pause). This script never guesses between them.
 */
function once(name) {
  const lines = (envText().match(assignments(name)) ?? []).length;
  if (lines > 1) {
    fail(`${name} is written ${lines} times in .env. The app reads the last of them, so editing or trusting any one line could be wrong.\nOpen .env, keep ONE ${name} line and delete the others, then run this again. Nothing was changed.`);
  }
}
/** The value the app will read for `name`, or null when it is unset or empty. */
function envGet(name) {
  once(name);
  const value = parseEnv(envText())[name];
  return value == null || value.trim() === "" ? null : value.trim();
}
/** Changes .env in one step (never half written, never readable by other users), then reads it back. */
function envSet(pairs) {
  for (const name of Object.keys(pairs)) once(name);
  let text = envText();
  for (const [name, value] of Object.entries(pairs)) {
    const line = `${name}=${value}`;
    text = assignments(name).test(text) ? text.replace(assignments(name), () => line) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`;
  }
  const tmp = `${envFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envFile);
  // Trust nothing: read the file again exactly as the app will, and compare.
  const now = parseEnv(envText());
  const wrong = Object.entries(pairs).filter(([name, value]) => (now[name] ?? "") !== value).map(([name]) => name);
  if (wrong.length) {
    fail(`.env WAS WRITTEN, BUT IT DOES NOT READ BACK AS INTENDED for: ${wrong.join(", ")}.\nDo not restart anything yet. Open .env and set ${wrong.map((n) => `${n}=${pairs[n]}`).join(" and ")} by hand, on one line each.`);
  }
}
/**
 * A setting that is also exported in the shell wins over .env: Node keeps the environment's value, and
 * `pm2 reload --update-env` hands the app this shell's environment. Returns the warning to print, or "".
 */
function shellOverrides(pairs) {
  const clash = Object.entries(pairs).filter(([name, value]) => process.env[name] !== undefined && process.env[name] !== value);
  if (!clash.length) return "";
  const names = clash.map(([name]) => name);
  return `\nWARNING: this shell has ${names.join(" and ")} set, and a setting in the shell wins over .env.\nA reload from this shell would give the app the shell's value, not the one just written. Clear it first:\n  unset ${names.join(" ")}`;
}
/** The .env names each command reads or writes. They are checked for doubles before the command does anything. */
const USES = {
  status: ["OPERATOR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "LIVE_FACTORY_ADDRESS", "LIVE_TRADING_PAUSED"],
  safe: ["OPERATOR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"],
  deploy: ["OPERATOR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"],
  verify: [],
  open: ["OPERATOR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "LIVE_FACTORY_ADDRESS", "LIVE_TRADING_PAUSED"],
  close: ["LIVE_TRADING_PAUSED"],
};
if (mainnet) for (const name of USES[cmd]) once(name);

const keyOf = (name) => (/^0x[0-9a-fA-F]{64}$/.test(envGet(name) ?? "") ? envGet(name) : null);
const addressOf = (name) => (keyOf(name) ? privateKeyToAccount(keyOf(name)).address : null);
const operatorAddress = () => (mainnet ? addressOf("OPERATOR_PRIVATE_KEY") : TEST_OPERATOR);
const deployerAddress = () => (mainnet ? addressOf("DEPLOYER_PRIVATE_KEY") : TEST_DEPLOYER);
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The Safe is the admin of the contracts. A key that sits on this server should not be one of its owners:
 * whoever gets into the server would get the admin with it, and the deployer key is removed after deploying,
 * which would throw the admin away for good.
 *
 * There is one way around this, for an owner who wants two wallets and no third: `safe deployer` makes the
 * deployer key the Safe's one owner. It is then the ADMIN key for good. The owner is told so before anything is
 * sent, must have it backed up, and must take it off this server before the site opens. The agent's key (the
 * operator) is never accepted: it signs every hour and is the most exposed key there is.
 */
const deployerOwns = (owners) => !!deployerAddress() && owners.some((o) => same(o, deployerAddress()));
const operatorOwns = (owners) => !!operatorAddress() && owners.some((o) => same(o, operatorAddress()));
const ADMIN_KEY_RULES =
  "  - Back it up NOW if you have not:  node scripts/keys.mjs show deployer\n" +
  "  - If it is lost, the admin of the contracts is lost with it. Nobody can get it back.\n" +
  "  - Whoever has it controls the admin. Every change still waits 3 days in the timelock.\n" +
  "  - Before the site opens it is taken off this server (node scripts/keys.mjs remove deployer). Your backup is then the only copy.\n" +
  "  - You can hand the admin to another wallet later, from the Safe.";
function serverKeyAmong(owners) {
  for (const [label, address] of [["deployer key", deployerAddress()], ["agent's key (the operator)", operatorAddress()]]) {
    if (address && owners.some((o) => same(o, address))) return { label, address };
  }
  return null;
}
const serverKeyRefusal = ({ label, address }) =>
  `${address} is this server's ${label}. It cannot be an owner of the Safe.\nThe Safe is the admin of the contracts. Its owners must be wallets you hold yourself, away from this server (your own wallet app, or a hardware wallet). A key on the server is exposed to whoever gets into the server, and the deployer key is removed after deploying.\nNothing was sent.`;

async function confirm(word, what) {
  if (!mainnet) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n${what}\nType ${word} to continue, anything else to stop: `);
  rl.close();
  if (answer.trim() !== word) fail("Stopped. Nothing was sent.");
}

/**
 * Runs a contracts script. A rehearsal gets no key at all. On mainnet a script that sends transactions gets the
 * deployer key, in its environment only; one that only reads (`needsKey` false) gets none.
 */
function hardhat(script, extraEnv = {}, needsKey = true) {
  const env = { ...process.env, ...extraEnv };
  delete env.DEPLOYER_PRIVATE_KEY;
  delete env.OPERATOR_PRIVATE_KEY;
  if (mainnet && needsKey) {
    const deployer = keyOf("DEPLOYER_PRIVATE_KEY");
    if (!deployer) fail("No deployer key yet. Create it with: node scripts/keys.mjs create deployer");
    env.DEPLOYER_PRIVATE_KEY = deployer;
  }
  const res = spawnSync("pnpm", ["--filter", "@rationale/contracts", "exec", "hardhat", "run", `scripts/${script}`, "--network", network], { cwd: root, stdio: "inherit", env });
  return res.status === 0;
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
const DEV_NODE = /hardhat|anvil|ganache|foundry/i;

/** Mainnet commands only ever talk to the real chain; a rehearsal only ever talks to a local Hardhat fork. */
async function checkNode() {
  if (mainnet) {
    // With ROBINHOOD_RPC_URL pointed at a local fork, "mainnet" would hand the real deployer key to that fork and
    // record its contracts as the real deployment.
    let host = "";
    try {
      host = new URL(RPC).hostname.replace(/^\[|\]$/g, "");
    } catch {
      fail("ROBINHOOD_RPC_URL is not a URL. Nothing was done.");
    }
    if (["localhost", "::1", "0.0.0.0"].includes(host) || /^127\./.test(host)) {
      fail(`ROBINHOOD_RPC_URL points at this machine (${host}), which is not Robinhood Chain. For a rehearsal on a local fork add --network localhost. Nothing was done.`);
    }
    const id = await pub.getChainId().catch(() => fail(`Robinhood Chain could not be reached at ${host}. Try again in a moment.`));
    if (id !== 4663) fail(`The RPC answers for chain ${id}, not Robinhood Chain (4663). Nothing was done.`);
    const client = await pub.request({ method: "web3_clientVersion" }).catch(() => "");
    if (DEV_NODE.test(String(client))) fail(`The RPC at ${host} is a development node (${client}), not Robinhood Chain. For a rehearsal add --network localhost. Nothing was done.`);
    return;
  }
  const client = await pub.request({ method: "web3_clientVersion" }).catch(() => null);
  if (!client) fail("No local node at http://127.0.0.1:8545. Start one:  FORK=1 pnpm --filter @rationale/contracts exec hardhat node");
  if (!/hardhat/i.test(client)) fail(`The node at 127.0.0.1:8545 is not a Hardhat fork (${client}). A rehearsal only runs against one.`);
}

/** The owners and threshold of the Safe at `address`, or null when it cannot be read as a Safe. */
async function safeAt(address) {
  try {
    const [owners, threshold] = await Promise.all([
      pub.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }),
      pub.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }),
    ]);
    if (!owners.length || threshold < 1n || threshold > BigInt(owners.length)) return null;
    return { owners, threshold: Number(threshold) };
  } catch {
    return null;
  }
}
/** The same, for a step that needs it: stops if there is no Safe there on this chain. */
async function readSafe(address) {
  const code = await pub.getCode({ address });
  if (!code || code === "0x") fail(`There is no contract at ${address} on this chain. A Safe created on another network does not exist here: create one with  node scripts/go-live.mjs safe 0xYourWallet`);
  return (await safeAt(address)) ?? fail(`The contract at ${address} does not answer like a Safe. Nothing was sent.`);
}

/** Everything that must be true on-chain before the site is opened. Returns the factory's address. */
async function checkBeforeOpen(d, operator) {
  if (d.verified !== true) {
    fail(`The deployment record (${deploymentFile}) is not marked as verified: the deploy step did not finish its checks.\nRun them again:  node scripts/go-live.mjs verify${rehearsalFlag}\nDo not open until they pass.`);
  }
  const factory = { address: d.factory, abi: FACTORY_ABI };
  const [onChainOperator, admin, defaults] = await Promise.all([
    pub.readContract({ ...factory, functionName: "defaultOperator" }),
    pub.readContract({ ...factory, functionName: "admin" }),
    pub.readContract({ ...factory, functionName: "getDefaults" }),
  ]).catch(() => fail(`The factory at ${d.factory} could not be read on this chain. Do not open.`));
  if (!same(onChainOperator, operator)) fail(`The factory gives new vaults the operator ${onChainOperator}, which is not this server's agent key (${operator}).\nDo not open until they match: vaults would be created for a key this server does not hold.`);
  if (!same(admin, d.timelock)) fail(`The factory's admin is ${admin}, not the timelock in the record (${d.timelock}). Do not open.`);
  const safe = isAddress(d.safe) ? await safeAt(d.safe) : null;
  if (!safe) fail(`The admin Safe in the record (${d.safe}) could not be read as a Safe on this chain. Do not open.`);
  if (operatorOwns(safe.owners)) fail(`${operatorAddress()}, this server's agent key, is an owner of the admin Safe.\nThe key that trades must not hold the admin. In the Safe, replace that owner with a wallet you hold yourself. Do not open.`);
  // The deployer key as the admin key is the owner's choice (`safe deployer`), but not while it sits on this
  // server next to the site: it is backed up and taken off first. A rehearsal has only public test keys.
  if (mainnet && deployerOwns(safe.owners)) {
    fail(`The admin Safe is owned by the deployer key, and that key is still on this server.\nBefore the site opens, the admin key has to be off the server:\n  1. check that you have it backed up:  node scripts/keys.mjs show deployer\n  2. take it off this server:          node scripts/keys.mjs remove deployer\nThen run open again. Nothing was changed.`);
  }
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
  } else {
    console.log(`Agent (test account 2):    ${operator}, holds ${await balance(operator)}`);
  }
  console.log(`Contracts:                 ${d ? `deployed ${d.deployedAt.slice(0, 10)}${d.verified === true ? "" : " (NOT VERIFIED: the deploy step did not finish its checks)"}; factory ${d.factory}; admin Safe ${d.safe}` : "not deployed yet"}`);
  if (d && d.verified !== true) console.log(`                           Run the checks again: node scripts/go-live.mjs verify${rehearsalFlag}`);
  if (d) {
    const onChain = await pub.readContract({ address: d.factory, abi: FACTORY_ABI, functionName: "defaultOperator" }).catch(() => null);
    console.log(`Factory's operator:        ${onChain ?? "could not be read on this chain"}${onChain ? (same(onChain, operator) ? " (matches the agent's key)" : " (DOES NOT match the agent's key)") : ""}`);
    const safe = isAddress(d.safe) ? await safeAt(d.safe) : null;
    console.log(`Admin Safe:                ${safe ? `${safe.owners.length} owner(s), ${safe.threshold} needed to approve` : "could not be read as a Safe on this chain"}`);
    if (safe && operatorOwns(safe.owners)) {
      console.log(`                           WARNING: ${operatorAddress()}, this server's agent key, is an owner of the Safe.`);
      console.log("                           Replace that owner in the Safe with a wallet you hold yourself.");
    } else if (safe && deployerOwns(safe.owners)) {
      console.log("                           Its owner is this server's deployer key: that key is your ADMIN key.");
      console.log("                           Check your backup (node scripts/keys.mjs show deployer), then take it off this server before opening: node scripts/keys.mjs remove deployer");
    } else if (safe && isAddress(d.deployer) && safe.owners.some((o) => same(o, d.deployer))) {
      console.log(`                           Its owner is the deployer key (${d.deployer}), which is not on this server: your backup of it is the admin key.`);
    } else if (mainnet && deployer && d.verified === true) {
      console.log("Deployer key:              no longer needed on this server. Move any ETH left on it, then: node scripts/keys.mjs remove deployer");
    }
  }
  if (mainnet) {
    const open = envGet("LIVE_FACTORY_ADDRESS");
    const paused = /^(1|true|yes)$/i.test(envGet("LIVE_TRADING_PAUSED") ?? "");
    console.log(`Live trading on this site: ${!open ? "not opened yet" : paused ? `PAUSED (vaults stay reachable; factory ${open})` : `OPEN (factory ${open})`}`);
    console.log("                           (as written in .env; the running app follows it after: pm2 reload ecosystem.config.cjs --update-env)");
    const inShell = ["LIVE_FACTORY_ADDRESS", "LIVE_TRADING_PAUSED"].filter((name) => process.env[name] !== undefined && process.env[name] !== (envGet(name) ?? ""));
    if (inShell.length) console.log(`                           WARNING: this shell has ${inShell.join(" and ")} set to something else; a reload from this shell would use that. Clear it: unset ${inShell.join(" ")}`);
    if (open && d && !same(open, d.factory)) console.log("                           WARNING: .env names a different factory than the deployment record.");
  }
} else if (cmd === "safe" && arg === "deployer") {
  // Two wallets and no third: the deployer key owns the Safe, and so becomes the admin key.
  const deployer = deployerAddress();
  if (!deployer) fail("No deployer key yet. Create it with: node scripts/keys.mjs create deployer");
  await confirm("CREATE", `This creates a Safe on Robinhood Chain owned by this server's deployer key:\n  ${deployer}\n\nThat key becomes your ADMIN key, for good:\n${ADMIN_KEY_RULES}`);
  if (!hardhat("create-safe.js", { SAFE_OWNERS: deployer, SAFE_THRESHOLD: "1", SAFE_FORBIDDEN_OWNERS: operatorAddress() ?? "", SAFE_OWNER_IS_DEPLOYER: "1" })) {
    fail("That step failed. Read the message above. If it printed a Safe address, keep it.");
  }
  console.log(`Keep the SAFE_ADDRESS above. Next: node scripts/go-live.mjs deploy <that address>${rehearsalFlag}`);
} else if (cmd === "safe") {
  const owners = arg.split(",").filter(Boolean);
  if (!owners.length || !owners.every(isAddress)) fail("Give the wallet(s) that will own the Safe: node scripts/go-live.mjs safe 0xYourWallet   or   safe 0xYourWallet,0xSecondSigner 2\nWith no wallet of your own, the deployer key can own it:  node scripts/go-live.mjs safe deployer");
  if (owners.some((o) => /^0x0{40}$/.test(o))) fail("The zero address cannot own a Safe.");
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length) fail("The same wallet is listed twice.");
  const onServer = serverKeyAmong(owners);
  if (onServer) {
    const twoWallets = onServer.label === "deployer key" ? `\nIf you want the deployer key to own the Safe on purpose (two wallets and no third), say so:  node scripts/go-live.mjs safe deployer${rehearsalFlag}` : "";
    fail(`${serverKeyRefusal(onServer)}${twoWallets}`);
  }
  if (owners.length > 1 && !third) fail(`Say how many of the ${owners.length} wallets must approve, for example: node scripts/go-live.mjs safe ${owners.join(",")} 2`);
  const threshold = Number(third ?? 1);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) fail(`The number of approvals must be between 1 and ${owners.length}.`);
  await confirm(
    "CREATE",
    `This creates a Safe on Robinhood Chain owned by:\n  ${owners.join("\n  ")}\n${threshold} of ${owners.length} must approve each admin change.${owners.length === 1 ? " One owner is not a multisig: whoever holds that one wallet controls the admin." : ""}\nCheck that each of these is a wallet you hold yourself, away from this server.\nIt costs a small network fee, paid by the deployer key.`,
  );
  const forbidden = [deployerAddress(), operatorAddress()].filter(Boolean).join(",");
  if (!hardhat("create-safe.js", { SAFE_OWNERS: owners.join(","), SAFE_THRESHOLD: String(threshold), SAFE_FORBIDDEN_OWNERS: forbidden })) {
    fail("That step failed. Read the message above. If it printed a Safe address, keep it.");
  }
  console.log(`Keep the SAFE_ADDRESS above. Next: node scripts/go-live.mjs deploy <that address>${rehearsalFlag}`);
} else if (cmd === "deploy") {
  if (!isAddress(arg)) fail("Give your Safe's address: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = operatorAddress();
  if (!operator) fail("No operator key yet. Create it with: node scripts/keys.mjs create operator");
  const existing = deployment();
  if (mainnet && existing) {
    fail(
      existing.verified === true
        ? `Contracts are already deployed on ${network} (${deploymentFile}). Deploying again would create a second, separate set.`
        : `Contracts are already deployed on ${network} (${deploymentFile}), but their checks have not all passed.\nDo not deploy again. Run the checks:  node scripts/go-live.mjs verify`,
    );
  }
  if (same(arg, operator) || same(arg, deployerAddress())) fail("The Safe must be a different address from the keys on this server.");
  const safe = await readSafe(arg);
  if (operatorOwns(safe.owners)) {
    fail(`The Safe at ${arg} cannot be used as the admin.\n${serverKeyRefusal({ label: "agent's key (the operator)", address: operatorAddress() })}\nCreate a Safe owned by your own wallet:  node scripts/go-live.mjs safe 0xYourWallet${rehearsalFlag}`);
  }
  // The deployer key as the Safe's owner is allowed only as its one owner, the way `safe deployer` makes it.
  const adminIsDeployer = deployerOwns(safe.owners);
  if (adminIsDeployer && safe.owners.length !== 1) fail(`The Safe at ${arg} has this server's deployer key among several owners. Use a Safe whose owners are all wallets you hold yourself, or one made with:  node scripts/go-live.mjs safe deployer${rehearsalFlag}`);
  if (adminIsDeployer) console.log(`\nThe Safe's owner is this server's deployer key. It is your ADMIN key, for good:\n${ADMIN_KEY_RULES}`);
  await confirm(
    "DEPLOY",
    `This deploys the Ratinole contracts to Robinhood Chain MAINNET.\n  Admin: your Safe ${arg}, behind a 3-day timelock\n    Safe owners (${safe.threshold} of ${safe.owners.length} must approve):\n      ${safe.owners.join("\n      ")}\n  Agent (operator and registry poster): ${operator}\nCheck that the owners above are wallets you control. It cannot be undone. It costs a small network fee, paid by the deployer key.`,
  );
  if (!hardhat("deploy.js", { SAFE_ADDRESS: arg, OPERATOR_ADDRESS: operator, POSTER_ADDRESS: operator, ...(adminIsDeployer ? { ADMIN_KEY_IS_DEPLOYER: "1" } : {}), ...(mainnet ? { CONFIRM_MAINNET: "deploy-ratinole-mainnet" } : {}) })) {
    fail(`That step failed. Read the message above.\nIf it printed contract addresses, the contracts exist: keep the addresses, do NOT deploy again, and run  node scripts/go-live.mjs verify${rehearsalFlag}`);
  }
  console.log(`\nDeployed. Live trading is still closed on the site. Check \`node scripts/go-live.mjs status${rehearsalFlag}\`, then open it with \`node scripts/go-live.mjs open${rehearsalFlag}\`.`);
  if (mainnet && adminIsDeployer) console.log("The deployer key is your ADMIN key. Check that you have it backed up (node scripts/keys.mjs show deployer), then take it off this server: node scripts/keys.mjs remove deployer");
  else if (mainnet) console.log("The deployer key is not needed any more. Move any ETH left on it, then: node scripts/keys.mjs remove deployer");
} else if (cmd === "verify") {
  if (!deployment()) fail(`There is nothing to check: no deployment is recorded for ${network}. Deploy first: node scripts/go-live.mjs deploy 0xSafeAddress${rehearsalFlag}`);
  // Reads only: no key is given to it, and nothing is sent.
  if (!hardhat("verify-deployment.js", {}, false)) fail("The checks did not all pass. Read the message above. Do not open the site.");
  console.log(`\nNext: node scripts/go-live.mjs open${rehearsalFlag}`);
} else if (cmd === "open") {
  const d = deployment();
  if (!d) fail("The contracts are not deployed yet: node scripts/go-live.mjs deploy 0xSafeAddress");
  const operator = operatorAddress();
  if (!operator) fail("No operator key on this server. Create it with: node scripts/keys.mjs create operator");
  const factory = await checkBeforeOpen(d, operator);
  console.log("Checked on-chain: the factory's operator is this server's agent key, its admin is the timelock, the Safe's owners are not keys on this server, its tokens are the ones the site trades, the agent can pay fees, and a vault can be created.");
  if (!mainnet) {
    console.log(`\nRehearsal: nothing is written to .env. To run a local engine and API against the fork, start them with\n  LIVE_FACTORY_ADDRESS=${factory} LIVE_RPC_URL=${RPC}\nand the test operator key that contracts/scripts/fork-setup.js prints (never a real key).`);
  } else {
    await confirm("OPEN", "This opens live trading on the site for EVERYONE: any visitor can create a vault and trade real money.\nThe contracts have not had an independent security audit.");
    const settings = { LIVE_FACTORY_ADDRESS: factory, LIVE_TRADING_PAUSED: "" };
    envSet(settings);
    console.log(`\nSet LIVE_FACTORY_ADDRESS=${factory} in .env, and read it back.${shellOverrides(settings)}\nRestart to apply:  pm2 reload ecosystem.config.cjs --update-env`);
  }
} else if (cmd === "close") {
  if (!mainnet) fail("Nothing to close in a rehearsal: it never opened this site.");
  // The factory stays configured on purpose: taking it away would hide people's own vaults from them.
  envSet({ LIVE_TRADING_PAUSED: "1" });
  console.log(`LIVE_TRADING_PAUSED=1 is written in .env, and read back.${shellOverrides({ LIVE_TRADING_PAUSED: "1" })}\nIt takes effect when the app restarts. Do that now:  pm2 reload ecosystem.config.cjs --update-env\nAfter that no live agent will start or trade. Everyone can still see their vault on the site and withdraw from it.\nOpen again with: node scripts/go-live.mjs open`);
}
