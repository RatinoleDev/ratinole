/**
 * Popular browser wallets, shown in the wallet picker when they are not installed. Logos are the wallets' own
 * marks (taken from RainbowKit, MIT), used only to identify each wallet.
 */
export interface KnownWallet {
  /** EIP-6963 reverse-DNS id, to match a wallet that is installed. */
  rdns: string;
  name: string;
  icon: string;
  install: string;
  /** Opens a page inside the wallet's own app browser (mobile). */
  openInApp?: (url: string) => string;
}

export const KNOWN_WALLETS: KnownWallet[] = [
  {
    rdns: "io.metamask",
    name: "MetaMask",
    icon: "/wallets/metamask.svg",
    install: "https://metamask.io/download/",
    openInApp: (url) => `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}`,
  },
  { rdns: "io.rabby", name: "Rabby", icon: "/wallets/rabby.svg", install: "https://rabby.io/" },
  {
    rdns: "com.coinbase.wallet",
    name: "Coinbase Wallet",
    icon: "/wallets/coinbase.svg",
    install: "https://www.coinbase.com/wallet/downloads",
    openInApp: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`,
  },
  {
    rdns: "com.okex.wallet",
    name: "OKX Wallet",
    icon: "/wallets/okx.svg",
    install: "https://www.okx.com/web3",
    openInApp: (url) => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`,
  },
  {
    rdns: "app.phantom",
    name: "Phantom",
    icon: "/wallets/phantom.svg",
    install: "https://phantom.com/download",
    openInApp: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  },
  {
    rdns: "com.trustwallet.app",
    name: "Trust Wallet",
    icon: "/wallets/trust.svg",
    install: "https://trustwallet.com/download",
    openInApp: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`,
  },
];

export function isMobile(): boolean {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
