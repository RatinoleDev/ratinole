/**
 * Read-only access to vaults on Robinhood Chain, used to check a vault before a live agent is launched or
 * resumed. The API holds no key and never sends a transaction: users sign their own vault actions in their
 * wallet, and the engine signs the agent's swaps.
 */
import { CHAIN, ERC20_ABI, FACTORY_ABI, LIVE_STABLE, LIVE_TOKENS, VAULT_ABI, fromUnits, type Address, type MarketId } from "@rationale/config";
import { createPublicClient, defineChain, http, zeroAddress } from "viem";

export interface VaultInfo {
  vault: Address;
  owner: Address;
  operator: Address;
  paused: boolean;
  /** Dollars of the stablecoin in the vault. */
  cash: number;
  /** The market token's amount, whether the vault may trade it, and its oracle price (null when the oracle has none). */
  token: { qty: number; tradable: boolean; priceUsd: number | null };
}

export interface VaultReader {
  factory: Address;
  /** The operator the factory gives new vaults: the engine's address. */
  defaultOperator(): Promise<Address>;
  /** The wallet's vault, or null when it has none. */
  vaultOf(owner: string): Promise<Address | null>;
  read(vault: Address, market: MarketId): Promise<VaultInfo>;
}

const lower = (a: string) => a.toLowerCase() as Address;

export function viemVaultReader(opts: { rpcUrl: string; factory: string }): VaultReader {
  const chain = defineChain({
    id: CHAIN.id,
    name: CHAIN.name,
    nativeCurrency: CHAIN.nativeCurrency,
    rpcUrls: { default: { http: [opts.rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const factory = { address: opts.factory as Address, abi: FACTORY_ABI } as const;
  return {
    factory: lower(opts.factory),
    defaultOperator: async () => lower(await pub.readContract({ ...factory, functionName: "defaultOperator" })),
    async vaultOf(owner) {
      const v = await pub.readContract({ ...factory, functionName: "vaultOf", args: [owner as Address] });
      return v === zeroAddress ? null : lower(v);
    },
    async read(vault, market) {
      const token = LIVE_TOKENS[market];
      const v = { address: vault, abi: VAULT_ABI } as const;
      const [owner, operator, paused, tokenCfg, stableCfg, cash, qty, price] = await pub.multicall({
        contracts: [
          { ...v, functionName: "owner" },
          { ...v, functionName: "operator" },
          { ...v, functionName: "paused" },
          { ...v, functionName: "tokens", args: [token.address] },
          { ...v, functionName: "tokens", args: [LIVE_STABLE.address] },
          { address: LIVE_STABLE.address, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
          { address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
          // Reverts when the oracle is stale or the token is not allowed; that is an answer, not an error.
          { ...v, functionName: "priceUsd", args: [token.address] },
        ],
      });
      for (const r of [owner, operator, paused, tokenCfg, stableCfg, cash, qty]) if (r.status !== "success") throw new Error("The vault could not be read");
      return {
        vault,
        owner: lower(owner.result!),
        operator: lower(operator.result!),
        paused: paused.result!,
        cash: fromUnits(cash.result!, LIVE_STABLE.decimals),
        token: {
          qty: fromUnits(qty.result!, token.decimals),
          tradable: tokenCfg.result![0] && stableCfg.result![0] && tokenCfg.result![3] > 0,
          priceUsd: price.status === "success" ? fromUnits(price.result, 18) : null,
        },
      };
    },
  };
}
