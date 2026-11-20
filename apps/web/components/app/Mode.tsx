"use client";

/**
 * Paper or live. Paper is virtual money; live is real money in the wallet's own vault. The two are never shown
 * together. Live can only be chosen once the contracts are deployed and the server knows their address; until
 * then everything stays on paper.
 *
 * "Live trading is not open" is only ever said when the server has said so. While the server is being asked,
 * or cannot be reached, the pages say that instead: a person with money in a vault must never be shown "no
 * vault yet" because of a slow connection.
 */
import { CHAIN, type AgentMode, type ChainConfigDTO } from "@rationale/config";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";

type ModeValue = {
  mode: AgentMode;
  setMode: (m: AgentMode) => void;
  /** The vault screens are available: the contracts are deployed and this site knows them. */
  liveOn: boolean;
  /** Live agents can be started and are trading. False while the owner has paused live trading. */
  trading: boolean;
  chain: ChainConfigDTO | null;
  /** "loading": the server has not answered yet. "error": it could not be reached and nothing is known. */
  status: "loading" | "ready" | "error";
  /**
   * The server cannot be reached, and `chain` is what this device saw last time. Enough to show a vault and to
   * withdraw from it; nothing that moves money INTO a contract is offered on a remembered address.
   */
  degraded: boolean;
  retry: () => void;
};

const KEY = "ratinole:mode";
const CHAIN_KEY = "ratinole:chain";
const ModeContext = createContext<ModeValue>({
  mode: "paper",
  setMode: () => undefined,
  liveOn: false,
  trading: false,
  chain: null,
  status: "loading",
  degraded: false,
  retry: () => undefined,
});

export const useMode = () => useContext(ModeContext);

const isAddress = (a: unknown) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The chain settings this device saw last time, if they still have the shape the pages need. */
function remembered(): ChainConfigDTO | null {
  try {
    const c = JSON.parse(window.localStorage.getItem(CHAIN_KEY) ?? "null") as ChainConfigDTO | null;
    const ok = c && c.live === true && c.chainId === CHAIN.id && isAddress(c.factory) && isAddress(c.stable?.address) && Array.isArray(c.tokens) && c.tokens.every((t) => isAddress(t.address)) && !!c.limits;
    return ok ? c : null;
  } catch {
    return null;
  }
}

export function ModeProvider({ children }: { children: ReactNode }) {
  // Asked again every minute, so opening or pausing live trading reaches open pages without a reload.
  const q = useQuery({ queryKey: ["chain"], queryFn: () => api<ChainConfigDTO>("/public/chain"), staleTime: 30_000, refetchInterval: 60_000, retry: 2 });
  const [kept, setKept] = useState<ChainConfigDTO | null>(null);
  useEffect(() => setKept(remembered()), []);
  useEffect(() => {
    if (!q.data) return;
    try {
      if (q.data.live && q.data.factory) window.localStorage.setItem(CHAIN_KEY, JSON.stringify(q.data));
      else window.localStorage.removeItem(CHAIN_KEY);
    } catch {
      /* storage is optional */
    }
  }, [q.data]);

  // The server's answer always wins. What the device remembers is used only when the server cannot be reached.
  const fresh = q.data ?? null;
  const chain = fresh ?? (q.isError ? kept : null);
  const degraded = !fresh && !!chain;
  const status: ModeValue["status"] = chain ? "ready" : q.isError ? "error" : "loading";
  const liveOn = !!chain?.live && !!chain.factory;
  const [mode, set] = useState<AgentMode>("paper");

  // The last choice is remembered on this device, and only honoured while live trading is open. A slow or
  // unreachable server is not a reason to switch anyone's view back to paper.
  useEffect(() => {
    if (status !== "ready") return;
    if (!liveOn) {
      set("paper");
      return;
    }
    try {
      if (window.localStorage.getItem(KEY) === "live") set("live");
    } catch {
      /* storage is optional */
    }
  }, [liveOn, status]);

  const setMode = useCallback(
    (m: AgentMode) => {
      if (m === "live" && !liveOn) return;
      set(m);
      try {
        window.localStorage.setItem(KEY, m);
      } catch {
        /* storage is optional */
      }
    },
    [liveOn],
  );
  const refetch = q.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  return (
    <ModeContext.Provider value={{ mode, setMode, liveOn, trading: liveOn && !degraded && !!chain?.trading, chain, status, degraded, retry }}>{children}</ModeContext.Provider>
  );
}
