"use client";

import { BRAND_NAME, CHAIN, type MeDTO } from "@rationale/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { ApiFailure, api, post } from "../../lib/api";
import { useToast } from "../Toast";

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
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [signingIn, setSigningIn] = useState(false);

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

  const signIn = useCallback(async () => {
    if (typeof window === "undefined") return false;
    const eth = (window as unknown as { ethereum?: unknown }).ethereum;
    const connector = connectors[0];
    if (!eth || !connector) {
      toast("Install a browser wallet such as MetaMask or Rabby to sign in.");
      return false;
    }
    setSigningIn(true);
    try {
      let account = isConnected ? address : undefined;
      if (!account) {
        const res = await connectAsync({ connector });
        account = res.accounts[0];
      }
      if (!account) throw new Error("No account");
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
    }
  }, [address, connectAsync, connectors, isConnected, qc, signMessageAsync, toast]);

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
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
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
