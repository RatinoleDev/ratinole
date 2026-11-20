/**
 * The engine's view of a vault on Robinhood Chain, and the one thing it may do there: swap inside the vault with
 * the operator key. The key comes from the environment and never leaves this process. It cannot withdraw: the
 * vault contract only lets it swap, within the limits the vault's owner set.
 */
import { CHAIN, ERC20_ABI, LIVE_STABLE, VAULT_ABI, type Address } from "@rationale/config";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A vault read at one block. Balances are raw token units. */
export interface VaultSnapshot {
  owner: Address;
  operator: Address;
  paused: boolean;
  stable: bigint;
  token: bigint;
  /** The vault allows both the stablecoin and the market's token. */
  tradable: boolean;
  /** Pool fee pinned for the market's token, in hundredths of a basis point (500 = 0.05%). */
  feeTier: number;
}

export interface SwapRequest {
  vault: Address;
  tokenIn: Address;
  tokenOut: Address;
  feeTier: number;
  amountIn: bigint;
}

export type SwapOutcome = { ok: true; txHash: Hex; amountIn: bigint; amountOut: bigint } | { ok: false; reason: string; txHash?: Hex };

/** The order was sent, or may have been, and the chain has not said what became of it yet. Try again shortly. */
export class OrderPendingError extends Error {}

export interface VaultChain {
  /** The address of the key this engine signs with. A vault must name it as operator. */
  readonly operator: Address;
  blockNumber(): Promise<bigint>;
  snapshot(vault: Address, token: Address): Promise<VaultSnapshot>;
  /** Checks the order would succeed, sends it, and waits for the result. `onSent` runs as soon as it is broadcast. */
  swap(req: SwapRequest, onSent: (txHash: Hex) => Promise<void>): Promise<SwapOutcome>;
  /** What became of a sent transaction; null while the chain does not know it. */
  outcomeOf(txHash: Hex, vault: Address): Promise<SwapOutcome | null>;
  /** After a crash: the vault's swap of exactly this input since `fromBlock`, if there was one. */
  findSwap(req: SwapRequest, fromBlock: bigint): Promise<SwapOutcome | null>;
}

const lower = (a: string) => a.toLowerCase() as Address;

/** Plain words for why an order was refused. Shown to the vault's owner in the decision log. */
export function refusalReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
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
      // Uniswap's router refuses with this text when the pool cannot meet the minimum output.
      const text = revert.reason ?? revert.shortMessage;
      if (/too little received|SPL/i.test(text)) return "the pool price was worse than the vault's slippage limit";
      // "STF": the router could not take the tokens in, because the vault holds less than the order asked for.
      if (/\bSTF\b/.test(text)) return "the vault holds less than the order needed";
    }
    if (/insufficient funds/i.test(err.shortMessage)) return "the agent's own wallet is out of gas money";
    return `the chain refused the order (${err.shortMessage.replace(/\.$/, "")})`;
  }
  return "the chain could not be reached";
}

/** True when a failed send certainly left nothing on the chain. Anything unclear is treated as possibly sent. */
function neverSent(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) return true;
  return /insufficient funds|nonce too low|intrinsic gas|gas limit|underpriced|fee cap|max fee per gas|execution reverted/i.test(`${err.shortMessage} ${err.details ?? ""}`);
}

export interface ViemChainOptions {
  rpcUrl: string;
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

  const fromReceipt = (receipt: TransactionReceipt, vault: Address): SwapOutcome => {
    if (receipt.status !== "success") return { ok: false, reason: "the order was refused on-chain", txHash: receipt.transactionHash };
    const logs = parseEventLogs({ abi: VAULT_ABI, eventName: "Swapped", logs: receipt.logs }).filter((l) => lower(l.address) === lower(vault));
    const swapped = logs[0];
    if (!swapped) return { ok: false, reason: "the transaction held no swap for this vault", txHash: receipt.transactionHash };
    return { ok: true, txHash: receipt.transactionHash, amountIn: swapped.args.amountIn, amountOut: swapped.args.amountOut };
  };

  return {
    operator: lower(account.address),
    blockNumber: () => pub.getBlockNumber(),

    async snapshot(vault, token) {
      const v = { address: vault, abi: VAULT_ABI } as const;
      const [owner, operator, paused, tokenCfg, stableCfg, stable, bal] = await pub.multicall({
        allowFailure: false,
        contracts: [
          { ...v, functionName: "owner" },
          { ...v, functionName: "operator" },
          { ...v, functionName: "paused" },
          { ...v, functionName: "tokens", args: [token] },
          { ...v, functionName: "tokens", args: [LIVE_STABLE.address] },
          { address: LIVE_STABLE.address, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
          { address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
        ],
      });
      // tokens(address) returns (allowed, decimals, maxStaleness, feeTier, feed).
      return {
        owner: lower(owner),
        operator: lower(operator),
        paused,
        stable,
        token: bal,
        tradable: tokenCfg[0] && stableCfg[0] && tokenCfg[3] > 0,
        feeTier: tokenCfg[3],
      };
    },

    swap: (req, onSent) =>
      inTurn(async () => {
        const call = {
          account,
          address: req.vault,
          abi: VAULT_ABI,
          functionName: "swap",
          // The last argument is our own minimum output. Zero leaves it to the vault, which works the minimum
          // out from the Chainlink price and the owner's slippage limit and enforces it itself.
          args: [req.tokenIn, req.tokenOut, req.feeTier, req.amountIn, 0n],
        } as const;
        let hash: Hex;
        try {
          // A dry run first: an order the vault would refuse costs nothing and is never sent.
          await pub.simulateContract(call);
        } catch (err) {
          return { ok: false, reason: refusalReason(err) };
        }
        try {
          hash = await wallet.writeContract(call);
        } catch (err) {
          if (neverSent(err)) return { ok: false, reason: refusalReason(err) };
          // The connection failed while sending. The order may be out there: say so, and let the caller find out.
          throw new OrderPendingError("The order may or may not have been sent");
        }
        await onSent(hash);
        let receipt: TransactionReceipt;
        try {
          receipt = await pub.waitForTransactionReceipt({ hash, timeout: opts.confirmTimeoutMs ?? 120_000 });
        } catch {
          throw new OrderPendingError(`Order ${hash} is not confirmed yet`);
        }
        return fromReceipt(receipt, req.vault);
      }),

    async outcomeOf(txHash, vault) {
      try {
        return fromReceipt(await pub.getTransactionReceipt({ hash: txHash }), vault);
      } catch {
        return null;
      }
    },

    async findSwap(req, fromBlock) {
      const logs = await pub.getContractEvents({
        address: req.vault,
        abi: VAULT_ABI,
        eventName: "Swapped",
        args: { tokenIn: req.tokenIn, tokenOut: req.tokenOut },
        fromBlock,
        toBlock: "latest",
      });
      const hit = logs.find((l) => l.args.amountIn === req.amountIn);
      if (!hit || hit.args.amountOut == null) return null;
      return { ok: true, txHash: hit.transactionHash, amountIn: req.amountIn, amountOut: hit.args.amountOut };
    },
  };
}
