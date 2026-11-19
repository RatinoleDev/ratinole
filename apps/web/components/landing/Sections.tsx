import type { DecisionDTO, ExampleDTO, MarketDTO } from "@rationale/config";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_TAGLINE, EXAMPLE_STRATEGY } from "@rationale/config";
import Link from "next/link";
import type { ReactNode } from "react";
import { Chart, splitIndexOf } from "../Chart";
import { PlanRows } from "../PlanRow";
import { barStyle } from "../../lib/css";
import { LiveDot, fundingText, regimeText } from "./marketUi";
import {
  actionLabel,
  actionTag,
  hourLabel,
  leadSentence,
  pct,
  regimeLabel,
  signed,
  upDown,
  withoutLeadingAction,
} from "../../lib/format";
import { BrandMark, BrandWordmark } from "../Brand";
import { Crystal3D } from "./Crystal3D";
import { TapeBody } from "./Tape";
import { ThinkTabs } from "./ThinkTabs";

/* ---------- shared bits ---------- */

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link className="logo" href={href} aria-label={BRAND_NAME}>
      <BrandMark />
      <BrandWordmark />
    </Link>
  );
}

function Weights({ d, big = false }: { d: DecisionDTO; big?: boolean }) {
  return (
    <div className={`weights${big ? " big" : ""}`}>
      {d.evidence.map((e) => (
        <div className="w" key={e.name}>
          {e.name}
          <s style={barStyle(e.score)} />
          {signed(e.score)}
        </div>
      ))}
    </div>
  );
}

const COMING_SOURCES = "Open interest, liquidations, large-wallet flows and headlines are being added.";

const REGIME_TEXT: Record<string, string> = {
  trending: "Price is moving one way",
  ranging: "No clear direction",
  stressed: "Unusually volatile",
};

/* ---------- nav ---------- */

/** `base` is "/" on pages other than the landing page, so section links lead back to it. */
export function Nav({ base = "" }: { base?: string }) {
  return (
    <header className="top">
      <div className="capsule">
        <Logo />
        <nav>
          <a href={`${base}#product`}>Product</a>
          <a href={`${base}#decision`}>Decisions</a>
          <a href={`${base}#does`}>Features</a>
          <a href={`${base}#safety`}>Safety</a>
          <a href={`${base}#plans`}>Pricing</a>
        </nav>
        <div className="top-cta">
          <Link className="btn ghost sm" href="/app">
            Log in
          </Link>
          <Link className="btn sm" href="/app/studio">
            Launch app
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ---------- hero ---------- */

function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

export function Hero({ latest, decisions, markets }: { latest: DecisionDTO | null; decisions: DecisionDTO[]; markets: MarketDTO[] }) {
  const eth = markets.find((m) => m.market === "ETH") ?? markets[0];
  return (
    <section className="hero3d">
      <div className="wrap h3">
        <div className="h3copy">
          {markets.length ? (
            <a className="news" href="#decision">
              <b>Live</b>
              Agents read {markets.map((m) => m.market).join(" and ")} every hour
            </a>
          ) : (
            <a className="news" href="#plans">
              <b>New</b>Paper trading is open
            </a>
          )}
          <h1>
            Agents that think.
            <br />
            <em>Money that stays yours.</em>
          </h1>
          <p className="lede">
            Describe a strategy in a sentence. Your agent reads the market every hour, weighs the evidence for and
            against, and writes down why it acted or waited.
          </p>
          <div className="cta">
            <Link className="btn lime xl" href="/app/studio">
              Build your agent <span aria-hidden="true">→</span>
            </Link>
            <a className="btn ghost xl" href="#decision">
              {latest ? "Read a live decision" : "Read a decision"}
            </a>
          </div>
          <ul className="trust">
            <li>Virtual money only</li>
            <li>Decides every hour</li>
            <li>Every decision explained</li>
          </ul>
        </div>
        <div className="h3stage">
          <Crystal3D />
          {latest ? (
            <a className="glass gc1" href="#decision">
              <span className="tag">Latest decision</span>
              <b>
                {latest.agentName} · {actionLabel(latest.action)}
              </b>
              <small>
                {latest.marketLabel} · {utcTime(latest.hour)} · confidence {latest.confidence}
              </small>
            </a>
          ) : null}
          {eth ? (
            <div className="glass gc2">
              <span className="tag">{eth.market} regime</span>
              <b>{regimeText(eth)}</b>
              <small>
                RSI {eth.rsi != null ? eth.rsi.toFixed(1) : "—"} · read {utcTime(eth.asOf)}
              </small>
            </div>
          ) : null}
        </div>
      </div>
      <Ticker decisions={decisions} markets={markets} />
    </section>
  );
}

function Ticker({ decisions, markets }: { decisions: DecisionDTO[]; markets: MarketDTO[] }) {
  type Item = { key: string; pill: ReactNode; who: string; text: string };
  const items: Item[] = [];
  for (const m of markets) {
    items.push({
      key: `m${m.market}`,
      pill: <i className="pill plain">{m.market}</i>,
      who: regimeText(m),
      text: `RSI ${m.rsi != null ? m.rsi.toFixed(1) : "—"}${m.funding8hPct != null ? `, funding ${fundingText(m.funding8hPct)} per 8 hours` : ""}`,
    });
  }
  for (const d of decisions.slice(0, 10)) {
    items.push({
      key: `d${d.id}`,
      pill: <i className={`pill ${actionTag(d.action)}`}>{actionLabel(d.action)}</i>,
      who: d.agentName,
      text: leadSentence(d.explanation, 80),
    });
  }
  if (items.length === 0) {
    return (
      <div className="ticker" aria-label="Latest decisions">
        <div className="track still">
          <span>No decisions yet. The first paper agents report on the hour.</span>
        </div>
      </div>
    );
  }
  const row = (copy: boolean) =>
    items.map((it) => (
      <span key={`${copy ? "c" : "o"}${it.key}`} aria-hidden={copy || undefined}>
        {it.pill}
        <b>{it.who}</b>
        {it.text}
      </span>
    ));
  return (
    <div className="ticker" aria-label="Latest decisions and market readings">
      <div className="track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

/* ---------- product preview ---------- */

export function Product({ example }: { example: ExampleDTO | null }) {
  const bt = example?.backtest ?? null;
  const r = bt?.status === "done" ? bt.result : undefined;
  const sentence = example?.sentence ?? EXAMPLE_STRATEGY.sentence;
  return (
    <section className="band" id="product">
      <div className="wrap">
        <div className="center">
          <p className="eyebrow">The product</p>
          <h2>Type a sentence. Get an agent.</h2>
          <p className="sub">
            No templates and no sliders. Say what you want, check how it was understood, and test it on prices it has
            never seen.
          </p>
        </div>
        <div className="browser" data-reveal>
          <div className="chrome">
            <i />
            <i />
            <i />
            <span>{BRAND_DOMAIN}/studio</span>
          </div>
          <div className="shot">
            <div className="shot-l">
              <div className="shot-label">Your strategy</div>
              <div className="shot-prompt">
                {sentence}
                <span className="caret" />
              </div>
              <div className="shot-label" style={{ marginTop: 22 }}>
                How the agent understood it
              </div>
              {example ? (
                <>
                  <PlanRows rows={example.rows} />
                  <div className="shot-pass">
                    {example.checks
                      .filter((c) => c.pass)
                      .map((c) => (
                        <span key={c.label}>{c.label}</span>
                      ))}
                  </div>
                </>
              ) : (
                <p className="shot-empty">The plan for this sentence appears here once the service is running.</p>
              )}
            </div>
            <div className="shot-r">
              <div className="shot-label">
                {r ? `Backtest, the last ${r.unseenDays} days it never saw` : "Backtest"}
              </div>
              {r && bt ? (
                <>
                  <div className={`edgebox${r.unseenReturnPct - r.holdingUnseenPct < 0 ? " behind" : ""}`}>
                    <b className="num">{signed(Math.round((r.unseenReturnPct - r.holdingUnseenPct) * 10) / 10)} pts</b>
                    <span>
                      {r.unseenReturnPct - r.holdingUnseenPct >= 0 ? "ahead of" : "behind"} simply holding{" "}
                      {bt.marketLabel.split(" / ")[0]} over the unseen days
                    </span>
                  </div>
                  <div className="shot-nums">
                    <div>
                      <small>Strategy</small>
                      <b className="num">{pct(r.unseenReturnPct)}</b>
                    </div>
                    <div>
                      <small>Holding</small>
                      <b className={`num ${upDown(r.holdingUnseenPct)}`}>{pct(r.holdingUnseenPct)}</b>
                    </div>
                    <div>
                      <small>Worst drop</small>
                      <b className="num">{pct(r.maxDrawdownPct)}</b>
                    </div>
                  </div>
                  <Chart
                    strategy={r.curve.map((p) => p.strategy)}
                    holding={r.curve.map((p) => p.holding)}
                    splitIndex={splitIndexOf(r.curve, r.split)}
                    label="Backtest of the example strategy against holding"
                  />
                  <p className="shot-src">
                    {bt.source}. {bt.label}. Holding and worst drop are for the unseen days.
                  </p>
                </>
              ) : (
                <p className="shot-empty">
                  The backtest of this sentence runs on real ETH prices and appears here once the engine has run it.
                </p>
              )}
              <Link className="btn blue" href="/app/studio" style={{ marginTop: 16, width: "100%" }}>
                Try it with your own sentence
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- one decision ---------- */

export function DecisionTape({ latest }: { latest: DecisionDTO | null }) {
  return (
    <section className="band paper" id="decision">
      <div className="wrap">
        <div className="guard">
          <div>
            <p className="eyebrow">{latest ? "Live decision" : "One decision"}</p>
            <h2>{latest ? "Read a live decision from start to finish." : "Read one decision from start to finish."}</h2>
            <p className="sub">
              This is what you see for every trade an agent makes or refuses. What it saw, how it weighed it, and what
              stopped it.
            </p>
          </div>
          {latest ? <Tape d={latest} /> : <TapeEmpty />}
        </div>
      </div>
    </section>
  );
}

function Tape({ d }: { d: DecisionDTO }) {
  const steps = [
    ...(d.strategy ? [{ k: "Strategy", v: <>{d.strategy}</> }] : []),
    {
      k: "Sense",
      v: (
        <>
          {d.evidence.map((e, i) => (
            <span key={e.name}>
              {i > 0 && ". "}
              {e.name} <mark>{e.value}</mark>
            </span>
          ))}
          {d.evidence.length > 0 && "."}
        </>
      ),
    },
    { k: "Regime", v: <>{regimeLabel(d.regime)}. {REGIME_TEXT[d.regime]}.</> },
    { k: "Weigh", v: <Weights d={d} /> },
    {
      k: "Guard",
      v: (
        <>
          {d.guard.map((g, i) => (
            <span key={g.check}>
              {i > 0 && " "}
              {g.pass ? (
                <>{g.detail}</>
              ) : (
                <mark>
                  Veto: {g.detail}
                </mark>
              )}
            </span>
          ))}
        </>
      ),
    },
  ];
  return (
    <div className="tape" aria-label="The latest agent decision" data-reveal>
      <div className="tape-head">
        <b>{d.agentName}</b>
        <span className="pill">{d.marketLabel}</span>
        <span className="pill plain">{d.house ? "House · Paper" : "Paper"}</span>
        <span className="when">
          <LiveDot /> {hourLabel(d.hour)}
        </span>
      </div>
      <TapeBody
        steps={steps}
        verdict={
          <>
            <b>{actionLabel(d.action)}.</b>
            <span>
              Confidence {d.confidence}%. {withoutLeadingAction(d.explanation)}
            </span>
          </>
        }
      />
    </div>
  );
}

function TapeEmpty() {
  return (
    <div className="tape" aria-label="Agent decision" data-reveal>
      <div className="tape-head">
        <b>No decisions yet</b>
        <span className="pill plain">Paper</span>
      </div>
      <div className="tape-body">
        <div className="tape-empty">
          <p>
            When a paper agent runs its first hour, its full decision appears here: what it saw, the regime, how it
            weighed the evidence and what the guard checked.
          </p>
          <Link className="btn blue" href="/app/studio">
            Build an agent
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ---------- five steps ---------- */

export function Thinks({ latest: d, markets }: { latest: DecisionDTO | null; markets: MarketDTO[] }) {
  const m = markets.find((x) => x.market === "ETH") ?? markets[0] ?? null;
  const tabs = [
    { title: "Sense", text: "Gathers market evidence." },
    { title: "Read the regime", text: "Decides what kind of market this is." },
    { title: "Weigh", text: "Scores evidence for and against the trade." },
    { title: "Guard", text: "A separate risk check can veto." },
    { title: "Explain and learn", text: "Writes the reason, then reviews itself." },
  ];
  const views: ReactNode[] = [
    <>
      <h3>
        {d ? `What ${d.agentName} looked at, ${hourLabel(d.hour)}` : m ? `What an agent sees on ${m.market} right now` : "What the agent looks at"}
      </h3>
      <div className="src">
        {d ? (
          d.evidence.map((e) => (
            <div key={e.name}>
              <small>{e.name}</small>
              <b>{e.value}</b>
            </div>
          ))
        ) : m ? (
          <>
            <div>
              <small>Price</small>
              <b>
                ${m.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}, {pct(m.change24Pct, 2)} in 24 h
              </b>
            </div>
            <div>
              <small>RSI (14 h)</small>
              <b>{m.rsi != null ? m.rsi.toFixed(1) : "—"}</b>
            </div>
            <div>
              <small>Funding</small>
              <b>{fundingText(m.funding8hPct)} per 8 h</b>
            </div>
            <div>
              <small>Typical daily move</small>
              <b>{m.dailyVolPct.toFixed(1)}%</b>
            </div>
          </>
        ) : (
          <>
            <div>
              <small>Price and volume</small>
              <b>Read every hour</b>
            </div>
            <div>
              <small>Funding</small>
              <b>Read every hour</b>
            </div>
          </>
        )}
      </div>
      <p className="note">{COMING_SOURCES}</p>
    </>,
    <>
      <h3>The same rule behaves differently in each market</h3>
      <div className="regime">
        {(["trending", "ranging", "stressed"] as const).map((r) => (
          <div key={r} className={(d?.regime ?? m?.regime) === r ? "pick" : undefined}>
            <b>{regimeLabel(r)}</b>
            <span>{REGIME_TEXT[r]}</span>
          </div>
        ))}
      </div>
      <p className="note">
        {d
          ? `At ${hourLabel(d.hour)} the agent classed ${d.marketLabel} as ${d.regime}, from its trend slope and volatility.`
          : m
            ? `${m.marketLabel} right now: ${regimeText(m).toLowerCase()}. ${m.reason}`
            : "Each hour the agent classes the market from its trend slope and volatility before it weighs anything."}
      </p>
    </>,
    <>
      <h3>Evidence for and against the trade</h3>
      {d ? <Weights d={d} big /> : null}
      <p className="note">
        {d
          ? `Confidence in the action taken (${actionLabel(d.action).toLowerCase()}): ${d.confidence}%.`
          : "Each piece of evidence is scored from −100 to +100 for the trade the plan asks for, then combined into a confidence from 0 to 100."}
      </p>
    </>,
    <>
      <h3>Checks before any order is sent</h3>
      <div className="gchk">
        {d
          ? d.guard.map((g) => (
              <div key={g.check}>
                <i className={g.pass ? "ok" : "bad"}>{g.pass ? "Pass" : "Veto"}</i>
                {g.detail}
              </div>
            ))
          : ["Fresh market data", "Position size against your cap", "Daily loss against your cap", "Market stress, if your rule stands aside"].map(
              (c) => (
                <div key={c}>
                  <i className="neutral">Check</i>
                  {c}
                </div>
              ),
            )}
      </div>
      <p className="note">Once live vaults open, the vault contract also enforces the price floor and daily limit.</p>
    </>,
    <>
      <h3>What you receive</h3>
      <div className="say">
        <b>{d ? `${actionLabel(d.action)}.` : "A written reason"}</b>
        {d ? withoutLeadingAction(d.explanation) : "Every hour the agent writes what it did and why, in plain language."}
      </div>
      <div className="say rev">
        <b>Weekly review</b>
        Weekly reviews of closed trades arrive with full reasoning. They propose changes to your plan and never apply
        them on their own.
      </div>
    </>,
  ];
  return (
    <section className="band" id="thinks">
      <div className="wrap">
        <p className="eyebrow">How it decides</p>
        <h2>Five steps between a price tick and a trade.</h2>
        <p className="sub">
          A rule bot checks one indicator and fires. {BRAND_NAME} runs the same five steps every time, and writes down
          what it found at each one.
        </p>
        <ThinkTabs tabs={tabs} views={views} />
      </div>
    </section>
  );
}

/* ---------- comparison, safety, pricing, faq ---------- */

export function Compare() {
  return (
    <section className="band">
      <div className="wrap">
        <p className="eyebrow">Versus rule bots</p>
        <h2>What changes when the agent can reason.</h2>
        <div className="cmp" data-reveal>
          <table>
            <thead>
              <tr>
                <th />
                <th>Rule bots</th>
                <th>{BRAND_NAME}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Inputs</td>
                <td>Hourly closing price</td>
                <td>Price, volume, funding, liquidations, wallet flows, news</td>
              </tr>
              <tr>
                <td>Setting it up</td>
                <td>Pick a template, move sliders</td>
                <td>Write a sentence, review how it was understood</td>
              </tr>
              <tr>
                <td>Market context</td>
                <td>Same rule in every market</td>
                <td>Reads the regime first and adapts or stands aside</td>
              </tr>
              <tr>
                <td>Event risk</td>
                <td>Unaware of earnings or macro prints</td>
                <td>Knows the calendar and can wait</td>
              </tr>
              <tr>
                <td>After a loss</td>
                <td>Repeats the rule</td>
                <td>Reviews closed trades weekly and proposes changes</td>
              </tr>
              <tr>
                <td>Proof</td>
                <td>Private log on a server</td>
                <td>Each decision hashed on-chain, results ranked against holding</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="cmpnote">
          Paper agents read price, volume and funding today. Open interest, liquidations, wallet flows and news are being added.
        </p>
      </div>
    </section>
  );
}

export function Safety() {
  return (
    <section className="band paper" id="safety">
      <div className="wrap">
        <div className="guard">
          <div>
            <p className="eyebrow">Safety</p>
            <h2>The agent trades. Only you withdraw.</h2>
            <p className="sub">
              Your funds sit in a vault contract that belongs to your wallet. The agent&apos;s key can swap inside it and
              nothing else. If that key were ever stolen, the contract still caps what a day of bad trades could cost
              you.
            </p>
            <p className="safenote">Live vaults are not open yet. Paper trading uses virtual money only.</p>
          </div>
          <div className="rules" data-reveal>
            <div>
              <span>Withdraw</span>
              <b>You, any time, even when paused</b>
            </div>
            <div>
              <span>Minimum price on every swap</span>
              <b>Set by Chainlink, not by the agent</b>
            </div>
            <div>
              <span>Daily trading limit</span>
              <b>You choose it</b>
            </div>
            <div>
              <span>Admin changes</span>
              <b>Multisig, 3-day public delay</b>
            </div>
            <div>
              <span>Decision record</span>
              <b>Hashed on-chain each hour</b>
            </div>
            <div>
              <span>Recovery wallet</span>
              <b>Optional, set by you</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Pricing() {
  return (
    <section className="band" id="plans">
      <div className="wrap">
        <div className="center">
          <p className="eyebrow">Pricing</p>
          <h2>Free while you learn.</h2>
          <p className="sub">Paper trading is free. Pricing for live trading will be announced before vaults open.</p>
        </div>
        <div className="plans two">
          <div className="plan">
            <h3>Paper</h3>
            <div className="price">$0</div>
            <p>Practice at live prices.</p>
            <ul>
              <li>3 agents, $10,000 virtual each</li>
              <li>Rule strategies and backtests</li>
              <li>Public leaderboard</li>
            </ul>
            <Link className="btn ghost" href="/app/studio">
              Start free
            </Link>
          </div>
          <div className="plan hot">
            <span className="tagp">Real money</span>
            <h3>Live</h3>
            <div className="price soon">Coming later</div>
            <p>Trade from your own on-chain vault.</p>
            <ul>
              <li>Reasoning agents with news and flow data</li>
              <li>Your own on-chain vault</li>
              <li>Copy trading and Telegram</li>
            </ul>
            <button className="btn blue" disabled>
              Not open yet
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section className="band paper">
      <div className="wrap faqwrap">
        <div>
          <p className="eyebrow">Questions</p>
          <h2>Questions people ask first.</h2>
        </div>
        <div className="faq" data-reveal>
          <details open>
            <summary>Can the agent take my money?</summary>
            <p>
              No. Paper agents use virtual money only. Once live vaults open, the vault contract only lets the agent swap
              between approved tokens inside the vault, and withdrawals need your wallet.
            </p>
          </details>
          <details>
            <summary>Will it make a profit?</summary>
            <p>
              Nobody can promise that. What you get is a loss limit the contract enforces, a backtest scored on unseen
              days, and a public record of every decision.
            </p>
          </details>
          <details>
            <summary>What does &quot;reasoning&quot; mean here?</summary>
            <p>
              The agent gathers several kinds of evidence, scores them for and against the trade, and writes down why it
              acted or waited. A rule bot checks one indicator.
            </p>
          </details>
          <details>
            <summary>What can it trade?</summary>
            <p>
              Paper trading covers ETH and BTC today. Live trading on Robinhood Chain, including tokenized US stocks
              against USDG, comes later.
            </p>
          </details>
          <details>
            <summary>What happens if {BRAND_NAME} goes offline?</summary>
            <p>
              Once live vaults open, your vault keeps working without us. You will be able to withdraw directly from the
              contract on the block explorer.
            </p>
          </details>
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="closing">
      <div className="wrap">
        <div className="closer" data-reveal>
          <h2>Give it a sentence. Read what it does with it.</h2>
          <p>Building and testing an agent takes about two minutes and no money.</p>
          <Link className="btn xl" href="/app/studio">
            Launch app
          </Link>
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="fcols">
          <div>
            <Logo />
            <p>{BRAND_TAGLINE}</p>
          </div>
          <div>
            <b>Product</b>
            <Link href="/app/studio">Agent Studio</Link>
            <Link href="/app/leaderboard">Leaderboard</Link>
            <a href="/#plans">Pricing</a>
          </div>
          <div>
            <b>Trust</b>
            <a href="/#safety">Vault safety</a>
            <a href="/#decision">Read a decision</a>
            <a href="/#thinks">How it decides</a>
          </div>
          <div>
            <b>App</b>
            <Link href="/app">Overview</Link>
            <Link href="/app/agents">My agents</Link>
            <Link href="/app/vault">Vault</Link>
          </div>
        </div>
        <div className="wordmark" aria-hidden="true">
          {BRAND_NAME}
        </div>
        <p className="legal">
          Paper trading uses virtual money. Trading crypto and tokenized stocks is risky and you can lose money. Past and
          backtested results do not predict future returns. Nothing here is investment advice.
        </p>
        <p className="legal-links">
          <Link href="/terms">Terms of service</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/risk">Risk disclosure</Link>
        </p>
      </div>
    </footer>
  );
}
