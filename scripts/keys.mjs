#!/usr/bin/env node
/**
 * Creates and shows the keys this server needs for live trading. Run it ON THE SERVER, as the app's user. The
 * keys are written to .env (which is never committed) and are never sent anywhere.
 *
 *   node scripts/keys.mjs create operator    create the agent's trading key; prints its ADDRESS only
 *   node scripts/keys.mjs create deployer    create a one-time key that pays the gas to deploy the contracts
 *   node scripts/keys.mjs address operator   print the address again
 *   node scripts/keys.mjs show operator      print the PRIVATE KEY, so you can write it down somewhere safe
 *
 * The operator key can only swap inside users' vaults, within each vault's limits. It can never withdraw.
 * Anyone who has it can still make bad trades up to those limits, so treat it like a password: never paste it
 * into a chat, an email, a screenshot or a commit.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const { generatePrivateKey, privateKeyToAccount } = createRequire(join(root, "apps", "engine", "package.json"))("viem/accounts");

const NAMES = { operator: "OPERATOR_PRIVATE_KEY", deployer: "DEPLOYER_PRIVATE_KEY" };
const [cmd, who] = process.argv.slice(2);
const variable = NAMES[who];
if (!["create", "address", "show"].includes(cmd) || !variable) {
  console.error("Usage: node scripts/keys.mjs <create|address|show> <operator|deployer>");
  process.exit(1);
}

const read = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
const current = () => read().match(new RegExp(`^${variable}=(0x[0-9a-fA-F]{64})\\s*$`, "m"))?.[1] ?? null;

if (cmd === "create") {
  let key = current();
  if (key) {
    console.log(`The ${who} key already exists. Nothing was changed.`);
  } else {
    key = generatePrivateKey();
    const text = read();
    const line = `${variable}=${key}`;
    const empty = new RegExp(`^${variable}=\\s*$`, "m");
    writeFileSync(envFile, empty.test(text) ? text.replace(empty, line) : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${line}\n`);
    chmodSync(envFile, 0o600);
    console.log(`Created the ${who} key and saved it in .env (readable only by this user).`);
  }
  console.log(`\n${who} address: ${privateKeyToAccount(key).address}\n`);
  console.log(
    who === "operator"
      ? "Next: back the key up (node scripts/keys.mjs show operator), and send this address a little ETH on Robinhood Chain: it pays the network fee of every trade."
      : "Next: send this address a little ETH on Robinhood Chain to pay for the deployment. It keeps no power afterwards.",
  );
} else {
  const key = current();
  if (!key) {
    console.error(`No ${who} key yet. Create it with: node scripts/keys.mjs create ${who}`);
    process.exit(1);
  }
  if (cmd === "address") console.log(privateKeyToAccount(key).address);
  else {
    console.log(`\n${who} address:     ${privateKeyToAccount(key).address}`);
    console.log(`${who} PRIVATE KEY: ${key}\n`);
    console.log("Write it down or put it in a password manager, then clear this screen (type: clear).");
    console.log("Never paste it into a chat, an email, a screenshot or a commit.");
  }
}
