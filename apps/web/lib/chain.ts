/**
 * Puts a browser wallet on Robinhood Chain by talking to the wallet directly (EIP-1193), so it can be asked
 * before the site is connected as well as after. Order: switch; if the wallet does not know the network, add it
 * (EIP-3085) with our name, RPC, explorer and currency; then confirm the wallet really reports the new network.
 * Nothing here moves funds, and sign-in never depends on the outcome.
 */
import { CHAIN } from "@rationale/config";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** `no-answer`: the wallet neither answered nor opened a window, so we stopped waiting. */
export type ChainOutcome = "already" | "switched" | "rejected" | "unsupported" | "no-answer";

export const CHAIN_HEX = `0x${CHAIN.id.toString(16)}`;

/**
 * Where this build reads the chain: the public RPC, unless a build sets another one (a local fork, for rehearsing
 * live trading with fake money). The same address is the one handed to wallets when the network is added, so a
 * rehearsal build never reads a fork while pointing a wallet at the real chain.
 */
export const RPC_URL = process.env.NEXT_PUBLIC_CHAIN_RPC_URL || CHAIN.rpcUrl;

export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [CHAIN.explorerUrl],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function walletErrorCode(e: unknown): number | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown }; data?: { originalError?: { code?: unknown } } };
  const code = err?.code ?? err?.cause?.code ?? err?.data?.originalError?.code;
  return typeof code === "number" ? code : undefined;
}

export function isUserRejection(e: unknown): boolean {
  const code = walletErrorCode(e);
  if (code === 4001) return true;
  if (code === 4902) return false; // unknown network, not a refusal
  const err = e as { name?: string; message?: string };
  return err?.name === "UserRejectedRequestError" || /user (rejected|denied|cancel)|rejected by user|denied by user|cancell?ed/i.test(err?.message ?? "");
}

async function chainOf(provider: Eip1193): Promise<number | null> {
  try {
    const id = await Promise.race([provider.request({ method: "eth_chainId" }), sleep(3000).then(() => null)]);
    const n = typeof id === "string" || typeof id === "number" ? Number(id) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Never rejects. */
export async function ensureRobinhoodChain(provider: Eip1193): Promise<Exclude<ChainOutcome, "no-answer">> {
  if ((await chainOf(provider)) === CHAIN.id) return "already";
  const switchTo = () => provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  try {
    await switchTo();
  } catch (e) {
    if (isUserRejection(e)) return "rejected";
    // The wallet does not know the network (error 4902 in most wallets, other codes in some): add it.
    try {
      await provider.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] });
    } catch (e2) {
      return isUserRejection(e2) ? "rejected" : "unsupported";
    }
    // Some wallets add the network without switching to it.
    if ((await chainOf(provider)) !== CHAIN.id) {
      try {
        await switchTo();
      } catch (e3) {
        return isUserRejection(e3) ? "rejected" : "unsupported";
      }
    }
  }
  // Wallets can take a moment to report the new network.
  for (let i = 0; i < 10; i++) {
    if ((await chainOf(provider)) === CHAIN.id) return "switched";
    await sleep(200);
  }
  return "unsupported";
}

/**
 * Waits for a wallet request, but stops when the wallet is clearly ignoring it: nothing came back and this page
 * never lost focus (so no wallet window opened) for `quietMs`, or `capMs` passed. The request itself is left
 * alone; a late answer is simply not waited for.
 */
export function unlessIgnored<T>(p: Promise<T>, quietMs = 2500, capMs = 60_000): Promise<T | "no-answer"> {
  return new Promise((resolve) => {
    let lostFocus = typeof document !== "undefined" && !document.hasFocus();
    const onBlur = () => {
      lostFocus = true;
    };
    window.addEventListener("blur", onBlur);
    const done = (v: T | "no-answer") => {
      clearTimeout(quiet);
      clearTimeout(cap);
      window.removeEventListener("blur", onBlur);
      resolve(v);
    };
    const quiet = setTimeout(() => {
      if (!lostFocus && document.hasFocus()) done("no-answer");
    }, quietMs);
    const cap = setTimeout(() => done("no-answer"), capMs);
    void p.then(done);
  });
}
