#!/usr/bin/env node
/**
 * Creates and shows the keys this server needs for live trading. Run it ON THE SERVER, as the app's user. The
 * keys are written to .env (which is never committed) and are never sent anywhere.
 *
 *   node scripts/keys.mjs create operator    create the agent's trading key; prints its ADDRESS only
 *   node scripts/keys.mjs create deployer    create a one-time key that pays the gas to deploy the contracts
 *   node scripts/keys.mjs address operator   print the address again
 *   node scripts/keys.mjs show operator      print the PRIVATE KEY, so you can write it down somewhere safe
 *   node scripts/keys.mjs remove deployer    take the deployer key off this server once the contracts are deployed
 *
 * The operator key can only swap inside users' vaults, within each vault's limits. It can never withdraw.
 * Anyone who has it can still make bad trades up to those limits, so treat it like a password: never paste it
 * into a chat, an email, a screenshot or a commit.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const { generatePrivateKey, privateKeyToAccount } = createRequire(join(root, "apps", "engine", "package.json"))("viem/accounts");

const NAMES = { operator: "OPERATOR_PRIVATE_KEY", deployer: "DEPLOYER_PRIVATE_KEY" };
const [cmd, who] = process.argv.slice(2);
const variable = NAMES[who];
if (!["create", "address", "show", "remove"].includes(cmd) || !variable) {
  console.error("Usage: node scripts/keys.mjs <create|address|show> <operator|deployer>\n       node scripts/keys.mjs remove deployer");
  process.exit(1);
}
const stop = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

const read = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
const isLine = (line) => new RegExp(`^\\s*(export\\s+)?${variable}\\s*=`).test(line);
/** Writes .env so that it is never readable by other users, not even for a moment, and never half written. */
function write(text) {
  const tmp = `${envFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, envFile);
}

/**
 * The key in .env, or null when there is none. Anything else written there (a key in another form, two lines)
 * stops the script: creating a second key next to a first one would leave two addresses and no way to tell
 * which one the app uses.
 */
function current() {
  const lines = read().split("\n").filter(isLine);
  if (lines.length > 1) stop(`${variable} is written ${lines.length} times in .env. Keep one line and remove the others by hand. Nothing was changed.`);
  if (!lines.length) return null;
  const value = lines[0].slice(lines[0].indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  if (value === "") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    stop(`${variable} in .env already has a value, but not in the form this app reads (0x followed by 64 hex characters, no quotes).\nNothing was changed. Fix that line by hand, or remove it if that key holds nothing.`);
  }
  return value;
}

if (cmd === "create") {
  let key = current();
  if (key) {
    console.log(`The ${who} key already exists. Nothing was changed.`);
  } else {
    key = generatePrivateKey();
    const text = read();
    const line = `${variable}=${key}`;
    const lines = text.split("\n");
    const at = lines.findIndex(isLine);
    if (at >= 0) lines[at] = line;
    write(at >= 0 ? lines.join("\n") : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${line}\n`);
    console.log(`Created the ${who} key and saved it in .env (readable only by this user).`);
  }
  console.log(`\n${who} address: ${privateKeyToAccount(key).address}\n`);
  console.log(
    who === "operator"
      ? "Next: back the key up (node scripts/keys.mjs show operator), and send this address a little ETH on Robinhood Chain: it pays the network fee of every trade."
      : "Next: send this address a little ETH on Robinhood Chain to pay for the deployment. It keeps no power afterwards,\nunless you make it the owner of your Safe (node scripts/go-live.mjs safe deployer): then it is your admin key.",
  );
} else if (cmd === "remove") {
  if (who !== "deployer") stop("Only the deployer key can be removed here. The operator key is the agent's key: without it no live agent can trade.");
  const key = current();
  if (!key) stop("There is no deployer key in .env. Nothing to remove.");
  const address = privateKeyToAccount(key).address;
  console.log(`\nDeployer address: ${address}`);
  console.log("If this key owns your Safe (you ran: go-live.mjs safe deployer), it is your ADMIN key. After this, your backup");
  console.log("of it is the only copy, and without it the admin of the contracts is lost for good. Check that you have it:");
  console.log("  node scripts/keys.mjs show deployer");
  console.log("Otherwise it has no power over the contracts. Any ETH still at that address is lost with the key, unless you");
  console.log("have backed the key up or moved the ETH away first.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nType REMOVE to take the deployer key off this server, anything else to stop: ");
  rl.close();
  if (answer.trim() !== "REMOVE") stop("Stopped. Nothing was changed.");
  write(read().split("\n").filter((l) => !isLine(l)).join("\n"));
  console.log("Removed the deployer key from .env.");
} else {
  const key = current();
  if (!key) stop(`No ${who} key yet. Create it with: node scripts/keys.mjs create ${who}`);
  if (cmd === "address") console.log(privateKeyToAccount(key).address);
  else {
    console.log(`\n${who} address:     ${privateKeyToAccount(key).address}`);
    console.log(`${who} PRIVATE KEY: ${key}\n`);
    console.log("Write it down or put it in a password manager, then clear this screen (type: clear).");
    console.log("Never paste it into a chat, an email, a screenshot or a commit.");
  }
}
