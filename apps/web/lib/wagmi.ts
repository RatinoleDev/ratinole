import { CHAIN } from "@rationale/config";
import { defineChain } from "viem";
import { createConfig, http, injected } from "wagmi";

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: CHAIN.explorerUrl } },
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
