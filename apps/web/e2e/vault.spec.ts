/**
 * The Vault page against a pretend chain. This is the page that shows a person their real money, so the tests
 * are about what it must never do: show a balance it could not read as zero, offer "create a vault" to someone
 * who has one, or call a server that is down "vaults are not open".
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from "viem";

const ME = "0x7a3f00000000000000000000000000000000c1c2";
const FACTORY = "0xfac70000000000000000000000000000000000aa";
const AGENT = "0x0be7a70700000000000000000000000000000001";
const VAULT = "0x7a11700000000000000000000000000000000001";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ZERO = "0x0000000000000000000000000000000000000000";
const RPC = "https://robinhood.drpc.org";

const chainConfig = {
  live: true,
  trading: true,
  chainId: 4663,
  explorerUrl: "https://robinhoodchain.blockscout.com",
  factory: FACTORY,
  operator: AGENT,
  stable: { symbol: "USDG", address: USDG, decimals: 6 },
  tokens: [{ market: "ETH", symbol: "WETH", address: WETH, decimals: 18 }],
  limits: { minVaultUsd: 5, maxVaultUsd: 500, defaultSlippageBps: 100, defaultDailyLimitUsd: 200 },
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The site's own server. `chainDown` makes only the live-trading settings unreachable. */
async function mockApi(page: Page, opts: { chainDown?: () => boolean } = {}) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname.replace(/^\/api/, "")}`;
    if (key === "GET /me") return json(route, { address: ME, maxSizePct: 35, dailyLossCapPct: 3, agentCount: 0, maxAgents: 3 });
    if (key === "GET /public/chain") return opts.chainDown?.() ? route.abort("connectionrefused") : json(route, chainConfig);
    if (key === "GET /agents") return json(route, []);
    return json(route, { error: "not_found", message: "Not mocked" }, 404);
  });
}

interface ChainState {
  down: boolean;
  hasVault: boolean;
  operator: string;
  paused: boolean;
  vaultUsdg: bigint;
  walletUsdg: bigint;
  weth: bigint;
  /** 18 decimals; null = the oracle refuses (a stale price). */
  wethPrice: bigint | null;
}
const healthy = (): ChainState => ({
  down: false,
  hasVault: true,
  operator: AGENT,
  paused: false,
  vaultUsdg: 150_250_000n, // $150.25
  walletUsdg: 40_000_000n, // $40.00
  weth: 50_000_000_000_000_000n, // 0.05 WETH
  wethPrice: 2000n * 10n ** 18n,
});

const MULTICALL = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const sel = (sig: string) => toFunctionSelector(sig);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (type: string, value: unknown) => encodeAbiParameters([{ type }], [value]);

/** What one contract call returns on the pretend chain; null = it reverts. */
function answer(s: ChainState, to: string, data: Hex): Hex | null {
  const fn = data.slice(0, 10);
  const arg = `0x${data.slice(34, 74)}`;
  if (same(to, FACTORY)) {
    if (fn === sel("vaultOf(address)")) return word("address", s.hasVault && same(arg, ME) ? VAULT : ZERO);
    if (fn === sel("defaultOperator()")) return word("address", AGENT);
  }
  if (same(to, VAULT)) {
    if (fn === sel("paused()")) return word("bool", s.paused);
    if (fn === sel("operator()")) return word("address", s.operator);
    if (fn === sel("maxSlippageBps()")) return word("uint16", 100);
    if (fn === sel("dailyLimitUsd()")) return word("uint256", 200n * 10n ** 18n);
    if (fn === sel("remainingDailyUsd()")) return word("uint256", 180n * 10n ** 18n);
    if (fn === sel("priceUsd(address)")) return s.wethPrice == null ? null : word("uint256", s.wethPrice);
  }
  if (fn === sel("balanceOf(address)")) {
    if (same(to, USDG)) return word("uint256", same(arg, VAULT) ? s.vaultUsdg : same(arg, ME) ? s.walletUsdg : 0n);
    if (same(to, WETH)) return word("uint256", same(arg, VAULT) ? s.weth : 0n);
  }
  return null;
}

async function mockChain(page: Page, s: ChainState) {
  await page.route(`${RPC}/**`, (route) => handle(route));
  await page.route(RPC, (route) => handle(route));
  function handle(route: Route) {
    if (s.down) return route.abort("connectionrefused");
    const body = route.request().postDataJSON() as { id: number; method: string; params: [{ to: string; data: Hex }] };
    const reply = (result: unknown) => json(route, { jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_chainId") return reply("0x1237");
    if (body.method === "eth_blockNumber") return reply("0x10");
    if (body.method !== "eth_call") return json(route, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not mocked" } });
    const { to, data } = body.params[0];
    if (data.startsWith(sel("aggregate3((address,bool,bytes)[])"))) {
      const { args } = decodeFunctionData({ abi: MULTICALL, data });
      const results = args[0].map((c) => {
        const out = answer(s, c.target, c.callData);
        return { success: out != null, returnData: out ?? ("0x" as Hex) };
      });
      return reply(encodeFunctionResult({ abi: MULTICALL, functionName: "aggregate3", result: results }));
    }
    const out = answer(s, to, data);
    return out == null ? json(route, { jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: "0x" } }) : reply(out);
  }
}

/** Makes the page ask again now, as it does by itself every few seconds. */
const askAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));

test.describe("vault page", () => {
  test.describe.configure({ timeout: 90_000 });

  test("shows what the vault holds, read from the chain", async ({ page }) => {
    const chain = healthy();
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    // $150.25 of USDG and 0.05 WETH at $2,000.
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await expect(vault.locator(".vtotal")).toContainText("Value now");
    await expect(vault.getByText("Agent access on")).toBeVisible();
    await expect(vault.getByText("Not paused")).toBeVisible();
    await expect(vault.getByText("$180 of $200 left to trade in this 24-hour window")).toBeVisible();
    await expect(vault.getByText("In your wallet: $40.00 of USDG.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create my vault" })).toHaveCount(0);
    await expect(vault.getByRole("button", { name: "Revoke agent access" })).toBeVisible();
    await expect(vault.getByRole("button", { name: "Restore agent access" })).toHaveCount(0);
    // The worst case is stated for a window, with the fact that two windows can meet.
    await expect(vault.getByText("Most a stolen agent key could cost you in one 24-hour window")).toBeVisible();
    await expect(vault.getByText(/around the end of one it can be twice this/)).toBeVisible();
  });

  test("keeps the last reading on screen when the chain stops answering, and says how old it is", async ({ page }) => {
    const chain = healthy();
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    chain.down = true;
    await askAgain(page);
    await expect(vault.getByText(/Robinhood Chain could not be reached just now\. These numbers are from/)).toBeVisible({ timeout: 60_000 });
    // Still the real numbers: never zeros, and never an offer to create a vault the person already has.
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await expect(vault.getByText("Agent access on")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create my vault" })).toHaveCount(0);
    // When the chain answers again, the note goes away.
    chain.down = false;
    chain.vaultUsdg = 100_000_000n;
    await askAgain(page);
    await expect(vault.locator(".vtotal")).toContainText("$200.00", { timeout: 60_000 });
    await expect(vault.getByText(/could not be reached just now/)).toHaveCount(0);
  });

  test("a chain that cannot be reached is never shown as 'you have no vault'", async ({ page }) => {
    const chain = healthy();
    chain.down = true;
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    await expect(page.getByText(/cannot tell yet whether you have a vault/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Create my vault" })).toHaveCount(0);
    await expect(page.locator(".vtotal")).toHaveCount(0);
  });

  test("a wallet with no vault is offered one, with the default limits", async ({ page }) => {
    const chain = healthy();
    chain.hasVault = false;
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    await expect(page.getByRole("button", { name: "Create my vault" })).toBeVisible();
    await expect(page.getByText("Daily trading limit $200")).toBeVisible();
  });

  test("a token the oracle has no price for is left out of the total, and said so", async ({ page }) => {
    const chain = healthy();
    chain.wethPrice = null;
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("Value now, without WETH");
    await expect(vault.locator(".vtotal")).toContainText("$150.25");
    await expect(vault.getByText("no price now")).toBeVisible();
    await expect(vault.getByText(/The tokens are in your vault all the same/)).toBeVisible();
  });

  test("another key holding access is shown as that, and can be revoked", async ({ page }) => {
    const chain = healthy();
    chain.operator = "0xbad0000000000000000000000000000000000bad";
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.getByText("Another key has access")).toBeVisible();
    await expect(vault.getByText("A key that is not Ratinole's agent can trade this vault:")).toBeVisible();
    await expect(vault.getByRole("button", { name: "Revoke that key's access" })).toBeVisible();
    await expect(vault.getByRole("button", { name: "Switch access to Ratinole's agent" })).toBeVisible();
    await expect(vault.getByText("Agent access off")).toHaveCount(0);

    // With no key at all: off, one way to switch it on, and nothing to revoke.
    chain.operator = ZERO;
    await askAgain(page);
    await expect(vault.getByText("Agent access off")).toBeVisible({ timeout: 60_000 });
    await expect(vault.getByRole("button", { name: "Restore agent access" })).toBeVisible();
    await expect(vault.getByRole("button", { name: /Revoke/ })).toHaveCount(0);
  });

  test("an amount that could be read two ways is refused with the reason", async ({ page }) => {
    await mockApi(page);
    await mockChain(page, healthy());
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    const dep = vault.getByLabel("Deposit USDG");
    await dep.fill("1,000");
    await expect(vault.getByText("Is that 1.000 or 1000? Write it with a dot, or without the comma.")).toBeVisible();
    await dep.fill("999");
    await expect(vault.getByText("That is more than the $40.00 of USDG in your wallet.")).toBeVisible();
    await dep.fill("10,5");
    await expect(vault.getByText("In your wallet: $40.00 of USDG.")).toBeVisible();
    await dep.fill("1.23456789");
    await expect(vault.getByText(/Only 6 decimals count: using 1\.234567\./)).toBeVisible();
    const out = vault.getByLabel("Withdraw to your wallet");
    await out.fill("151");
    await expect(vault.getByText("That is more than the vault holds of USDG.")).toBeVisible();
    await out.fill("abc");
    await expect(vault.getByText("Use digits only, like 100 or 0.5.")).toBeVisible();
    // Max fills in exactly what is there.
    await vault.locator(".vform").nth(1).getByRole("button", { name: "Max" }).click();
    await expect(out).toHaveValue("150.25");
    await expect(vault.getByText(/It goes to 0x7a3f…c1c2, the wallet you signed in with\./)).toBeVisible();
  });

  test("a server that cannot be reached is not 'vaults are not open'", async ({ page }) => {
    await mockApi(page, { chainDown: () => true });
    await mockChain(page, healthy());
    await page.goto("/app/vault");
    await expect(page.getByText(/This site's server could not be reached, so this page cannot show a vault right now/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("No vault yet. Vaults open with live trading.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("with the server down, a returning visitor still reaches their vault to withdraw; nothing can be sent in", async ({ page }) => {
    let down = false;
    await mockApi(page, { chainDown: () => down });
    await mockChain(page, healthy());
    await page.goto("/app/vault");
    await expect(page.locator(".vtotal")).toContainText("$250.25");
    // Later, on the same device, the site's server is down.
    down = true;
    await page.reload();
    await expect(page.getByText("This site's server cannot be reached.")).toBeVisible({ timeout: 60_000 });
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await expect(vault.getByText("Deposits are off until this site's server answers again. Withdrawals work.")).toBeVisible();
    await vault.getByLabel("Deposit USDG").fill("5");
    await expect(vault.getByRole("button", { name: "Deposit" })).toBeDisabled();
    await expect(page.getByText("No vault yet. Vaults open with live trading.")).toHaveCount(0);
  });
});
