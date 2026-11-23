/**
 * Read-only access to vaults on Robinhood Chain, used to check a vault before a live agent is launched or
 * resumed. The API holds no key and never sends a transaction: users sign their own vault actions in their
 * wallet, and the engine signs the agent's swaps.
 */
import { CHAIN, ERC20_ABI, FACTORY_ABI, LIVE_STABLE, LIVE_TOKENS, VAULT_ABI, couldBeWorthADollar, fromUnits, type Address, type MarketId } from "@rationale/config";
import { createPublicClient, defineChain, http, zeroAddress, type Abi } from "viem";

export interface VaultInfo {
  vault: Address;
  owner: Address;
  operator: Address;
  paused: boolean;
  /** Dollars of the stablecoin in the vault. */
  cash: number;
  /**
   * The market token's amount, whether the vault may trade it exactly as the factory set it up (allowed, same
   * pool, same price feed), and its oracle price (null when the oracle has none).
   */
  token: { qty: number; tradable: boolean; priceUsd: number | null };
  /** Dollars of the other tokens this site trades that sit in the vault, as far as the oracle prices them. */
  otherUsd: number;
  /** One of those other tokens is in the vault and the oracle has no price for it: `otherUsd` is then too low. */
  otherUnpriced: boolean;
}

export interface VaultReader {
  factory: Address;
  /** The operator the factory gives new vaults: the engine's address. */
  defaultOperator(): Promise<Address>;
  /** ETH that address holds, for network fees. */
  operatorEth(): Promise<number>;
  /** The wallet's vault, or null when it has none. */
  vaultOf(owner: string): Promise<Address | null>;
  read(vault: Address, market: MarketId): Promise<VaultInfo>;
}

const lower = (a: string) => a.toLowerCase() as Address;
/** What `tokens(address)` returns: allowed, decimals, maxStaleness, feeTier, feed. */
type TokenConfig = readonly [boolean, number, number, number, Address];

export function viemVaultReader(opts: { rpcUrl: string; factory: string }): VaultReader {
  const chain = defineChain({
    id: CHAIN.id,
    name: CHAIN.name,
    nativeCurrency: CHAIN.nativeCurrency,
    rpcUrls: { default: { http: [opts.rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  // Short waits: a launch must answer well inside the web server's own time limit.
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl, { timeout: 6_000, retryCount: 1 }) });
  const factory = { address: opts.factory as Address, abi: FACTORY_ABI } as const;

  /** The factory's own settings for each token: what an untouched vault has. Read once; they never change. */
  let defaults: Promise<Map<string, { feed: string; feeTier: number; maxStaleness: number }>> | null = null;
  const factoryDefaults = () => {
    defaults ??= pub
      .readContract({ ...factory, functionName: "getDefaults" })
      .then(([, tokens, feeds, staleness, feeTiers]) => new Map(tokens.map((t, i) => [lower(t), { feed: lower(feeds[i]!), feeTier: feeTiers[i]!, maxStaleness: staleness[i]! }])))
      .catch((err) => {
        defaults = null;
        throw err;
      });
    return defaults;
  };

  return {
    factory: lower(opts.factory),
    defaultOperator: async () => lower(await pub.readContract({ ...factory, functionName: "defaultOperator" })),
    async operatorEth() {
      const operator = await pub.readContract({ ...factory, functionName: "defaultOperator" });
      return fromUnits(await pub.getBalance({ address: operator }), 18);
    },
    async vaultOf(owner) {
      const v = await pub.readContract({ ...factory, functionName: "vaultOf", args: [owner as Address] });
      return v === zeroAddress ? null : lower(v);
    },
    async read(vault, market) {
      const token = LIVE_TOKENS[market];
      const others = Object.values(LIVE_TOKENS).filter((t) => t.address !== token.address);
      const va = VAULT_ABI as Abi;
      const erc = ERC20_ABI as Abi;
      const call = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => ({ address, abi, functionName, args });
      // One batch, read by position. Calls 0 to 6 must succeed; a price may be missing (a stale oracle reverts).
      const [expected, r] = await Promise.all([
        factoryDefaults(),
        pub.multicall({
          contracts: [
            call(vault, va, "owner"),
            call(vault, va, "operator"),
            call(vault, va, "paused"),
            call(vault, va, "tokens", [token.address]),
            call(vault, va, "tokens", [LIVE_STABLE.address]),
            call(LIVE_STABLE.address, erc, "balanceOf", [vault]),
            call(token.address, erc, "balanceOf", [vault]),
            call(vault, va, "priceUsd", [token.address]),
            ...others.flatMap((t) => [call(t.address, erc, "balanceOf", [vault]), call(vault, va, "priceUsd", [t.address])]),
          ],
        }),
      ]);
      const must = <T>(i: number): T => {
        const x = r[i];
        if (!x || x.status !== "success") throw new Error("The vault could not be read");
        return x.result as T;
      };
      const may = <T>(i: number): T | null => (r[i]?.status === "success" ? (r[i]!.result as T) : null);
      const tokenCfg = must<TokenConfig>(3);
      const stableCfg = must<TokenConfig>(4);
      const sameAsFactory = (addr: Address, cfg: TokenConfig) => {
        const d = expected.get(lower(addr));
        return !!d && cfg[0] && lower(cfg[4]) === d.feed && cfg[3] === d.feeTier && cfg[2] === d.maxStaleness;
      };
      let otherUsd = 0;
      let otherUnpriced = false;
      others.forEach((t, k) => {
        const bal = must<bigint>(8 + 2 * k);
        const px = may<bigint>(9 + 2 * k);
        if (px != null) otherUsd += fromUnits(bal, t.decimals) * fromUnits(px, 18);
        // A speck without a price is nothing. Anyone can send a vault one unit of a token, and that must not
        // stand in the way of its owner.
        else if (couldBeWorthADollar(fromUnits(bal, t.decimals))) otherUnpriced = true;
      });
      const price = may<bigint>(7);
      return {
        vault,
        owner: lower(must<Address>(0)),
        operator: lower(must<Address>(1)),
        paused: must<boolean>(2),
        cash: fromUnits(must<bigint>(5), LIVE_STABLE.decimals),
        token: {
          qty: fromUnits(must<bigint>(6), token.decimals),
          tradable: sameAsFactory(token.address, tokenCfg) && sameAsFactory(LIVE_STABLE.address, stableCfg) && tokenCfg[1] === token.decimals && tokenCfg[3] > 0,
          priceUsd: price == null ? null : fromUnits(price, 18),
        },
        otherUsd,
        otherUnpriced,
      };
    },
  };
}
