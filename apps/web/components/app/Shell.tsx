"use client";

import { BRAND_NAME } from "@rationale/config";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortAddress } from "../../lib/format";
import { useToast } from "../Toast";
import { useSession } from "./Session";

const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/studio", label: "Agent Studio" },
  { href: "/app/agents", label: "My agents", count: true },
  { href: "/app/leaderboard", label: "Leaderboard" },
  { href: "/app/vault", label: "Vault" },
  { href: "/app/payroll", label: "Payroll" },
];

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
      <button className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        {shortAddress(me.address)}
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          <small>Signed in as {shortAddress(me.address)}</small>
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
  const active = NAV.find((n) => n.href === pathname) ?? NAV.find((n) => n.href !== "/app" && pathname.startsWith(n.href)) ?? NAV[0]!;
  return (
    <div id="app">
      <aside className="rail">
        <Link className="logo" href="/">
          <i />
          {BRAND_NAME}
        </Link>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`nav${n.href === active.href ? " on" : ""}`}>
            {n.label}
            {n.count && me && me.agentCount > 0 ? <span className="count">{me.agentCount}</span> : null}
          </Link>
        ))}
        <div className="foot">
          Paper trading with virtual money.
          <br />
          <Link href="/">Back to site</Link>
        </div>
      </aside>
      <main className="main">
        <div className="bar">
          <h1>{active.label}</h1>
          <span className="sample">Paper</span>
          <div className="seg" role="group" aria-label="Mode">
            <button className="on" aria-pressed="true">
              Paper
            </button>
            <button
              disabled
              title="Live trading opens with vaults"
              onClick={() => toast("Live trading opens with vaults")}
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
