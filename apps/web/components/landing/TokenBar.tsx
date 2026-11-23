"use client";

/**
 * The token's contract address, in the one place people are told to look for it. Copying it by hand from a post is
 * how people end up with a fake: here it is shown whole, can be copied in one click, and links to its own page
 * on the launchpad it was launched on.
 * The line under it says what the token is not, because the app does not use it.
 */
import { BRAND_NAME, TOKEN } from "@rationale/config";
import { useState } from "react";

export function TokenBar() {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  if (!TOKEN.address) return null;

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(TOKEN.address);
      ok = true;
    } catch {
      // No clipboard access (an old browser, or a page not served over https): the address can still be selected.
    }
    setCopied(ok ? "yes" : "no");
    setTimeout(() => setCopied(""), 2500);
  }

  return (
    <section className="tokenbar" aria-label={`The $${TOKEN.ticker} token`}>
      <div className="wrap">
        <div className="tokenbox">
          <div className="tokenrow">
            <b className="tokenname">${TOKEN.ticker}</b>
            <span className="tokenlabel">
              Contract address on Robinhood Chain
            </span>
            <code className="ca">{TOKEN.address}</code>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => void copy()}
            >
              {copied === "yes"
                ? "Copied"
                : copied === "no"
                  ? "Select and copy it"
                  : "Copy"}
            </button>
            <a
              className="tokenlink"
              href={TOKEN.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on {TOKEN.pageName}
            </a>
          </div>
          <p className="tokennote">
            This is the only ${TOKEN.ticker} address {BRAND_NAME} has published.
            ${TOKEN.ticker} is not needed to use {BRAND_NAME} and is not a claim
            on profit. Crypto is risky: you can lose all you put in.
          </p>
        </div>
      </div>
    </section>
  );
}
