/**
 * A vault on a pretend chain, for testing the live runner: it holds balances, fills orders at `price` less the pool
 * fee, keeps its own clock, enforces order deadlines and the daily limit like the real vault, and can be made to
 * misbehave the ways a real chain connection does (answers lost, a node that is behind, a chain that is down).
 */
import { LIVE_STABLE, LIVE_TOKENS, fromUnits, toUnits, type Address, type LiveToken } from "@rationale/config";
import type { Hex } from "viem";
import { OrderPendingError, type SwapOutcome, type SwapRequest, type VaultChain, type VaultSnapshot } from "../src/vault/chain";

/** The first hour the live tests run. */
export const H0 = Date.UTC(2026, 10, 10, 12);

export const OWNER = "0x1111111111111111111111111111111111111111" as Address;
export const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
export const VAULT = "0x3333333333333333333333333333333333333333" as Address;
export const WETH = LIVE_TOKENS.ETH;
export const usdg = (n: number) => toUnits(n, LIVE_STABLE.decimals);

export class PretendChain implements VaultChain {
  operator = OPERATOR;
  owner = OWNER;
  vaultOperator = OPERATOR;
  paused = false;
  tradable = true;
  feeTier = 500;
  stable = usdg(1000);
  token = 0n;
  price = 2000;
  /** What the vault still lets the operator trade today, in dollars. */
  remainingUsd = 100_000;
  block = 100n;
  /** Every order that reached the chain. */
  done: { req: SwapRequest; out: Extract<SwapOutcome, { ok: true }> }[] = [];
  /** How many times an order was asked for. */
  asked = 0;
  refuse: string | null = null;
  /** The chain cannot be reached while the order is being prepared: nothing is signed. */
  unreachable = 0;
  /** "afterSend": the order lands, but the connection drops before the answer. "lost": it never reaches the chain. */
  drop: "afterSend" | "lost" | null = null;
  /** Runs after the order is prepared and before its hash is handed over, like a slow worker. */
  beforeSign: (() => Promise<void>) | null = null;
  /** Runs while the vault is being read, like an owner acting at that moment. */
  duringRead: (() => Promise<void>) | null = null;
  /** The chain cannot be asked about transactions right now. */
  lookupDown = false;
  /**
   * This connection has not seen the latest blocks yet. Like a real node that is behind, it refuses when asked for
   * a block it does not have, and otherwise shows the vault as it was before the last order.
   */
  behind = false;
  private old = { stable: 0n, token: 0n };
  /** The chain's own clock, in seconds. The `run` helper keeps it at the run's time. */
  clock = Math.floor(H0 / 1000) + 120;
  /** An order that was signed and "lost": it can still land later, if its deadline has not passed. */
  lost: { req: SwapRequest; txHash: Hex } | null = null;
  private nonce = 0;

  async blockNumber() {
    return this.block;
  }
  async chainTime() {
    return this.clock;
  }
  /** The lost order reaches the chain after all. The vault refuses it once its deadline has passed. */
  landLost() {
    const { req, txHash } = this.lost!;
    this.lost = null;
    if (this.clock > req.deadline) return false;
    this.execute(req, txHash);
    return true;
  }
  async snapshot(_vault: Address, _token: LiveToken, atLeastBlock?: bigint): Promise<VaultSnapshot> {
    if (this.behind && atLeastBlock != null) throw new OrderPendingError("behind");
    await this.duringRead?.();
    return {
      block: this.block,
      owner: this.owner,
      operator: this.vaultOperator,
      paused: this.paused,
      stable: this.behind ? this.old.stable : this.stable,
      token: this.behind ? this.old.token : this.token,
      tradable: this.tradable,
      feeTier: this.feeTier,
      remainingUsd: this.remainingUsd,
      priceUsd: this.price,
    };
  }
  private execute(req: SwapRequest, txHash: Hex): Extract<SwapOutcome, { ok: true }> {
    const fee = this.feeTier / 1_000_000;
    const buying = req.tokenIn === LIVE_STABLE.address;
    this.old = { stable: this.stable, token: this.token };
    let amountOut: bigint;
    if (buying) {
      amountOut = toUnits((fromUnits(req.amountIn, 6) * (1 - fee)) / this.price, WETH.decimals);
      this.stable -= req.amountIn;
      this.token += amountOut;
      this.remainingUsd -= fromUnits(req.amountIn, 6);
    } else {
      amountOut = toUnits(fromUnits(req.amountIn, WETH.decimals) * this.price * (1 - fee), 6);
      this.token -= req.amountIn;
      this.stable += amountOut;
      this.remainingUsd -= fromUnits(req.amountIn, WETH.decimals) * this.price;
    }
    const out = { ok: true as const, txHash, amountIn: req.amountIn, amountOut, block: ++this.block };
    this.done.push({ req, out });
    return out;
  }
  /** Like the real client: the hash exists, and is handed over, before anything is sent. */
  async swap(req: SwapRequest, onSigned: (h: Hex) => Promise<void>): Promise<SwapOutcome> {
    this.asked++;
    if (this.unreachable > 0) {
      this.unreachable--;
      throw new Error("fetch failed");
    }
    if (this.refuse) return { ok: false, reason: this.refuse };
    if (this.clock > req.deadline) return { ok: false, reason: "the order was placed too late in the hour" };
    // The vault itself refuses an order worth more than what is left of its daily limit.
    const value = req.tokenIn === LIVE_STABLE.address ? fromUnits(req.amountIn, 6) : fromUnits(req.amountIn, WETH.decimals) * this.price;
    if (value > this.remainingUsd) return { ok: false, reason: "the vault's daily trading limit is used up" };
    const txHash = `0x${(++this.nonce).toString(16).padStart(64, "0")}` as Hex;
    await this.beforeSign?.();
    await onSigned(txHash);
    if (this.drop === "lost") {
      this.lost = { req, txHash };
      throw new OrderPendingError("dropped");
    }
    const out = this.execute(req, txHash);
    if (this.drop === "afterSend") throw new OrderPendingError("dropped");
    return out;
  }
  async outcomeOf(txHash: Hex): Promise<SwapOutcome | null> {
    if (this.lookupDown) throw new Error("rpc down");
    return this.done.find((d) => d.out.txHash === txHash)?.out ?? null;
  }
}
