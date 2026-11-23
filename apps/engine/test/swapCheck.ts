/**
 * LOCAL FORK ONLY. Proves the call the Vault page makes when a wallet swaps ETH into USDG, against the real router
 * and the real pool on a local copy of Robinhood Chain (fake money, a public test key). It refuses any node that is
 * not a local Hardhat fork.
 *
 *   Terminal 1:  FORK=1 pnpm --filter @rationale/contracts exec hardhat node
 *   Terminal 2:  pnpm --filter @rationale/engine exec tsx test/swapCheck.ts
 *
 * The page and this check share the router's address, its ABI, the fee tier and the minimum-out rule through
 * @rationale/config, so what is proven here is what the page sends.
 */
import { LIVE_STABLE, LIVE_TOKENS, SWAP, SWAP_ROUTER_ABI, swapMinOut } from "@rationale/config";
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "http://127.0.0.1:8545";
const ROUTER = SWAP.router as Address;
const WETH = LIVE_TOKENS.ETH.address as Address;
const USDG = LIVE_STABLE.address as Address;
// Hardhat's public test account 3. Its key is public and it holds nothing real.
const account = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

const chain = { id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const usdgOf = () => pub.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const params = (amountIn: bigint, min: bigint) => ({ tokenIn: WETH, tokenOut: USDG, fee: SWAP.ethFeeTier, recipient: account.address, amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n });
const refused = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true,
  );

async function main() {
  if (!/hardhat/i.test(String(await pub.request({ method: "web3_clientVersion" as never })))) throw new Error("Not a local Hardhat fork. Stopping.");
  // A fresh Hardhat fork cannot run calls at the block it forked from: mine one block first.
  await pub.request({ method: "evm_mine" as never });
  const routerWeth = await pub.readContract({ address: ROUTER, abi: [{ type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "WETH9" });
  check("the router wraps ETH into the WETH the vaults trade", routerWeth.toLowerCase() === WETH.toLowerCase(), routerWeth);

  const amountIn = parseEther("0.005");
  const before = await usdgOf();
  const ethBefore = await pub.getBalance({ address: account.address });

  // The quote: the swap itself, not sent.
  const quote = (await pub.simulateContract({ account: account.address, address: ROUTER, abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle", args: [params(amountIn, 0n)], value: amountIn })).result;
  check("a quote comes back for 0.005 ETH", quote > 0n, `${formatUnits(quote, 6)} USDG, $${(Number(formatUnits(quote, 6)) / 0.005).toFixed(2)} per ETH`);

  const min = swapMinOut(quote);
  const now = Number((await pub.getBlock()).timestamp);
  const call = (m: bigint) => encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle", args: [params(amountIn, m)] });
  const sim = (deadline: number, m: bigint) => pub.simulateContract({ account: account.address, address: ROUTER, abi: SWAP_ROUTER_ABI, functionName: "multicall", args: [BigInt(deadline), [call(m)]], value: amountIn });

  check("a swap past its deadline is refused", await refused(sim(now - 60, min)));
  check("a swap that would return less than its minimum is refused", await refused(sim(now + SWAP.deadlineSeconds, quote + 1n)));

  // The real thing, exactly as the page sends it.
  const hash = await wallet.writeContract({ address: ROUTER, abi: SWAP_ROUTER_ABI, functionName: "multicall", args: [BigInt(now + SWAP.deadlineSeconds), [call(min)]], value: amountIn });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  check("the swap is mined", receipt.status === "success", `gas ${receipt.gasUsed}`);
  const got = (await usdgOf()) - before;
  check("the USDG arrives in the wallet, and is what was quoted", got === quote, `${formatUnits(got, 6)} USDG`);
  check("it is at least the minimum asked for", got >= min, `minimum ${formatUnits(min, 6)}`);
  const spent = ethBefore - (await pub.getBalance({ address: account.address }));
  check("exactly the ETH given was spent, plus the network fee", spent === amountIn + receipt.gasUsed * receipt.effectiveGasPrice);
  check("no ETH is left behind in the router", (await pub.getBalance({ address: ROUTER })) === 0n);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed.");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
