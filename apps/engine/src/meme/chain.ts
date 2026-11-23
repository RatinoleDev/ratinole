/**
 * The engine's view of a meme vault on Robinhood Chain, and the two things it may do there: buy a token the vault's
 * owner allowed, and sell it. Both happen inside the vault, signed with the operator key. The vault contract lets
 * that key do nothing else: it cannot withdraw, and it cannot trade a token, or more of one, than the owner set.
 *
 * Orders follow the same rule as in vault/chain.ts: checked by a dry run, signed, their hash written down, and only
 * then sent. So an order can always be found again, and none is ever sent twice.
 */
import { CHAIN, ERC20_ABI, MEME, MEME_FACTORY_ABI, MEME_VAULT_ABI, PONS, PONS_CURVE_ERRORS_ABI, PONS_FACTORY_ABI, PONS_VENUE_ERRORS_ABI, memeMinOut, type Address } from "@rationale/config";
import {
  BaseError,
  InsufficientFundsError,
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
import { NO_GAS_MONEY, OrderPendingError, contractRevert, nodeWords, refusedOutright, turnQueue, type InTurn } from "../vault/chain";

/** A meme vault and one token in it, read at one block. Amounts are wei or raw token units. */
export interface MemeSnapshot {
  block: bigint;
  /** The vault was created by the factory this engine works for. */
  ours: boolean;
  owner: Address;
  operator: Address;
  paused: boolean;
  eth: bigint;
  tokens: bigint;
  /** The venue the owner allowed this token on; null when the token is not allowed. */
  venue: Address | null;
  budgetLeft: bigint;
  remainingDaily: bigint;
  /** The launch's phase on its launchpad (PONS_PHASE); null when the launchpad does not know the token. */
  phase: number | null;
}

export type MemeOutcome =
  | { ok: true; txHash: Hex; side: "buy" | "sell"; /** ETH spent (buy) or received (sale). */ ethWei: bigint; /** Tokens received (buy) or sold (sale). */ tokens: bigint; block: bigint }
  | { ok: false; reason: string; txHash?: Hex };

export type MemeQuote = { ok: true; ethOut: bigint } | { ok: false; reason: string };

export interface MemeChain {
  /** The address of the key this engine signs with. A vault must name it as operator. */
  readonly operator: Address;
  /** The one venue this engine trades on. A token allowed on any other is left alone. */
  readonly venue: Address;
  chainTime(): Promise<number>;
  snapshot(vault: Address, token: Address, atLeastBlock?: bigint): Promise<MemeSnapshot>;
  /** What selling `amount` would return right now, after every fee. A dry run of the vault's own sale. */
  quoteSell(vault: Address, token: Address, amount: bigint): Promise<MemeQuote>;
  buy(req: { vault: Address; token: Address; ethIn: bigint; deadline: number }, onSigned: (txHash: Hex) => Promise<void>): Promise<MemeOutcome>;
  sell(req: { vault: Address; token: Address; amount: bigint; deadline: number }, onSigned: (txHash: Hex) => Promise<void>): Promise<MemeOutcome>;
  /** What became of a signed order; null while the chain does not know it. Throws when it cannot be asked. */
  outcomeOf(txHash: Hex, vault: Address): Promise<MemeOutcome | null>;
}

const lower = (a: string) => a.toLowerCase() as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
/** The vault's errors, and those of the venue and the launchpad behind it, so a refusal from any of them has a name. */
const ORDER_ABI = [...MEME_VAULT_ABI, ...PONS_VENUE_ERRORS_ABI, ...PONS_CURVE_ERRORS_ABI] as const;

/** Plain words for why an order was refused. Shown to the vault's owner. */
export function memeRefusalReason(err: unknown): string {
  const revert = contractRevert(err);
  if (revert) {
    switch (revert.errorName) {
      case "NotOperator":
        return "the agent's access to the vault was switched off";
      case "Paused":
        return "the vault is paused";
      case "TokenNotAllowed":
        return "the vault no longer allows this token";
      case "BudgetExceeded":
        return "the buy is larger than the budget left for this token in the vault";
      case "DailyLimitExceeded":
        return "the vault's daily buying limit is used up";
      case "InsufficientOutput":
      case "SlippageExceeded":
        return "the price moved too far while the order was being placed";
      case "NothingBought":
      case "NothingSold":
        return "the market returned nothing for the order";
      case "OrderExpired":
        return "the order reached the chain too late";
      case "ZeroAmount":
        return "there was nothing to trade";
      case "NotSupported":
        return "the token is not a launch this vault can trade";
      case "NotTradable":
        return "the token cannot be traded right now: its launch is between its curve and its pool, or was wound up";
      case "CurveGraduated":
        return "the launch's curve has just sold out and its pool is being made";
      case "EthTransferFailed":
        return "the vault does not hold enough ETH for the order";
    }
    return "the vault refused the order";
  }
  if (err instanceof BaseError && (err.walk((e) => e instanceof InsufficientFundsError) || NO_GAS_MONEY.test(nodeWords(err)))) return "the service's trading wallet could not pay the network fee";
  return "the network refused the order";
}

export interface ViemMemeOptions {
  rpcUrl: string;
  /** The meme vault factory. Only vaults it created are traded. */
  factory: Address;
  /** The venue this engine trades on. */
  venue: Address;
  /** 0x-prefixed 32-byte key. Read from the environment by the caller; never logged or stored. */
  privateKey: Hex;
  confirmTimeoutMs?: number;
  /** Shared with everything else that signs with the same key. */
  inTurn?: InTurn;
}

export function viemMemeChain(opts: ViemMemeOptions): MemeChain {
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
  const inTurn = opts.inTurn ?? turnQueue();
  const venue = lower(opts.venue);
  const latestBlock = () => pub.getBlockNumber({ cacheTime: 0 });

  const fromReceipt = (receipt: TransactionReceipt, vault: Address): MemeOutcome => {
    if (receipt.status !== "success") return { ok: false, reason: "the order was refused on-chain", txHash: receipt.transactionHash };
    const mine = <T extends { address: string }>(logs: T[]) => logs.filter((l) => lower(l.address) === lower(vault))[0];
    const bought = mine(parseEventLogs({ abi: MEME_VAULT_ABI, eventName: "Bought", logs: receipt.logs }));
    if (bought) return { ok: true, txHash: receipt.transactionHash, side: "buy", ethWei: bought.args.ethSpent, tokens: bought.args.tokensOut, block: receipt.blockNumber };
    const sold = mine(parseEventLogs({ abi: MEME_VAULT_ABI, eventName: "Sold", logs: receipt.logs }));
    if (sold) return { ok: true, txHash: receipt.transactionHash, side: "sell", ethWei: sold.args.ethOut, tokens: sold.args.tokensIn, block: receipt.blockNumber };
    return { ok: false, reason: "the transaction held no trade for this vault", txHash: receipt.transactionHash };
  };

  const outcomeOfHash = async (txHash: Hex, vault: Address): Promise<MemeOutcome | null> => {
    try {
      return fromReceipt(await pub.getTransactionReceipt({ hash: txHash }), vault);
    } catch (err) {
      // "Not found" means the chain does not know the transaction (yet). Anything else is a failed question.
      if (err instanceof BaseError && err.name === "TransactionReceiptNotFoundError") return null;
      throw err;
    }
  };

  type OrderCall =
    | { functionName: "buy"; ethIn: bigint; args: (minOut: bigint) => readonly [Address, bigint, bigint, bigint] }
    | { functionName: "sell"; args: (minOut: bigint) => readonly [Address, bigint, bigint, bigint] };

  /** Dry run, sign, write the hash down, send, wait. The same steps, in the same order, as an order in a live vault. */
  const place = (vault: Address, order: OrderCall, onSigned: (txHash: Hex) => Promise<void>) =>
    inTurn(async (): Promise<MemeOutcome> => {
      const call = (minOut: bigint) => ({ account, address: vault, abi: ORDER_ABI, functionName: order.functionName, args: order.args(minOut) }) as const;
      let serialized: Hex;
      try {
        // A dry run first: an order the vault would refuse costs nothing and is never signed. It also says what
        // the order would return, and the least accepted is set from that.
        const dry = await pub.simulateContract(call(1n) as never);
        const result = dry.result as unknown as bigint | readonly [bigint, bigint];
        let quote: bigint;
        if (typeof result === "bigint") quote = result;
        else {
          // A buy answers with the tokens it got and the ETH it used. A launch about to sell out uses only part of
          // the ETH: the minimum is for the whole amount, so the price seen is carried up to the whole amount.
          const [tokensOut, ethSpent] = result;
          const ethIn = order.functionName === "buy" ? order.ethIn : ethSpent;
          quote = ethSpent > 0n ? (tokensOut * ethIn) / ethSpent : tokensOut;
        }
        const final = call(memeMinOut(quote));
        const estimate = await pub.estimateContractGas(final as never);
        const roomy = (estimate * 15n) / 10n;
        const prepared = await wallet.prepareTransactionRequest({
          account,
          to: vault,
          data: encodeFunctionData(final as never),
          // A buy that happens to be the one that finishes a launch's curve also moves the launch into its pool,
          // which no estimate made a moment earlier allows for. Unused gas is not paid for.
          gas: roomy > BigInt(MEME.minGas) ? roomy : BigInt(MEME.minGas),
        });
        serialized = await wallet.signTransaction(prepared);
      } catch (err) {
        if (contractRevert(err) || refusedOutright(err)) return { ok: false, reason: memeRefusalReason(err) };
        // Trouble reaching the chain. Nothing was signed, so nothing happened: let the caller start again.
        throw err;
      }
      const hash = keccak256(serialized);
      // Written down before it is sent. If this throws, the order was withdrawn and nothing goes out.
      await onSigned(hash);
      try {
        await pub.sendRawTransaction({ serializedTransaction: serialized });
      } catch (err) {
        const known = await outcomeOfHash(hash, vault).catch(() => null);
        if (known) return known;
        if (refusedOutright(err)) return { ok: false, reason: memeRefusalReason(err), txHash: hash };
        throw new OrderPendingError(`Order ${hash} may or may not have reached the chain`);
      }
      let receipt: TransactionReceipt;
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: opts.confirmTimeoutMs ?? 60_000 });
      } catch {
        throw new OrderPendingError(`Order ${hash} is not confirmed yet`);
      }
      return fromReceipt(receipt, vault);
    });

  return {
    operator: lower(account.address),
    venue,
    chainTime: async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp),

    async snapshot(vault, token, atLeastBlock) {
      let block = await latestBlock();
      for (let tries = 0; atLeastBlock != null && block < atLeastBlock; tries++) {
        if (tries >= 20) throw new OrderPendingError("The chain connection has not caught up with the order yet");
        await new Promise((r) => setTimeout(r, 250));
        block = await latestBlock();
      }
      const va = MEME_VAULT_ABI as Abi;
      const call = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => ({ address, abi, functionName, args });
      // One batch at one block, read by position. Calls 0 to 7 must succeed; the launchpad's record may be missing.
      const [eth, r] = await Promise.all([
        pub.getBalance({ address: vault, blockNumber: block }),
        pub.multicall({
          blockNumber: block,
          contracts: [
            call(opts.factory, MEME_FACTORY_ABI as Abi, "isVault", [vault]),
            call(vault, va, "owner"),
            call(vault, va, "operator"),
            call(vault, va, "paused"),
            call(vault, va, "rules", [token]),
            call(vault, va, "remainingDailyWei"),
            call(token, ERC20_ABI as Abi, "balanceOf", [vault]),
            call(PONS.factory, PONS_FACTORY_ABI as Abi, "getLaunchedToken", [token]),
          ],
        }),
      ]);
      const must = <T>(i: number): T => {
        const x = r[i];
        if (!x || x.status !== "success") throw new Error("The meme vault could not be read");
        return x.result as T;
      };
      const rule = must<readonly [Address, bigint]>(4);
      const launch = r[7]?.status === "success" ? (r[7].result as { exists: boolean; phase: number; pairToken: Address }) : null;
      return {
        block,
        ours: must<boolean>(0),
        owner: lower(must<Address>(1)),
        operator: lower(must<Address>(2)),
        paused: must<boolean>(3),
        eth,
        tokens: must<bigint>(6),
        venue: rule[0] === ZERO ? null : lower(rule[0]),
        budgetLeft: rule[1],
        remainingDaily: must<bigint>(5),
        phase: launch?.exists && lower(launch.pairToken) === ZERO ? launch.phase : null,
      };
    },

    async quoteSell(vault, token, amount) {
      if (amount <= 0n) return { ok: false, reason: "there is nothing to sell" };
      try {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const dry = await pub.simulateContract({ account, address: vault, abi: ORDER_ABI, functionName: "sell", args: [token, amount, 1n, deadline] });
        return { ok: true, ethOut: dry.result };
      } catch (err) {
        if (contractRevert(err)) return { ok: false, reason: memeRefusalReason(err) };
        throw err;
      }
    },

    buy: (req, onSigned) => place(req.vault, { functionName: "buy", ethIn: req.ethIn, args: (minOut) => [req.token, req.ethIn, minOut, BigInt(req.deadline)] }, onSigned),
    sell: (req, onSigned) => place(req.vault, { functionName: "sell", args: (minOut) => [req.token, req.amount, minOut, BigInt(req.deadline)] }, onSigned),
    outcomeOf: outcomeOfHash,
  };
}
