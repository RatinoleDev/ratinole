"use client";

import { BRAND_NAME, CHAIN, type MeDTO } from "@rationale/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain, type Connector } from "wagmi";
import { ApiFailure, api, post } from "../../lib/api";
import { robinhoodChain } from "../../lib/wagmi";
import { useToast } from "../Toast";
import { WalletPicker, type PickerStage } from "./WalletPicker";

type SessionValue = {
  me: MeDTO | null;
  loading: boolean;
  signingIn: boolean;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refresh: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

function isUserRejection(e: unknown): boolean {
  const err = e as { name?: string; code?: number; message?: string; cause?: { code?: number } };
  return (
    err?.name === "UserRejectedRequestError" ||
    err?.code === 4001 ||
    err?.cause?.code === 4001 ||
    /reject|denied|cancel/i.test(err?.message ?? "")
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [signingIn, setSigningIn] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stage, setStage] = useState<PickerStage>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<MeDTO>("/me");
      } catch (e) {
        if (e instanceof ApiFailure && (e.status === 401 || e.status >= 500 || e.status === 0)) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 30_000,
  });

  /**
   * Moves the wallet to Robinhood Chain, adding the network first when the wallet does not know it (wagmi sends
   * wallet_addEthereumChain with our chain's name, RPC, explorer and currency). Sign-in does not depend on it:
   * if the wallet refuses or cannot add the network, the user is told and sign-in carries on.
   */
  const toRobinhoodChain = useCallback(
    async (connector: Connector | undefined, label: string) => {
      if (!connector) return;
      try {
        if ((await connector.getChainId()) === robinhoodChain.id) return;
      } catch {
        return;
      }
      setStage({ name: label, step: "network" });
      const attempt = () => switchChainAsync({ chainId: robinhoodChain.id, connector });
      try {
        await attempt();
      } catch (e) {
        // Some wallets add the network without switching to it; ask once more in that case only.
        const addedOnly = /after adding network/i.test(String((e as { message?: string })?.message ?? ""));
        try {
          if (!addedOnly) throw e;
          await attempt();
        } catch (e2) {
          toast(
            isUserRejection(e2) && !addedOnly
              ? `Switch ${label} to ${robinhoodChain.name} before trading. Signing in continues.`
              : `${label} could not switch to ${robinhoodChain.name}. You can sign in; add the network in your wallet before trading.`,
          );
        }
      }
    },
    [switchChainAsync, toast],
  );

  /** Connect with `connector` (or the wallet already connected) and sign the sign-in message. */
  const signInWith = useCallback(
    async (connector: Connector | null, label: string): Promise<boolean> => {
      setSigningIn(true);
      try {
        let account = isConnected ? address : undefined;
        let used = isConnected ? activeConnector : undefined;
        if (!account) {
          if (!connector) throw new Error("No wallet");
          setStage({ name: label, step: "connect" });
          const res = await connectAsync({ connector });
          account = res.accounts[0];
          used = connector;
        }
        if (!account) throw new Error("No account");
        await toRobinhoodChain(used, label);
        setStage({ name: label, step: "sign" });
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
        toast("Signed in");
        return true;
      } catch (e) {
        if (isUserRejection(e)) toast("Sign-in cancelled");
        else if (e instanceof ApiFailure) toast(e.message);
        else {
          console.error("Sign-in failed", e);
          toast("Sign-in failed. Try again.");
        }
        return false;
      } finally {
        setSigningIn(false);
        setStage(null);
      }
    },
    [activeConnector, address, connectAsync, isConnected, qc, signMessageAsync, toRobinhoodChain, toast],
  );

  const closePicker = useCallback((ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setPickerOpen(false);
  }, []);

  /** Opens the wallet picker (or signs straight away if a wallet is already connected). Resolves to true once signed in. */
  const signIn = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    if (isConnected && address) return signInWith(null, "your wallet");
    pending.current?.(false);
    setPickerOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, [address, isConnected, signInWith]);

  const onPick = useCallback(
    async (connector: Connector) => {
      const label = connector.id === "injected" ? "Browser wallet" : connector.name;
      const ok = await signInWith(connector, label);
      if (ok) closePicker(true); // on failure the picker stays open to try again or pick another wallet
    },
    [closePicker, signInWith],
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
    signingIn,
    signIn,
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
    <div className="panel connect">
      <h2>Connect a wallet</h2>
      <p>{text}</p>
      <button className="btn" onClick={() => void signIn()} disabled={signingIn}>
        {signingIn ? "Waiting for your wallet…" : "Connect wallet"}
      </button>
    </div>
  );
}
