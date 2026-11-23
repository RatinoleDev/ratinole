/**
 * The wallet swap on the Vault page uses a router address and a fee tier kept in @rationale/config. They must be
 * the ones the vault contracts were deployed with (contracts/config/robinhood.json): a swap through another pool
 * would price ETH differently from the pool the agents trade in.
 */
import { readFileSync } from "node:fs";
import { LIVE_STABLE, LIVE_TOKENS, SWAP, swapMinOut } from "@rationale/config";
import { describe, expect, it } from "vitest";

const chain = JSON.parse(readFileSync(new URL("../../../contracts/config/robinhood.json", import.meta.url), "utf8")) as {
  router: string;
  tokens: { symbol: string; address: string; feeTier?: number }[];
};

describe("the wallet swap's settings", () => {
  it("are the router and the ETH pool the vaults use", () => {
    expect(SWAP.router.toLowerCase()).toBe(chain.router.toLowerCase());
    const weth = chain.tokens.find((t) => t.symbol === "WETH")!;
    expect(LIVE_TOKENS.ETH.address.toLowerCase()).toBe(weth.address.toLowerCase());
    expect(SWAP.ethFeeTier).toBe(weth.feeTier);
    expect(LIVE_STABLE.address.toLowerCase()).toBe(chain.tokens.find((t) => t.symbol === "USDG")!.address.toLowerCase());
  });

  it("never ask for less than the quote minus the stated slippage, and never for more than the quote", () => {
    expect(SWAP.slippagePct).toBe(1);
    expect(swapMinOut(19_900_000n)).toBe(19_701_000n);
    expect(swapMinOut(1n)).toBe(0n);
    for (const q of [1_000_000n, 8_605_628n, 123_456_789_012n]) {
      expect(swapMinOut(q)).toBeLessThanOrEqual(q);
      expect(swapMinOut(q) * 100n).toBeGreaterThanOrEqual(q * 99n - 100n);
    }
  });
});
