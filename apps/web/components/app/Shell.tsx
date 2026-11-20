"use client";

import { BRAND_NAME, CHAIN } from "@rationale/config";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark, BrandWordmark } from "../Brand";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortAddress } from "../../lib/format";
import { useToast } from "../Toast";
import { useAccount } from "wagmi";
import { ensureRobinhoodChain, type Eip1193 } from "../../lib/chain";
import { RobotAvatar } from "../robot/RobotAvatar";
import { useMode } from "./Mode";
import { useSession } from "./Session";

type NavItem = { href: string; label: string; sub: string; icon?: string; count?: boolean };

const NAV: NavItem[] = [
  {
    href: "/app",
    label: "Overview",
    sub: "Your paper agents against simply holding.",
    icon: "M4 4h6.5v6.5H4ZM13.5 4H20v6.5h-6.5ZM4 13.5h6.5V20H4ZM13.5 13.5H20V20h-6.5Z",
  },
  {
    href: "/app/studio",
    label: "Agent Studio",
    sub: "Describe a strategy, check how it was read, backtest it, launch it.",
    icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9ZM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z",
  },
  {
    href: "/app/agents",
    label: "My agents",
    sub: "Every agent, and every decision it wrote down.",
    icon: "M12 7V4M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3ZM9 12.5v1.5M15 12.5v1.5M2 12v3M22 12v3",
    count: true,
  },
  {
    href: "/app/leaderboard",
    label: "Leaderboard",
    sub: "Paper agents ranked against holding the same market.",
    icon: "M5 20v-7M12 20V5M19 20v-10M3 20h18",
  },
  {
    href: "/app/vault",
    label: "Vault",
    sub: "Real money in a vault only your wallet can withdraw from.",
    icon: "M12 3l7.5 3v5.5c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V6ZM9 12l2.2 2.2L15.2 10",
  },
  {
    href: "/app/payroll",
    label: "Payroll",
    sub: "Scheduled payments from a vault. Arrives with live vaults.",
    icon: "M3.5 7.5h17v11h-17ZM3.5 11h17M7 15h4",
  },
];
/** Pages reached from the wallet menu rather than the rail. */
const HIDDEN: NavItem[] = [{ href: "/app/settings", label: "Settings", sub: "Risk limits for new strategies and agents." }];

/** Shown while the connected wallet is on another network: one click switches to Robinhood Chain, adding it if needed. */
function NetworkSwitch() {
  const { isConnected, chainId, connector } = useAccount();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!isConnected || !connector || chainId === undefined || chainId === CHAIN.id) return null;
  const go = async () => {
    setBusy(true);
    try {
      const provider = (await connector.getProvider()) as Eip1193;
      const outcome = await ensureRobinhoodChain(provider);
      if (outcome === "already" || outcome === "switched") connector.emitter.emit("change", { chainId: CHAIN.id });
      else if (outcome === "unsupported") toast(`Your wallet did not switch. Add ${CHAIN.name} in your wallet, then try again.`);
    } catch {
      toast(`Your wallet did not switch. Add ${CHAIN.name} in your wallet, then try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sm netswitch" disabled={busy} onClick={() => void go()}>
      {busy ? "Check your wallet…" : `Switch to ${CHAIN.name}`}
    </button>
  );
}

function WalletButton() {
  const { me, signIn, signOut, signingIn } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!me) {
    return (
      <button className="btn sm" onClick={() => void signIn()} disabled={signingIn}>
        {signingIn ? "Check your wallet…" : "Connect wallet"}
      </button>
    );
  }
  return (
    <div className="wallet-wrap" ref={ref}>
      <NetworkSwitch />
      <button className="btn sm walletbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <i aria-hidden="true" />
        {shortAddress(me.address)}
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          <small>Signed in as {shortAddress(me.address)}</small>
          <Link role="menuitem" href="/app/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const toast = useToast();
  const { me } = useSession();
  const { mode, setMode, liveOn } = useMode();
  const nav = useRef<HTMLElement>(null);
  // On a phone the links are one row that scrolls sideways: keep the current page's link in view.
  useEffect(() => {
    const row = nav.current;
    const on = row?.querySelector<HTMLElement>("a.on");
    if (row && on && row.scrollWidth > row.clientWidth) row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
  }, [pathname]);
  const active =
    [...NAV, ...HIDDEN].find((n) => n.href === pathname) ??
    NAV.find((n) => n.href !== "/app" && pathname.startsWith(n.href)) ??
    NAV[0]!;
  return (
    <div id="app">
      <aside className="rail">
        <Link className="logo" href="/" aria-label={BRAND_NAME}>
          <BrandMark />
          <BrandWordmark />
        </Link>
        <nav className="railnav" aria-label="App" ref={nav}>
          {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`nav${n.href === active.href ? " on" : ""}`}>
            <span className="navl">
              {n.icon && (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d={n.icon} />
                </svg>
              )}
              {n.label}
            </span>
            {n.count && me && me.agentCount > 0 ? <span className="count">{me.agentCount}</span> : null}
          </Link>
          ))}
        </nav>
        <div className="foot">
          <RobotAvatar seed="ratinole" size={42} tile house />
          <span>
            {mode === "live" ? "Live trading: real money in your own vault." : "Paper trading with virtual money."}
            <br />
            <Link href="/">Back to site</Link>
          </span>
        </div>
      </aside>
      <main className="main">
        <div className="bar">
          <div className="bartitle">
            <h1>{active.label}</h1>
            <p>{active.sub}</p>
          </div>
          <span className={`sample${mode === "live" ? " live" : ""}`}>{mode === "live" ? "Live" : "Paper"}</span>
          <div className="seg" role="group" aria-label="Mode">
            <button className={mode === "paper" ? "on" : undefined} aria-pressed={mode === "paper"} onClick={() => setMode("paper")}>
              Paper
            </button>
            <button
              className={mode === "live" ? "on" : undefined}
              aria-pressed={mode === "live"}
              disabled={!liveOn}
              title={liveOn ? "Real money in your own vault" : "Live trading opens with vaults"}
              onClick={() => {
                setMode("live");
                toast("Live mode: real money in your own vault.");
              }}
            >
              Live
            </button>
          </div>
          <WalletButton />
        </div>
        {children}
      </main>
    </div>
  );
}
