import { BRAND_NAME, PAPER } from "@rationale/config";
import type { Metadata } from "next";
import { LegalPage } from "../../components/LegalPage";

export const metadata: Metadata = { title: `Risk disclosure | ${BRAND_NAME}`, alternates: { canonical: "/risk" } };

export default function Risk() {
  return (
    <LegalPage title="Risk disclosure" lede="Read this before relying on anything an agent or a backtest shows you.">
      <h2>You can lose money</h2>
      <p>
        Crypto assets and tokenized stocks are volatile. Prices can fall fast and far, and you can lose everything you put
        in. No strategy, agent or backtest removes that risk.
      </p>
      <h2>Paper results are not real results</h2>
      <p>
        Paper agents trade virtual money. Each simulated trade fills at the next hour&apos;s opening price with a{" "}
        {PAPER.costPct}% cost. Real markets, and the small pools on Robinhood Chain in particular, can fill at worse prices,
        so live results may be lower than paper results.
      </p>
      <h2>Backtests can mislead</h2>
      <p>
        A backtest tunes a strategy on 60 days of past prices and scores it on the next 30 days it did not see. A few trades
        cannot separate skill from luck; the backtest says so when that happens. Backtests use price signals only, and past
        markets do not repeat.
      </p>
      <h2>Agents act once an hour</h2>
      <p>
        An agent reads the market and decides once an hour. A stop loss, a take profit or a trailing stop is checked at
        that moment and not in between. If the price moves fast within the hour, the position is sold at the price of the
        next check, which can be well past the level you set. An order that is refused, or that cannot be placed early in
        the hour, is not placed late: the agent waits for the next hour and says why.
      </p>
      <h2>Software and data can fail</h2>
      <p>
        Agents depend on market data, servers and code. Data can arrive late or wrong, and a run can be missed. When data is
        stale an agent holds rather than trades, which can also mean missing a move.
      </p>
      <h2>Live trading, when it opens</h2>
      <p>
        Live vaults will be smart contracts on Robinhood Chain. Contracts can have bugs, chains can halt, and stock-token
        prices pause when their markets are closed. Tokenized stocks may not be legal to buy where you live. Check before you
        use them.
      </p>
      <h2>Not advice</h2>
      <p>
        {BRAND_NAME} provides tools, not advice. Decide for yourself, and only risk money you can afford to lose.
      </p>
    </LegalPage>
  );
}
