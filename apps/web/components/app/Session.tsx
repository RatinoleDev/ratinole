"use client";

import { BRAND_NAME, CHAIN, type MeDTO } from "@rationale/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useConnect, useDisconnect, useSignMessage, type Connector } from "wagmi";
import { ApiFailure, api, post } from "../../lib/api";
import { ensureRobinhoodChain, isUserRejection, unlessIgnored, walletErrorCode, type ChainOutcome, type Eip1193 } from "../../lib/chain";
import { Robot3D } from "../robot/Robot3D";
import { useToast } from "../Toast";
import { WalletPicker, type PickerStage } from "./WalletPicker";

type SessionValue = {
  me: MeDTO | null;
  loading: boolean;
  /**
   * The server could not be asked who is signed in (it cannot be reached, or it failed). `me` is null then, but
   * that is not the same as "signed out": nobody knows. Only the Vault page acts on this, to let a person reach
   * their own vault on-chain while the server is down.
   */
  unreachable: boolean;
  signingIn: boolean;
  signIn: () => Promise<boolean>;
  /**
   * Connects a wallet to this browser without signing in: no message to sign and no call to the server. It does
   * not prove anything to the site, and it is not needed for that: every vault action is signed by the wallet
   * itself and checked by the vault's contract.
   */
  connectWallet: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refresh: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [signingIn, setSigningIn] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stage, setStage] = useState<PickerStage>(null);
  const [unreachable, setUnreachable] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  /** What picking a wallet in the open picker does: sign in, or only connect. */
  const pickFor = useRef<"signin" | "connect">("signin");
  /** Bumped whenever a sign-in starts or is abandoned, so an abandoned attempt cannot touch the screen later. */
  const attempt = useRef(0);

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await api<MeDTO>("/me");
        setUnreachable(false);
        return me;
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 401) {
          setUnreachable(false);
          return null;
        }
        if (e instanceof ApiFailure && (e.status >= 500 || e.status === 0)) {
          setUnreachable(true);
          return null;
        }
        throw e;
      }
    },
    retry: false,
    staleTime: 30_000,
    // While the server cannot be reached, keep asking, so the page recovers by itself when it is back.
    refetchInterval: unreachable ? 15_000 : false,
  });

  /**
   * Signs in with `connector`, or with the wallet that is already connected.
   *
   * The wallet is asked for Robinhood Chain BEFORE it is asked to connect, so wallets that build their connection
   * request around the current network show Robinhood Chain there. Wallets that only accept network requests
   * from a connected site are asked again right after connecting. Sign-in never depends on the network step: if
   * the wallet refuses or cannot add the network, the user is told and signing in carries on.
   */
  /**
   * Steps 1 to 3 of signing in, which are also all of "connect only": network, connect, network again. Returns
   * the connected account and a note about the network, or null when the attempt was abandoned meanwhile.
   */
  const connectSteps = useCallback(
    async (connector: Connector | null, label: string, live: () => boolean, show: (step: NonNullable<PickerStage>["step"]) => void) => {
      let account = isConnected ? address : undefined;
      const used = account ? activeConnector : (connector ?? undefined);
      if (!account && !used) throw new Error("No wallet");
      const provider = used ? ((await used.getProvider().catch(() => null)) as Eip1193 | null) : null;

      // 1. Network first.
      let chain: ChainOutcome = "no-answer";
      const early = provider ? ensureRobinhoodChain(provider) : null;
      if (early) {
        show("network");
        chain = await unlessIgnored(early);
      }
      if (!live()) return null;

      // 2. Connect.
      if (!account) {
        show("connect");
        const res = await connectAsync({ connector: used! });
        account = res.accounts[0];
      }
      if (!account) throw new Error("No account");
      if (!live()) return null;

      // 3. Wallets that ignored or refused the network request before connecting are asked once more.
      if (provider && early && (chain === "no-answer" || chain === "unsupported")) {
        show("network");
        if (chain === "no-answer") chain = await unlessIgnored(early, 1500);
        if (chain === "no-answer" || chain === "unsupported") chain = await unlessIgnored(ensureRobinhoodChain(provider));
      }
      if (!live()) return null;
      // Shown with the final message, so it is not replaced before it can be read.
      let networkNote = "";
      if (chain === "already" || chain === "switched") used?.emitter.emit("change", { chainId: CHAIN.id });
      else if (chain === "rejected") networkNote = ` Switch ${label} to ${CHAIN.name} before trading.`;
      else if (chain === "unsupported") networkNote = ` ${label} could not switch to ${CHAIN.name}: add the network in your wallet before trading.`;
      return { account, networkNote };
    },
    [activeConnector, address, connectAsync, isConnected],
  );

  const signInWith = useCallback(
    async (connector: Connector | null, label: string): Promise<boolean> => {
      const mine = ++attempt.current;
      const live = () => attempt.current === mine;
      const show = (step: NonNullable<PickerStage>["step"]) => live() && setStage({ name: label, step });
      setSigningIn(true);
      try {
        const connected = await connectSteps(connector, label, live, show);
        if (!connected) return false;
        const { account, networkNote } = connected;

        // 4. Sign.
        show("sign");
        const { nonce } = await api<{ nonce: string }>("/auth/nonce");
        const message = createSiweMessage({
          address: account,
          chainId: CHAIN.id,
          domain: window.location.host,
          nonce,
          uri: window.location.origin,
          version: "1",
          statement: `Sign in to ${BRAND_NAME}. This signature does not move funds or approve anything.`,
          issuedAt: new Date(),
        });
        const signature = await signMessageAsync({ message, account });
        const me = await post<MeDTO>("/auth/verify", { message, signature });
        qc.setQueryData(["me"], me);
        await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
        if (live()) toast(`Signed in.${networkNote}`);
        return true;
      } catch (e) {
        if (!live()) return false;
        if (isUserRejection(e)) toast("Sign-in cancelled");
        else if (walletErrorCode(e) === -32002) toast(`${label} is already waiting for your answer. Open your wallet to finish that request.`);
        else if (e instanceof ApiFailure) toast(e.message);
        else {
          console.error("Sign-in failed", e);
          toast("Sign-in failed. Try again.");
        }
        return false;
      } finally {
        if (live()) {
          setSigningIn(false);
          setStage(null);
        }
      }
    },
    [connectSteps, qc, signMessageAsync, toast],
  );

  /** Connects the picked wallet and stops there: nothing is signed and the server is not asked anything. */
  const connectOnly = useCallback(
    async (connector: Connector, label: string): Promise<boolean> => {
      const mine = ++attempt.current;
      const live = () => attempt.current === mine;
      const show = (step: NonNullable<PickerStage>["step"]) => live() && setStage({ name: label, step });
      setSigningIn(true);
      try {
        const connected = await connectSteps(connector, label, live, show);
        if (!connected) return false;
        if (live()) toast(`Wallet connected.${connected.networkNote}`);
        return true;
      } catch (e) {
        if (!live()) return false;
        if (isUserRejection(e)) toast("Connection cancelled");
        else if (walletErrorCode(e) === -32002) toast(`${label} is already waiting for your answer. Open your wallet to finish that request.`);
        else {
          console.error("Connecting failed", e);
          toast("The wallet did not connect. Try again.");
        }
        return false;
      } finally {
        if (live()) {
          setSigningIn(false);
          setStage(null);
        }
      }
    },
    [connectSteps, toast],
  );

  /** Closes the picker. Closing it while a wallet request is open abandons that attempt, so the buttons work again. */
  const closePicker = useCallback((ok: boolean) => {
    if (!ok) {
      attempt.current++;
      setSigningIn(false);
      setStage(null);
    }
    pending.current?.(ok);
    pending.current = null;
    setPickerOpen(false);
  }, []);

  /** Opens the wallet picker (or signs straight away if a wallet is already connected). Resolves to true once signed in. */
  const signIn = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    if (isConnected && address) return signInWith(null, activeConnector?.name ?? "your wallet");
    pending.current?.(false);
    pickFor.current = "signin";
    setPickerOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, [activeConnector, address, isConnected, signInWith]);

  /** Opens the wallet picker to connect only. Resolves to true once a wallet is connected. */
  const connectWallet = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    if (isConnected && address) return true;
    pending.current?.(false);
    pickFor.current = "connect";
    setPickerOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, [address, isConnected]);

  const onPick = useCallback(
    async (connector: Connector) => {
      const label = connector.id === "injected" ? "Browser wallet" : connector.name;
      const ok = pickFor.current === "connect" ? await connectOnly(connector, label) : await signInWith(connector, label);
      if (ok) closePicker(true); // on failure the picker stays open to try again or pick another wallet
    },
    [closePicker, connectOnly, signInWith],
  );

  const signOut = useCallback(async () => {
    try {
      await post("/auth/logout", {});
    } catch {
      /* the cookie may already be gone */
    }
    try {
      await disconnectAsync();
    } catch {
      /* wallet may not be connected */
    }
    qc.setQueryData(["me"], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    toast("Signed out");
  }, [disconnectAsync, qc, toast]);

  const value: SessionValue = {
    me: meQuery.data ?? null,
    loading: meQuery.isLoading,
    unreachable: unreachable && !meQuery.data,
    signingIn,
    signIn,
    connectWallet,
    signOut,
    refresh: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  };
  return (
    <SessionContext.Provider value={value}>
      {children}
      <WalletPicker open={pickerOpen} stage={stage} onPick={(c) => void onPick(c)} onClose={() => closePicker(false)} />
    </SessionContext.Provider>
  );
}

/** Shown in place of private content when no wallet is signed in. */
export function ConnectPanel({ text }: { text: string }) {
  const { signIn, signingIn, loading } = useSession();
  if (loading) return <div className="panel"><p className="empty">Checking your session…</p></div>;
  return (
    <div className="panel connect withbot">
      <Robot3D mood={signingIn ? "thinking" : "idle"} />
      <div>
        <h2>Connect a wallet</h2>
        <p>{text}</p>
        <button className="btn blue" onClick={() => void signIn()} disabled={signingIn}>
          {signingIn ? "Waiting for your wallet…" : "Connect wallet"}
        </button>
      </div>
    </div>
  );
}
