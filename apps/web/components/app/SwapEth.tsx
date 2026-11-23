"use client";

/**
 * Swap ETH from the connected wallet into USDG, so that a wallet holding only ETH can fund its vault.
 *
 * It is the wallet's own swap, signed in the wallet: this site holds no key and never touches the money. The swap
 * goes through Uniswap's router on Robinhood Chain, in the same ETH/USDG pool the agents trade in.
 *
 *  - The quote is the swap itself, run without being sent. Nothing is offered without one.
 *  - The swap that is sent refuses to return less than the quote minus SWAP.slippagePct, and refuses to run later
 *    than SWAP.deadlineSeconds from now: a transaction left pending cannot fill at some other price tomorrow.
 *  - When the vault's oracle has a price for ETH, a quote far under it is not offered at all: the pool is then not
 *    where the market is.
 *  - A little ETH always stays in the wallet for network fees.
 */
import { CHAIN, LIVE_STABLE, LIVE_TOKENS, SWAP, SWAP_ROUTER_ABI, fromUnits, parseAmount, swapMinOut } from "@rationale/config";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { encodeFunctionData, formatEther, type Abi, type Address } from "viem";
import { useBalance, usePublicClient } from "wagmi";
import { usd } from "../../lib/format";
import type { TxCall, TxResult } from "../../lib/tx";

const WETH = LIVE_TOKENS.ETH.address as Address;
const USDG = LIVE_STABLE.address as Address;
const ROUTER = SWAP.router as Address;
const RESERVE = BigInt(Math.round(SWAP.gasReserveEth * 1e18));

const swapParams = (owner: Address, amountIn: bigint, min: bigint) => ({ tokenIn: WETH, tokenOut: USDG, fee: SWAP.ethFeeTier, recipient: owner, amountIn, amountOutMinimum: min, sqrtPriceLimitX96: 0n });
const eth = (wei: bigint) => {
  const n = Number(formatEther(wei));
  return n >= 1 ? n.toFixed(4) : n.toPrecision(4).replace(/\.?0+$/, "");
};

export function SwapEth({
  owner,
  off,
  busy,
  ethPrice,
  send,
}: {
  owner: Address;
  /** Nothing can be signed right now (no wallet, or another transaction is in the wallet). */
  off: boolean;
  /** The label of the transaction in the wallet, if any. */
  busy: string | null;
  /** The vault oracle's price of ETH in dollars, when it has one. */
  ethPrice: number | null;
  send: (label: string, call: TxCall, done: string) => Promise<TxResult>;
}) {
  const [text, setText] = useState("");
  const client = usePublicClient({ chainId: CHAIN.id });
  const balance = useBalance({ address: owner, chainId: CHAIN.id, query: { refetchInterval: 20_000 } });
  const held = balance.data?.value ?? null;
  const spendable = held != null && held > RESERVE ? held - RESERVE : 0n;

  const amount = parseAmount(text, 18);
  const amountIn = amount.ok ? amount.raw : 0n;
  const fits = amount.ok && held != null && amountIn <= spendable;

  const simulate = async (): Promise<bigint> => {
    if (!client) throw new Error("no connection to the chain");
    const sim = await client.simulateContract({ account: owner, address: ROUTER, abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams(owner, amountIn, 0n)], value: amountIn });
    return sim.result;
  };
  const quoteQ = useQuery({ queryKey: ["swap-quote", owner, amountIn.toString()], queryFn: simulate, enabled: fits && !!client, refetchInterval: 15_000, retry: false, staleTime: 10_000 });
  const quote = fits ? (quoteQ.data ?? null) : null;

  // A pool far under the oracle is not where the market is. The swap would be a bad one however it is protected.
  const tooFar = (q: bigint) => ethPrice != null && fromUnits(q, LIVE_STABLE.decimals) < Number(formatEther(amountIn)) * ethPrice * (1 - SWAP.maxUnderOraclePct / 100);
  const blocked = quote != null && tooFar(quote);
  const ready = fits && quote != null && quote > 0n && !blocked;

  async function swap() {
    if (!ready) return;
    // Quoted again at the last moment: the minimum is set from the price now, not from the one on screen.
    let fresh: bigint;
    try {
      fresh = await simulate();
    } catch {
      void quoteQ.refetch();
      return;
    }
    if (fresh <= 0n || tooFar(fresh)) {
      void quoteQ.refetch();
      return;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP.deadlineSeconds);
    const data = encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle", args: [swapParams(owner, amountIn, swapMinOut(fresh))] });
    const result = await send("swap", { address: ROUTER, abi: SWAP_ROUTER_ABI as unknown as Abi, functionName: "multicall", args: [deadline, [data]], value: amountIn }, `Swapped. The ${LIVE_STABLE.symbol} is in your wallet: deposit it below.`);
    if (result !== "failed") {
      setText("");
      void balance.refetch();
    }
  }

  const note = (() => {
    if (held == null) return "Reading your wallet…";
    if (!amount.ok && amount.error) return amount.error;
    if (amount.ok && !fits) {
      return spendable > 0n
        ? `That leaves no ETH for network fees. The most you can swap is ${eth(spendable)} ETH.`
        : `Your wallet holds ${eth(held)} ETH, which is kept for network fees.`;
    }
    if (fits && quoteQ.isError) return "No quote right now. Try again in a moment.";
    if (fits && quote == null) return "Getting a quote…";
    if (blocked) return `The pool's price is more than ${SWAP.maxUnderOraclePct}% under the oracle's right now, so this swap is not offered. Try again later.`;
    if (ready && quote != null) {
      return `You get about ${usd(fromUnits(quote, LIVE_STABLE.decimals), 2)} of ${LIVE_STABLE.symbol}, and no less than ${usd(fromUnits(swapMinOut(quote), LIVE_STABLE.decimals), 2)}. It arrives in your wallet; deposit it below.`;
    }
    return `In your wallet: ${eth(held)} ETH. A little is kept for network fees.`;
  })();

  return (
    <div className="vform">
      <label htmlFor="v-swap">Swap ETH to {LIVE_STABLE.symbol}</label>
      <div className="vfield">
        <input id="v-swap" type="text" inputMode="decimal" placeholder="0.00 ETH" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="v-swap-note" />
        <button className="btn sm ghost" type="button" disabled={spendable === 0n} onClick={() => setText(formatEther(spendable))}>
          Max
        </button>
        <button className="btn sm" type="button" disabled={off || !ready} onClick={() => void swap()}>
          {busy === "swap" ? "Check your wallet…" : "Swap"}
        </button>
      </div>
      <small id="v-swap-note">{note}</small>
    </div>
  );
}
