import { CHAIN } from "@rationale/config";
import { defineChain } from "viem";
import { createConfig, http, injected } from "wagmi";
import { RPC_URL as rpcUrl } from "./chain";

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: CHAIN.explorerUrl } },
  // Lets several reads of a vault travel as one request.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * Browser wallets only, no WalletConnect. Every installed wallet that announces itself (EIP-6963: MetaMask,
 * Rabby, Coinbase, OKX, Phantom, Trust, Brave and others) appears with its own name and logo; `injected()`
 * covers older wallets that only set `window.ethereum`.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: { [robinhoodChain.id]: http() },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
