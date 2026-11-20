"use client";

/**
 * The wallet picker. Lists every wallet installed in this browser (each announces its own name and logo,
 * EIP-6963), then popular wallets that are not installed, with a link to install them or, on a phone, to open
 * this page inside the wallet's own app.
 */
import { BRAND_NAME } from "@rationale/config";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Connector } from "wagmi";
import { useConnect } from "wagmi";
import { KNOWN_WALLETS, isMobile, type KnownWallet } from "../../lib/wallets";

export type PickerStage = { name: string; step: "connect" | "sign" } | null;

function knownFor(c: Connector): KnownWallet | undefined {
  return KNOWN_WALLETS.find((w) => w.rdns === c.id || w.name.toLowerCase() === c.name.toLowerCase());
}

export function WalletPicker({
  open,
  stage,
  onPick,
  onClose,
}: {
  open: boolean;
  stage: PickerStage;
  onPick: (connector: Connector) => void;
  onClose: () => void;
}) {
  const { connectors } = useConnect();
  const [mobile, setMobile] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setMobile(isMobile()), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.querySelector<HTMLElement>("button, a")?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Wallets that announced themselves; the generic injected one only when nothing else did.
  const detected = useMemo(() => {
    const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    if (announced.length) return announced;
    const hasLegacy = typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
    return hasLegacy ? connectors.filter((c) => c.id === "injected") : [];
  }, [connectors]);
  const others = KNOWN_WALLETS.filter((w) => !detected.some((c) => knownFor(c)?.rdns === w.rdns));
  const here = typeof window !== "undefined" ? window.location.href : "";

  if (!open) return null;
  return (
    <div className="wpick-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wpick" role="dialog" aria-modal="true" aria-labelledby="wpick-title" ref={box}>
        <div className="wpick-head">
          <h2 id="wpick-title">Connect a wallet</h2>
          <button className="wpick-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="wpick-sub">Sign in with your wallet. Signing in does not move funds or approve anything.</p>

        {detected.length > 0 ? (
          <>
            <div className="wpick-label">Installed</div>
            <ul className="wpick-list">
              {detected.map((c) => {
                const k = knownFor(c);
                const icon = c.icon ?? k?.icon;
                const name = c.id === "injected" ? "Browser wallet" : c.name;
                const busy = stage?.name === name;
                return (
                  <li key={c.uid}>
                    <button className={`wpick-row${busy ? " busy" : ""}`} onClick={() => onPick(c)} disabled={!!stage}>
                      {icon ? <img src={icon} alt="" width={36} height={36} /> : <span className="wpick-noicon" aria-hidden="true" />}
                      <span className="wpick-name">{name}</span>
                      <span className="wpick-tag">
                        {busy ? (stage?.step === "sign" ? "Sign in your wallet…" : "Opening…") : "Detected"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="wpick-none">
            {mobile ? "No wallet found in this browser. Open this page inside your wallet app:" : "No wallet found in this browser. Install one to sign in:"}
          </p>
        )}

        {others.length > 0 ? (
          <>
            <div className="wpick-label">{detected.length ? "Other wallets" : mobile ? "Open in a wallet app" : "Popular wallets"}</div>
            <ul className="wpick-list">
              {others.map((w) => {
                const href = mobile && w.openInApp && here ? w.openInApp(here) : w.install;
                return (
                  <li key={w.rdns}>
                    <a className="wpick-row" href={href} target="_blank" rel="noopener noreferrer">
                      <img src={w.icon} alt="" width={36} height={36} />
                      <span className="wpick-name">{w.name}</span>
                      <span className="wpick-tag out">{mobile && w.openInApp ? "Open app ↗" : "Install ↗"}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <p className="wpick-foot">A wallet keeps your keys on your device. {BRAND_NAME} never sees them.</p>
      </div>
    </div>
  );
}
