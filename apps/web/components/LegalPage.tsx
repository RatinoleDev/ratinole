import { CONTACT_EMAIL } from "@rationale/config";
import type { ReactNode } from "react";
import { Footer, Nav } from "./landing/Sections";

export const LEGAL_UPDATED = "19 November 2026";

/** Shared frame for the terms, privacy and risk pages. */
export function LegalPage({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <div id="landing">
      <Nav base="/" />
      <main className="legalpage">
        <div className="wrap">
          <p className="draftnote">Draft, pending legal review. Last updated {LEGAL_UPDATED}.</p>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
          {children}
          <h2>Contact</h2>
          <p>
            {CONTACT_EMAIL ? (
              <>
                Questions about this page: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
              </>
            ) : (
              <>A contact address for questions about this page will be published here.</>
            )}
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
