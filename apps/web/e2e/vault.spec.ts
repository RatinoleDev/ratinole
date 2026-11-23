/**
 * The Vault page against a pretend chain. This is the page that shows a person their real money, so the tests
 * are about what it must never do: show a balance it could not read as zero, offer "create a vault" to someone
 * who has one, or call a server that is down "vaults are not open".
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, zeroHash, type Hex } from "viem";

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
  limits: { minVaultUsd: 5, maxVaultUsd: 500, defaultSlippageBps: 100, defaultDailyLimitUsd: 500 },
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The site's own server. `chainDown` makes only the live-trading settings unreachable; `allDown` refuses every
 * call, as when the API process is not running.
 */
async function mockApi(page: Page, opts: { chainDown?: () => boolean; allDown?: () => boolean } = {}) {
  await page.route("**/api/**", async (route) => {
    if (opts.allDown?.()) return route.abort("connectionrefused");
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
  /** ETH in the connected wallet, in wei. */
  walletEth: bigint;
  /** What the ETH/USDG pool pays for one ETH, in USDG's smallest unit. Null: the pool cannot quote (the call reverts). */
  poolUsdgPerEth: bigint | null;
  /** Who the vault says owns it. */
  owner: string;
  pendingOwner: string;
  pendingUntil: bigint;
  recovery: string;
  recoveryReadyAt: bigint;
  /** What the chain says about a transaction. A hash not listed here is confirmed at once, as on a fast chain. */
  receipts: Record<string, "success" | "none">;
  /** Transactions the chain knows as waiting, by hash. */
  waiting: Record<string, SentTx>;
  /** Transactions in the newest block. */
  inBlock: (SentTx & { hash: string })[];
}
type SentTx = { from: string; to: string; nonce: number; input: Hex };
const healthy = (): ChainState => ({
  down: false,
  hasVault: true,
  walletEth: 20_000_000_000_000_000n, // 0.02 ETH
  poolUsdgPerEth: 1_990_000_000n, // $1,990, a little under the oracle's $2,000
  operator: AGENT,
  paused: false,
  vaultUsdg: 150_250_000n, // $150.25
  walletUsdg: 40_000_000n, // $40.00
  weth: 50_000_000_000_000_000n, // 0.05 WETH
  wethPrice: 2000n * 10n ** 18n,
  owner: ME,
  pendingOwner: ZERO,
  pendingUntil: 0n,
  recovery: ZERO,
  recoveryReadyAt: 0n,
  receipts: {},
  waiting: {},
  inBlock: [],
});

const MULTICALL = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const SWAP_ROUTER = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
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
    if (fn === sel("owner()")) return word("address", s.owner);
    if (fn === sel("pendingOwner()")) return word("address", s.pendingOwner);
    if (fn === sel("pendingOwnerExpiresAt()")) return word("uint64", s.pendingUntil);
    if (fn === sel("recovery()")) return word("address", s.recovery);
    if (fn === sel("recoveryReadyAt()")) return word("uint64", s.recoveryReadyAt);
  }
  // A wallet's ETH, asked for through the batching contract as the page's chain client does.
  if (fn === sel("getEthBalance(address)")) return word("uint256", same(arg, ME) ? s.walletEth : 0n);
  // The router quotes a swap of ETH into USDG at the pool's price, and reverts when asked for more than that.
  if (same(to, ROUTER) && fn === toFunctionSelector(SWAP_ROUTER[0])) {
    const [q] = decodeFunctionData({ abi: SWAP_ROUTER, data }).args as unknown as [{ amountIn: bigint; amountOutMinimum: bigint }];
    if (s.poolUsdgPerEth == null) return null;
    const out = (q.amountIn * s.poolUsdgPerEth) / 10n ** 18n;
    return out >= q.amountOutMinimum ? word("uint256", out) : null;
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
    if (body.method === "eth_blockNumber") return reply(BLOCK);
    if (body.method === "eth_getBalance") return reply(`0x${s.walletEth.toString(16)}`);
    const first = (body.params as unknown[])[0] as string;
    if (body.method === "eth_getTransactionReceipt") {
      if (s.receipts[first] === "none") return reply(null);
      return reply({ ...MINED, transactionHash: first, from: ME, to: VAULT, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"0".repeat(512)}`, status: "0x1", type: "0x2" });
    }
    if (body.method === "eth_getTransactionByHash") {
      const t = s.waiting[first];
      return reply(t ? rpcTx(first, t, false) : null);
    }
    if (body.method === "eth_getBlockByNumber") {
      return reply({ number: BLOCK, hash: MINED.blockHash, parentHash: zeroHash, timestamp: "0x6920f1a0", gasLimit: "0x1c9c380", gasUsed: "0x5208", baseFeePerGas: "0x1", miner: ZERO, transactions: s.inBlock.map((t) => rpcTx(t.hash, t, true)), uncles: [] });
    }
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

const BLOCK = "0x10";
const MINED = { blockNumber: BLOCK, blockHash: `0x${"b1".repeat(32)}`, transactionIndex: "0x0" };
/** A transaction as a node reports it: waiting (no block yet) or mined in the newest block. */
const rpcTx = (hash: string, t: SentTx, mined: boolean) => ({
  hash,
  from: t.from,
  to: t.to,
  nonce: `0x${t.nonce.toString(16)}`,
  input: t.input,
  value: "0x0",
  gas: "0x30d40",
  maxFeePerGas: "0x2",
  maxPriorityFeePerGas: "0x1",
  type: "0x2",
  chainId: "0x1237",
  ...(mined ? MINED : { blockNumber: null, blockHash: null, transactionIndex: null }),
});

/**
 * A pretend browser wallet for the account the tests are signed in as, already on Robinhood Chain. It announces
 * itself the standard way (EIP-6963). Each transaction it is asked to send is handed to `onSend`, which returns
 * the hash the wallet answers with. Like a real wallet it remembers that this site was approved.
 */
async function fakeWallet(page: Page, onSend: (tx: { to: string; data: Hex; from?: string; value?: Hex }) => string) {
  await page.exposeFunction("__walletSend", onSend);
  await page.addInitScript((account) => {
    const approved = () => window.localStorage.getItem("__fakeWalletApproved") === "1";
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts") {
          window.localStorage.setItem("__fakeWalletApproved", "1");
          return [account];
        }
        if (method === "eth_accounts") return approved() ? [account] : [];
        if (method === "eth_chainId") return "0x1237";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        if (method === "eth_sendTransaction") return (window as unknown as { __walletSend: (tx: unknown) => Promise<string> }).__walletSend(params![0]);
        return null;
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#6A5ACD"/></svg>');
    const detail = Object.freeze({ info: { uuid: "1b2c3d4e-0000-4000-8000-0000000000aa", name: "Test Wallet", icon, rdns: "xyz.testwallet" }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, ME);
}

/** Connects the pretend wallet from the panel that asks for it. Nothing is signed and the server is not asked. */
async function connectWallet(page: Page) {
  await page.locator(".panel.connect").getByRole("button", { name: "Connect wallet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await dialog.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

const hashOf = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

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
    // The figure is for normal conditions and is not called a maximum; what makes it larger is said.
    await expect(vault.getByText("What a stolen agent key could cost you in one 24-hour window, in normal conditions")).toBeVisible();
    await expect(vault.locator(".worst b")).toHaveText("$3.60");
    await expect(vault.getByText(/This is not a maximum\. Two windows can meet, which doubles it\./)).toBeVisible();
    await expect(vault.getByText(/If the price feed stops updating while the market moves, the loss in a window can be as large as the daily limit times that move\./)).toBeVisible();
    await expect(vault.getByText(/Most a stolen agent key/)).toHaveCount(0);
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
    await expect(page.getByText("Daily trading limit $500")).toBeVisible();
    // The limit counts buys and sales together, and the page says what that means for one buy.
    await expect(page.getByText(/Buys and sales both count towards it\. An agent that has an exit rule never holds more than it could sell in one day: with nothing held, its largest buy is \$222\./)).toBeVisible();
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
    await page.locator(".vform").filter({ has: page.getByLabel("Withdraw to your wallet") }).getByRole("button", { name: "Max" }).click();
    await expect(out).toHaveValue("150.25");
    await expect(vault.getByText(/It goes to 0x7a3f…c1c2, the wallet you signed in with\./)).toBeVisible();
  });

  test("a vault that has moved to another wallet is never shown as yours, and cannot be deposited into", async ({ page }) => {
    // The factory's list still points this wallet at the vault, but the vault says someone else owns it.
    const chain = healthy();
    chain.owner = "0xbad0000000000000000000000000000000000bad";
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    await expect(page.getByRole("heading", { name: "This vault has moved" })).toBeVisible();
    // Addresses read from the chain are shown in their mixed-case form, so they are matched without regard to case.
    await expect(page.getByText(/now belongs to 0xbad0…0bad\. You cannot withdraw from it, and you should not send money to it/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your vault", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Deposit USDG")).toHaveCount(0);
    await expect(page.locator(".vtotal")).toHaveCount(0);
    // The wallet can start again with a vault of its own.
    await expect(page.getByRole("button", { name: "Create my vault" })).toBeVisible();
  });

  test("a recovery claim or a hand-over offer on the vault is shown at the top, with the way to stop it", async ({ page }) => {
    const chain = healthy();
    chain.recovery = "0x1e5c000000000000000000000000000000001e5c";
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    // A recovery wallet with no claim running is stated, without alarm.
    await expect(vault.getByText(/Recovery wallet: 0x1e5c…1e5c\./i)).toBeVisible();
    await expect(vault.getByRole("alert")).toHaveCount(0);

    chain.recoveryReadyAt = BigInt(Math.floor(Date.now() / 1000) + 2 * 86400);
    chain.pendingOwner = "0x0ffe000000000000000000000000000000000ffe";
    chain.pendingUntil = BigInt(Math.floor(Date.now() / 1000) + 86400);
    await askAgain(page);
    await expect(vault.getByText("A recovery claim is running on this vault.")).toBeVisible({ timeout: 60_000 });
    await expect(vault.getByText(/The recovery wallet 0x1e5c…1e5c can take the whole vault from /i)).toBeVisible();
    await expect(vault.getByRole("button", { name: "Stop the claim" })).toBeVisible();
    await expect(vault.getByText(/This vault has been offered to 0x0ffe…0ffe\./i)).toBeVisible();
    await expect(vault.getByRole("button", { name: "Cancel the offer" })).toBeVisible();
  });

  test("swaps ETH from the wallet into USDG: a quote first, a minimum and a deadline in what the wallet signs", async ({ page }) => {
    const chain = healthy();
    const sent: { to: string; data: Hex; value?: Hex }[] = [];
    await fakeWallet(page, (tx) => (sent.push(tx), hashOf(sent.length)));
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await connectWallet(page);

    const field = vault.getByLabel("Swap ETH to USDG");
    const swap = vault.getByRole("button", { name: "Swap", exact: true });
    await expect(vault.getByText("In your wallet: 0.02 ETH. A little is kept for network fees.")).toBeVisible({ timeout: 30_000 });
    await expect(swap).toBeDisabled();

    // More than the wallet can spare: the fee money is never swapped away.
    await field.fill("0.02");
    await expect(vault.getByText("That leaves no ETH for network fees. The most you can swap is 0.0197 ETH.")).toBeVisible();
    await expect(swap).toBeDisabled();
    // Max leaves the reserve.
    await page.locator(".vform").filter({ has: page.getByLabel("Swap ETH to USDG") }).getByRole("button", { name: "Max" }).click();
    await expect(field).toHaveValue("0.0197");

    // 0.01 ETH at the pool's $1,990: $19.90, and never less than 1% under that.
    await field.fill("0.01");
    await expect(vault.getByText("You get about $19.90 of USDG, and no less than $19.70. It arrives in your wallet; deposit it below.")).toBeVisible({ timeout: 30_000 });
    await expect(swap).toBeEnabled();

    // A pool far under the oracle's $2,000 is not where the market is: no swap is offered.
    chain.poolUsdgPerEth = 1_900_000_000n;
    await field.fill("0.011");
    await expect(vault.getByText("The pool's price is more than 3% under the oracle's right now, so this swap is not offered. Try again later.")).toBeVisible({ timeout: 30_000 });
    await expect(swap).toBeDisabled();
    // A pool that cannot quote: nothing is offered either.
    chain.poolUsdgPerEth = null;
    await field.fill("0.012");
    await expect(vault.getByText("No quote right now. Try again in a moment.")).toBeVisible({ timeout: 30_000 });
    await expect(swap).toBeDisabled();
    expect(sent).toHaveLength(0);

    // Back to a fair pool. What the wallet is asked to sign is the router's own call, for this wallet, with the
    // ETH as the transaction's value, a minimum 1% under the quote and a deadline ten minutes away.
    chain.poolUsdgPerEth = 1_990_000_000n;
    await field.fill("0.01");
    await expect(swap).toBeEnabled({ timeout: 30_000 });
    const before = Math.floor(Date.now() / 1000);
    await swap.click();
    await expect(page.locator(".toast")).toHaveText("Swapped. The USDG is in your wallet: deposit it below.", { timeout: 30_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(ROUTER);
    expect(BigInt(sent[0]!.value!)).toBe(10_000_000_000_000_000n);
    const outer = decodeFunctionData({ abi: SWAP_ROUTER, data: sent[0]!.data });
    expect(outer.functionName).toBe("multicall");
    const [deadline, calls] = outer.args as unknown as [bigint, Hex[]];
    expect(Number(deadline)).toBeGreaterThanOrEqual(before + 590);
    expect(Number(deadline)).toBeLessThanOrEqual(before + 700);
    expect(calls).toHaveLength(1);
    const inner = decodeFunctionData({ abi: SWAP_ROUTER, data: calls[0]! });
    expect(inner.functionName).toBe("exactInputSingle");
    const [q] = inner.args as unknown as [{ tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }];
    expect(q.tokenIn.toLowerCase()).toBe(WETH);
    expect(q.tokenOut.toLowerCase()).toBe(USDG.toLowerCase());
    expect(q.fee).toBe(100);
    expect(q.recipient.toLowerCase()).toBe(ME);
    expect(q.amountIn).toBe(10_000_000_000_000_000n);
    expect(q.amountOutMinimum).toBe(19_701_000n); // $19.90 less 1%
    expect(q.sqrtPriceLimitX96).toBe(0n);
    await expect(field).toHaveValue("");
  });

  test("with every call to the site's server refused, a returning visitor connects a wallet and withdraws", async ({ page }) => {
    let down = false;
    const sent: { to: string; data: Hex }[] = [];
    await fakeWallet(page, (tx) => (sent.push(tx), hashOf(sent.length)));
    await mockApi(page, { allDown: () => down });
    await mockChain(page, healthy());
    await page.goto("/app/vault");
    await expect(page.locator(".vtotal")).toContainText("$250.25");

    // Later, on the same device, the API process is down: no session, no settings, no sign-in.
    down = true;
    await page.reload();
    await expect(page.getByText("This site's server cannot be reached, so you cannot sign in right now.")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".vtotal")).toHaveCount(0);
    await connectWallet(page);

    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25", { timeout: 30_000 });
    await expect(page.getByText(/You are not signed in, so this page shows the vault of the wallet connected in this browser, straight from Robinhood Chain, at the contract address this device saw last time\./)).toBeVisible();
    // Nothing goes in, and no access is granted, while the server cannot confirm the contract's address.
    await vault.getByLabel("Deposit USDG").fill("5");
    await expect(vault.getByRole("button", { name: "Deposit", exact: true })).toBeDisabled();
    await expect(vault.getByText("Deposits are off until this site's server answers again. Withdrawals work.")).toBeVisible();
    // Money comes out: the withdrawal reaches the wallet, for the vault, to the connected wallet itself.
    await vault.getByLabel("Withdraw to your wallet").fill("10");
    await expect(vault.getByText("It goes to 0x7a3f…c1c2, the wallet connected in this browser.")).toBeVisible();
    const withdraw = vault.getByRole("button", { name: "Withdraw", exact: true });
    await expect(withdraw).toBeEnabled();
    await withdraw.click();
    await expect(page.locator(".toast")).toHaveText("Withdrawn to your wallet.", { timeout: 30_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(VAULT);
    const call = decodeFunctionData({ abi: parseAbi(["function withdraw(address token, uint256 amount, address to)"]), data: sent[0]!.data });
    expect(call.args[0].toLowerCase()).toBe(USDG.toLowerCase());
    expect(call.args[1]).toBe(10_000_000n);
    expect(call.args[2].toLowerCase()).toBe(ME);
    // Pause and revoke work too.
    await expect(vault.getByRole("button", { name: "Pause vault" })).toBeEnabled();
    await expect(vault.getByRole("button", { name: "Revoke agent access" })).toBeEnabled();
  });

  test("when the server answers, a signed-out visitor is asked to sign in, as before", async ({ page }) => {
    await fakeWallet(page, () => hashOf(1));
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me") return json(route, { error: "unauthorized", message: "Sign in" }, 401);
      if (path === "/api/public/chain") return json(route, chainConfig);
      return json(route, { error: "not_found", message: "Not mocked" }, 404);
    });
    await mockChain(page, healthy());
    await page.goto("/app/vault");
    await expect(page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
    await expect(page.getByText("Sign in with your wallet to create or manage your vault.")).toBeVisible();
    await expect(page.getByText(/cannot be reached/)).toHaveCount(0);
    await expect(page.locator(".vtotal")).toHaveCount(0);
  });

  test("a transaction cancelled in the wallet is not reported as done", async ({ page }) => {
    const chain = healthy();
    const sent: { to: string; data: Hex }[] = [];
    const asked = hashOf(1);
    const cancel = hashOf(2);
    await fakeWallet(page, (tx) => {
      sent.push(tx);
      // The user then presses "cancel" in the wallet: it sends itself nothing, in the same slot, and that is what the chain runs.
      chain.receipts[asked] = "none";
      chain.waiting[asked] = { from: ME, to: VAULT, nonce: 7, input: tx.data };
      chain.inBlock = [{ hash: cancel, from: ME, to: ME, nonce: 7, input: "0x" }];
      return asked;
    });
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await connectWallet(page);
    await vault.getByRole("button", { name: "Pause vault" }).click();
    const toast = page.locator(".toast");
    await expect(toast).toHaveText("That transaction was cancelled in your wallet. Nothing changed.", { timeout: 30_000 });
    expect(sent).toHaveLength(1);
    await expect(vault.getByText("Not paused")).toBeVisible();
    await expect(vault.getByRole("button", { name: "Pause vault" })).toBeEnabled();
  });

  test("a transaction the chain confirms is reported as done", async ({ page }) => {
    const chain = healthy();
    await fakeWallet(page, () => {
      chain.paused = true;
      return hashOf(1);
    });
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await connectWallet(page);
    await vault.getByRole("button", { name: "Pause vault" }).click();
    await expect(page.locator(".toast")).toHaveText("Vault paused. The agent cannot trade it.", { timeout: 30_000 });
    await expect(vault.getByText("Paused", { exact: true })).toBeVisible();
    await expect(vault.getByRole("button", { name: "Resume vault" })).toBeVisible();
  });

  test("while the numbers on screen are old, nothing is built from them: limits and agent access are off, withdraw and pause are not", async ({ page }) => {
    await page.clock.install();
    const chain = healthy();
    chain.operator = ZERO;
    await fakeWallet(page, () => hashOf(1));
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await connectWallet(page);
    const restore = vault.getByRole("button", { name: "Restore agent access" });
    const save = vault.getByRole("button", { name: "Save limits" });
    await expect(restore).toBeEnabled();
    await vault.locator('input[type="range"]').first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(vault.getByText("Daily trading limit $210")).toBeVisible();
    await expect(save).toBeEnabled();

    // The page's own connection to the chain fails; the wallet's still works.
    chain.down = true;
    await page.clock.fastForward(21_000);
    await expect(vault.getByText(/Robinhood Chain could not be reached just now\. These numbers are from/)).toBeVisible({ timeout: 60_000 });
    await expect(restore).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(vault.getByText(/Saving limits and switching agent access are off until Robinhood Chain answers again\./)).toBeVisible();
    await expect(vault.getByRole("button", { name: "Pause vault" })).toBeEnabled();
    await vault.getByLabel("Withdraw to your wallet").fill("10");
    await expect(vault.getByRole("button", { name: "Withdraw", exact: true })).toBeEnabled();

    // When the chain answers again, they come back.
    chain.down = false;
    chain.vaultUsdg = 100_000_000n;
    await page.clock.fastForward(21_000);
    await expect(vault.locator(".vtotal")).toContainText("$200.00", { timeout: 60_000 });
    await expect(restore).toBeEnabled();
    await expect(save).toBeEnabled();
  });

  test("a sent transaction the chain has not confirmed leaves a note and an empty field, not a second send", async ({ page }) => {
    await page.clock.install();
    const chain = healthy();
    const sent: { to: string; data: Hex }[] = [];
    await fakeWallet(page, (tx) => {
      sent.push(tx);
      const hash = hashOf(sent.length);
      chain.receipts[hash] = "none"; // the chain says nothing about it
      return hash;
    });
    await mockApi(page);
    await mockChain(page, chain);
    await page.goto("/app/vault");
    const vault = page.locator(".vaultcol");
    await expect(vault.locator(".vtotal")).toContainText("$250.25");
    await connectWallet(page);
    const field = vault.getByLabel("Withdraw to your wallet");
    const withdraw = vault.getByRole("button", { name: "Withdraw", exact: true });
    const note = vault.getByText("Your last transaction is not confirmed yet.");
    await field.fill("10");
    await withdraw.click();
    await expect(page.locator(".toast")).toHaveText("Sent. Waiting for the chain to confirm…", { timeout: 15_000 });
    await expect(note).toHaveCount(0);

    // A minute and a half later there is still no answer.
    await page.clock.fastForward(91_000);
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(vault.getByText(/It may still go through\. Check your wallet's activity before you send it again\./)).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(withdraw).toBeDisabled();
    expect(sent).toHaveLength(1);
    // The note can be hidden by hand.
    await vault.getByRole("button", { name: "Hide this note" }).click();
    await expect(note).toHaveCount(0);

    // A second transaction goes the same way; this time it lands later, and the page's own reading shows it.
    await field.fill("5");
    await withdraw.click();
    await expect(page.locator(".toast")).toHaveText("Sent. Waiting for the chain to confirm…", { timeout: 15_000 });
    await page.clock.fastForward(91_000);
    await expect(note).toBeVisible({ timeout: 30_000 });
    chain.vaultUsdg -= 5_000_000n;
    await page.clock.fastForward(21_000);
    await expect(vault.locator(".vtotal")).toContainText("$245.25", { timeout: 60_000 });
    await expect(note).toHaveCount(0);
    expect(sent).toHaveLength(2);
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
