"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "../../lib/wagmi";
import { ToastProvider } from "../Toast";
import { ModeProvider } from "./Mode";
import { SessionProvider } from "./Session";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionProvider>
            <ModeProvider>{children}</ModeProvider>
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
