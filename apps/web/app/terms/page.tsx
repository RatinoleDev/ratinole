import { BRAND_NAME } from "@rationale/config";
import type { Metadata } from "next";
import { LegalPage } from "../../components/LegalPage";

export const metadata: Metadata = { title: `Terms of service | ${BRAND_NAME}`, alternates: { canonical: "/terms" } };

export default function Terms() {
  return (
    <LegalPage title="Terms of service" lede={`The rules for using ${BRAND_NAME}. By signing in or using the site you agree to them.`}>
      <h2>What {BRAND_NAME} is</h2>
      <p>
        {BRAND_NAME} lets you describe a trading strategy in plain language, test it on historical prices, and run it as a
        paper agent with virtual money. Each hour a paper agent records what it saw, how it weighed the evidence and what it
        did. Live trading with real funds is not available yet.
      </p>
      <h2>Not advice, no promise of profit</h2>
      <p>
        Nothing on {BRAND_NAME} is investment, financial, legal or tax advice. Plans, backtests, decisions and explanations
        are produced by software and can be wrong. Backtests are simulations on past data and do not predict future
        results. Read the <a href="/risk">risk disclosure</a>.
      </p>
      <h2>Your wallet</h2>
      <p>
        You sign in by signing a message with your own wallet. That signature does not move funds or approve anything. You
        are responsible for your wallet. {BRAND_NAME} will never ask for your private key or recovery phrase; anyone who
        does is not us.
      </p>
      <h2>What you write and what is public</h2>
      <p>
        You keep the rights to the strategies you write. You allow {BRAND_NAME} to store and process them to run the
        service, including sending the text to an AI provider that turns it into a plan. Paper agents are public: their
        names, strategy sentences, decisions and results can appear on the leaderboard and on the home page. Your wallet
        address is not shown publicly.
      </p>
      <h2>Fair use</h2>
      <p>
        Do not attack, overload or probe the service, try to get around its limits, impersonate others, or try to make the
        strategy reader do anything other than read a trading strategy. We may limit or close access that breaks these
        rules.
      </p>
      <h2>Changes and availability</h2>
      <p>
        The service is provided as it is and as available. Features, markets, limits and these terms may change; we will
        update the date above when they do. Market data can be late, missing or wrong, and paper results can be affected.
      </p>
      <h2>Liability</h2>
      <p>
        To the extent the law allows, {BRAND_NAME} is not liable for losses arising from using the service, including
        decisions you make based on paper results or backtests.
      </p>
      <h2>Governing law</h2>
      <p>The governing law and venue will be set out here once confirmed.</p>
    </LegalPage>
  );
}
