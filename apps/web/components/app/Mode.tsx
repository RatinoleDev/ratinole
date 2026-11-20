"use client";

/**
 * Paper or live. Paper is virtual money; live is real money in the wallet's own vault. The two are never shown
 * together. Live can only be chosen once the contracts are deployed and the server knows their address; until
 * then everything stays on paper.
 */
import type { AgentMode, ChainConfigDTO } from "@rationale/config";
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
};

const KEY = "ratinole:mode";
const ModeContext = createContext<ModeValue>({ mode: "paper", setMode: () => undefined, liveOn: false, trading: false, chain: null });

export const useMode = () => useContext(ModeContext);

export function ModeProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ["chain"], queryFn: () => api<ChainConfigDTO>("/public/chain"), staleTime: 5 * 60_000, retry: 1 });
  const chain = q.data ?? null;
  const liveOn = !!chain?.live && !!chain.factory;
  const [mode, set] = useState<AgentMode>("paper");

  // The last choice is remembered on this device, and only honoured while live trading is open.
  useEffect(() => {
    try {
      if (liveOn && window.localStorage.getItem(KEY) === "live") set("live");
    } catch {
      /* storage is optional */
    }
    if (!liveOn) set("paper");
  }, [liveOn]);

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

  return <ModeContext.Provider value={{ mode, setMode, liveOn, trading: liveOn && !!chain?.trading, chain }}>{children}</ModeContext.Provider>;
}
