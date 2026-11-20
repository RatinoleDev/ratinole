/**
 * The engine's view of a vault on Robinhood Chain, and the one thing it may do there: swap inside the vault with
 * the operator key. The key comes from the environment and never leaves this process. It cannot withdraw: the
 * vault contract only lets it swap, within the limits the vault's owner set.
 */
import { CHAIN, ERC20_ABI, FACTORY_ABI, LIVE, LIVE_STABLE, VAULT_ABI, fromUnits, type Address, type LiveToken } from "@rationale/config";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A vault read at one block. Balances are raw token units. */
export interface VaultSnapshot {
  /** The block everything below was read at. */
  block: bigint;
  owner: Address;
  operator: Address;
  paused: boolean;
  stable: bigint;
  token: bigint;
  /**
   * The vault can trade this market exactly as the factory set it up: both tokens allowed, the factory's own pool
   * and price feeds, the expected decimals. An owner who changed any of that has a vault this engine will not trade.
   */
  tradable: boolean;
  /** Pool fee pinned for the market's token, in hundredths of a basis point (500 = 0.05%). */
  feeTier: number;
  /** Dollars the vault will still let the operator trade in its current daily window. */
  remainingUsd: number;
  /** The oracle's price for the market token, in dollars; null when the oracle has none right now. */
  priceUsd: number | null;
}

export interface SwapRequest {
  vault: Address;
  tokenIn: Address;
  tokenOut: Address;
  feeTier: number;
  amountIn: bigint;
}

export type SwapOutcome =
  | { ok: true; txHash: Hex; amountIn: bigint; amountOut: bigint; /** The block the swap landed in. */ block: bigint }
  | { ok: false; reason: string; txHash?: Hex };

/** The order was signed, or may have been, and the chain has not said what became of it yet. Try again shortly. */
export class OrderPendingError extends Error {}

export interface VaultChain {
  /** The address of the key this engine signs with. A vault must name it as operator. */
  readonly operator: Address;
  blockNumber(): Promise<bigint>;
  /** Reads the vault. With `atLeastBlock`, refuses (OrderPendingError) a connection that has not reached that block yet. */
  snapshot(vault: Address, token: LiveToken, atLeastBlock?: bigint): Promise<VaultSnapshot>;
  /**
   * Checks the order would succeed, signs it, hands its hash to `onSigned`, and only then sends it and waits for
   * the result. Because the hash is known and written down before anything reaches the network, an order can
   * always be found again by its hash, whatever happens next. If `onSigned` throws, nothing is sent.
   *
   * Returns a refusal only when the vault or the network certainly refused the order. Trouble reaching the chain
   * before anything was signed is thrown as an ordinary error: nothing happened, and the caller may start again.
   */
  swap(req: SwapRequest, onSigned: (txHash: Hex) => Promise<void>): Promise<SwapOutcome>;
  /** What became of a signed transaction; null while the chain does not know it. Throws when it cannot be asked. */
  outcomeOf(txHash: Hex, vault: Address): Promise<SwapOutcome | null>;
}

const lower = (a: string) => a.toLowerCase() as Address;
/** What `tokens(address)` returns: allowed, decimals, maxStaleness, feeTier, feed. */
type TokenConfig = readonly [boolean, number, number, number, Address];

/**
 * The contract's own refusal inside an error, if that is what it is. viem also dresses a node's plain "Internal
 * error" as a revert, so only a decoded error, a reason string or the node's own "execution reverted" counts.
 */
function contractRevert(err: unknown): ContractFunctionRevertedError | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  if (revert.data?.errorName || revert.reason) return revert;
  return /execution reverted/i.test(`${err.shortMessage} ${err.details ?? ""}`) ? revert : null;
}

/**
 * True when the network certainly refused a transaction outright, so it can never be mined. "Nonce too low" and
 * "already known" are NOT here: they are what a node answers when the same transaction already got through.
 */
function refusedOutright(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return /insufficient funds|intrinsic gas|exceeds block gas limit|underpriced|fee cap|max fee per gas/i.test(`${err.shortMessage} ${err.details ?? ""}`);
}

/** Plain words for why an order was refused. Shown to the vault's owner in the decision log. */
export function refusalReason(err: unknown): string {
  const revert = contractRevert(err);
  if (revert) {
    switch (revert.data?.errorName) {
      case "NotOperator":
        return "the agent's access to the vault was revoked";
      case "Paused":
        return "the vault is paused";
      case "TokenNotAllowed":
      case "PairNotAllowed":
      case "BadFeeTier":
        return "the vault no longer allows this market";
      case "DailyLimitExceeded":
        return "the vault's daily trading limit is used up";
      case "StaleOraclePrice":
      case "BadOraclePrice":
        return "the price oracle had no fresh price";
      case "InsufficientOutput":
      case "SlippageTooHigh":
        return "the pool price was worse than the vault's slippage limit";
      case "ZeroAmount":
        return "there was nothing to trade";
    }
    const text = revert.reason ?? revert.shortMessage;
    // Uniswap's router refuses with this text when the pool cannot meet the minimum output.
    if (/too little received|SPL/i.test(text)) return "the pool price moved too far while the order was being placed";
    // "STF": the router could not take the tokens in, because the vault holds less than the order asked for.
    if (/\bSTF\b/.test(text)) return "the vault holds less than the order needed";
    return "the vault refused the order";
  }
  if (err instanceof BaseError && /insufficient funds/i.test(err.shortMessage)) return "the agent's own wallet is out of gas money";
  return "the network refused the order";
}

/** An error's message with any address of an RPC endpoint taken out: such addresses can carry an access key. */
export function withoutUrls(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/https?:\/\/[^\s"')]+/g, "(rpc)");
}

export interface ViemChainOptions {
  rpcUrl: string;
  /** The vault factory. A vault is only traded while its tokens are set up the way this factory sets them up. */
  factory: Address;
  /** 0x-prefixed 32-byte key. Read from the environment by the caller; never logged or stored. */
  privateKey: Hex;
  /** How long to wait for a sent order to confirm before reporting it as pending. */
  confirmTimeoutMs?: number;
}

export function viemVaultChain(opts: ViemChainOptions): VaultChain {
  const chain = defineChain({
    id: CHAIN.id,
    name: CHAIN.name,
    nativeCurrency: CHAIN.nativeCurrency,
    rpcUrls: { default: { http: [opts.rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl, { timeout: 20_000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  // One order at a time: the operator has one sequence of transaction numbers.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  /** The factory's own settings for each token: what an untouched vault has. Read once; they never change. */
  let defaults: Promise<Map<string, { feed: string; feeTier: number }>> | null = null;
  const factoryDefaults = () => {
    defaults ??= pub
      .readContract({ address: opts.factory, abi: FACTORY_ABI, functionName: "getDefaults" })
      .then(([, tokens, feeds, , feeTiers]) => new Map(tokens.map((t, i) => [lower(t), { feed: lower(feeds[i]!), feeTier: feeTiers[i]! }])))
      .catch((err) => {
        defaults = null;
        throw err;
      });
    return defaults;
  };

  const fromReceipt = (receipt: TransactionReceipt, vault: Address): SwapOutcome => {
    if (receipt.status !== "success") return { ok: false, reason: "the order was refused on-chain", txHash: receipt.transactionHash };
    const logs = parseEventLogs({ abi: VAULT_ABI, eventName: "Swapped", logs: receipt.logs }).filter((l) => lower(l.address) === lower(vault));
    const swapped = logs[0];
    if (!swapped) return { ok: false, reason: "the transaction held no swap for this vault", txHash: receipt.transactionHash };
    return { ok: true, txHash: receipt.transactionHash, amountIn: swapped.args.amountIn, amountOut: swapped.args.amountOut, block: receipt.blockNumber };
  };

  const outcomeOfHash = async (txHash: Hex, vault: Address): Promise<SwapOutcome | null> => {
    try {
      return fromReceipt(await pub.getTransactionReceipt({ hash: txHash }), vault);
    } catch (err) {
      // "Not found" means the chain does not know the transaction (yet). Anything else is a failed question,
      // not an answer, and must not be read as "it never happened".
      if (err instanceof BaseError && err.name === "TransactionReceiptNotFoundError") return null;
      throw err;
    }
  };

  /**
   * The newest block, asked for every time. The library would otherwise hand back a number up to four seconds old,
   * which on this chain is dozens of blocks: a vault read at that block would not show an order that just landed.
   */
  const latestBlock = () => pub.getBlockNumber({ cacheTime: 0 });

  return {
    operator: lower(account.address),
    blockNumber: latestBlock,

    async snapshot(vault, token, atLeastBlock) {
      let block = await latestBlock();
      // A connection can sit a few blocks behind the one that confirmed the order. Give it a moment to catch up.
      for (let tries = 0; atLeastBlock != null && block < atLeastBlock; tries++) {
        if (tries >= 20) throw new OrderPendingError("The chain connection has not caught up with the order yet");
        await new Promise((r) => setTimeout(r, 250));
        block = await latestBlock();
      }
      const va = VAULT_ABI as Abi;
      const erc = ERC20_ABI as Abi;
      const call = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => ({ address, abi, functionName, args });
      // One batch at one block, read by position. Calls 0 to 7 must succeed; the price may be missing.
      const [expected, r] = await Promise.all([
        factoryDefaults(),
        pub.multicall({
          blockNumber: block,
          contracts: [
            call(vault, va, "owner"),
            call(vault, va, "operator"),
            call(vault, va, "paused"),
            call(vault, va, "tokens", [token.address]),
            call(vault, va, "tokens", [LIVE_STABLE.address]),
            call(LIVE_STABLE.address, erc, "balanceOf", [vault]),
            call(token.address, erc, "balanceOf", [vault]),
            call(vault, va, "remainingDailyUsd"),
            call(vault, va, "priceUsd", [token.address]),
          ],
        }),
      ]);
      const must = <T>(i: number): T => {
        const x = r[i];
        if (!x || x.status !== "success") throw new Error("The vault could not be read");
        return x.result as T;
      };
      const tokenCfg = must<TokenConfig>(3);
      const stableCfg = must<TokenConfig>(4);
      const sameAsFactory = (addr: Address, cfg: TokenConfig) => {
        const d = expected.get(lower(addr));
        return !!d && cfg[0] && lower(cfg[4]) === d.feed && cfg[3] === d.feeTier;
      };
      const price = r[8]?.status === "success" ? (r[8].result as bigint) : null;
      return {
        block,
        owner: lower(must<Address>(0)),
        operator: lower(must<Address>(1)),
        paused: must<boolean>(2),
        stable: must<bigint>(5),
        token: must<bigint>(6),
        tradable: sameAsFactory(token.address, tokenCfg) && sameAsFactory(LIVE_STABLE.address, stableCfg) && tokenCfg[1] === token.decimals && tokenCfg[3] > 0,
        feeTier: tokenCfg[3],
        remainingUsd: fromUnits(must<bigint>(7), 18),
        priceUsd: price == null ? null : fromUnits(price, 18),
      };
    },

    swap: (req, onSigned) =>
      inTurn(async () => {
        const call = (minOut: bigint) =>
          ({ account, address: req.vault, abi: VAULT_ABI, functionName: "swap", args: [req.tokenIn, req.tokenOut, req.feeTier, req.amountIn, minOut] }) as const;
        let serialized: Hex;
        try {
          // A dry run first: an order the vault would refuse costs nothing and is never signed.
          const dry = await pub.simulateContract(call(0n));
          // Our own minimum, on top of the vault's: the order goes through near the price just seen, or not at all.
          const final = call(dry.result - (dry.result * BigInt(LIVE.maxDriftBps)) / 10_000n);
          const estimate = await pub.estimateContractGas(final);
          const prepared = await wallet.prepareTransactionRequest({
            account,
            to: req.vault,
            data: encodeFunctionData(final),
            // Room to spare: the pool can move between the estimate and the block the order lands in.
            gas: (estimate * 13n) / 10n,
          });
          serialized = await wallet.signTransaction(prepared);
        } catch (err) {
          if (contractRevert(err) || refusedOutright(err)) return { ok: false, reason: refusalReason(err) };
          // Trouble reaching the chain. Nothing was signed, so nothing happened: let the caller start again.
          throw err;
        }
        const hash = keccak256(serialized);
        // Written down before it is sent. If this throws, the order was withdrawn and nothing goes out.
        await onSigned(hash);
        try {
          await pub.sendRawTransaction({ serializedTransaction: serialized });
        } catch (err) {
          // Sending the same signed transaction twice is harmless, and a node that says "already known" has it.
          // Ask the chain what it knows before concluding anything.
          const known = await outcomeOfHash(hash, req.vault).catch(() => null);
          if (known) return known;
          if (refusedOutright(err)) return { ok: false, reason: refusalReason(err), txHash: hash };
          throw new OrderPendingError(`Order ${hash} may or may not have reached the chain`);
        }
        let receipt: TransactionReceipt;
        try {
          receipt = await pub.waitForTransactionReceipt({ hash, timeout: opts.confirmTimeoutMs ?? 120_000 });
        } catch {
          throw new OrderPendingError(`Order ${hash} is not confirmed yet`);
        }
        return fromReceipt(receipt, req.vault);
      }),

    outcomeOf: outcomeOfHash,
  };
}
