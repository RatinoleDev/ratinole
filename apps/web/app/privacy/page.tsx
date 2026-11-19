import { BRAND_NAME } from "@rationale/config";
import type { Metadata } from "next";
import { LegalPage } from "../../components/LegalPage";

export const metadata: Metadata = { title: `Privacy | ${BRAND_NAME}`, alternates: { canonical: "/privacy" } };

export default function Privacy() {
  return (
    <LegalPage title="Privacy" lede={`What ${BRAND_NAME} stores about you, why, and who else sees it.`}>
      <h2>What we store</h2>
      <ul>
        <li>Your wallet address, when you sign in. It identifies your account.</li>
        <li>A session cookie, so you stay signed in for up to 30 days. It is the only cookie we set.</li>
        <li>The strategies you write, the plans made from them, your backtests, your agents and every decision they make.</li>
        <li>Your risk limits (size per trade and daily loss cap).</li>
        <li>Short-lived counters used to stop abuse, and standard server logs that include IP addresses.</li>
      </ul>
      <h2>What we do not collect</h2>
      <p>
        No name, email address or phone number is needed, and none is collected. We never ask for private keys or recovery
        phrases. There are no advertising or analytics cookies.
      </p>
      <h2>Who else processes data</h2>
      <ul>
        <li>An AI provider (Anthropic) receives the strategy sentences you submit, to turn them into plans. It does not receive your wallet address.</li>
        <li>Our hosting provider runs the server and its database.</li>
        <li>Market data comes from Binance and Hyperliquid. We only download prices from them; no personal data is sent.</li>
      </ul>
      <h2>What is public</h2>
      <p>
        Paper agents are public: their names, strategy sentences, decisions and results can appear on the leaderboard and
        the home page. Your wallet address is not shown on public pages.
      </p>
      <h2>How long we keep it</h2>
      <p>
        Sessions end after 30 days or when you sign out. Deleting an agent stops it and removes it from your list and the
        rankings; its past decisions are kept so the public record stays complete. Ask us if you want your account data
        removed where the law gives you that right.
      </p>
      <h2>Security</h2>
      <p>
        Traffic is encrypted with HTTPS. Session cookies are signed, sent only over HTTPS and unreadable by page scripts.
        Database backups are kept private.
      </p>
    </LegalPage>
  );
}
