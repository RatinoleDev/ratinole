import type { DecisionDTO, ExampleDTO, LeaderboardRowDTO } from "@rationale/config";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_TAGLINE, EXAMPLE_STRATEGY } from "@rationale/config";
import Link from "next/link";
import type { ReactNode } from "react";
import { Chart, splitIndexOf } from "../Chart";
import { PlanRows } from "../PlanRow";
import { barStyle, cssVars } from "../../lib/css";
import {
  actionLabel,
  actionTag,
  hourLabel,
  leadSentence,
  pct,
  regimeLabel,
  signed,
  truncate,
  upDown,
  withoutLeadingAction,
} from "../../lib/format";
import { Stage } from "./Stage";
import { TapeBody } from "./Tape";
import { ThinkTabs } from "./ThinkTabs";

/* ---------- shared bits ---------- */

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link className="logo" href={href}>
      <i />
      {BRAND_NAME}
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

const NOT_COLLECTED = ["Funding", "Open interest", "Liquidations", "Wallet flow", "Headlines"];

const REGIME_TEXT: Record<string, string> = {
  trending: "Price is moving one way",
  ranging: "No clear direction",
  stressed: "Unusually volatile",
};

/* ---------- nav ---------- */

export function Nav() {
  return (
    <header className="top">
      <div className="capsule">
        <Logo />
        <nav>
          <a href="#product">Product</a>
          <a href="#decision">Decisions</a>
          <a href="#does">Features</a>
          <a href="#safety">Safety</a>
          <a href="#plans">Pricing</a>
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

function heroFloats(d: DecisionDTO | null): ReactNode[] {
  if (!d) {
    return [
      <>
        <span className="pill plain">Sense</span> Gathers the evidence
      </>,
      <>
        <span className="pill plain">Weigh</span> Scores for and against
      </>,
      <>
        <span className="pill plain">Explain</span> Writes down why
      </>,
      <>
        <span className="pill plain">Regime</span> Reads the market first
      </>,
      <>
        <span className="pill plain">Guard</span> Can veto any trade
      </>,
    ];
  }
  const e0 = d.evidence[0];
  const e1 = d.evidence[1];
  const g = d.guard.find((x) => !x.pass) ?? d.guard[0];
  return [
    <>
      <span className={`pill ${actionTag(d.action)}`}>{actionLabel(d.action)}</span>{" "}
      {e0 ? truncate(`${e0.name}: ${e0.value}`, 34) : d.agentName}
    </>,
    <>
      <b>{d.confidence}%</b> confident
      <s style={cssVars({ "--p": `${d.confidence}%` })} />
    </>,
    e1 ? (
      <>
        <span className={`pill ${e1.score >= 0 ? "gain" : "loss"}`}>{e1.score >= 0 ? "For" : "Against"}</span>{" "}
        {truncate(`${e1.name}: ${e1.value}`, 34)}
      </>
    ) : (
      <>
        <span className="pill plain">Market</span> {d.marketLabel}
      </>
    ),
    <>
      <span className="pill plain">Regime</span> {regimeLabel(d.regime)}
    </>,
    g ? (
      <>
        <span className={`pill ${g.pass ? "gain" : "loss"}`}>{g.pass ? "Pass" : "Veto"}</span> {truncate(g.check, 30)}
      </>
    ) : (
      <>
        <span className="pill plain">Guard</span> No checks
      </>
    ),
  ];
}

export function Hero({ latest, decisions }: { latest: DecisionDTO | null; decisions: DecisionDTO[] }) {
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-copy">
          <a className="news" href="#plans">
            <b>New</b>Paper trading is open
          </a>
          <h1>
            Agents that think.
            <br />
            Money that stays yours.
          </h1>
          <p className="lede">
            Describe a strategy in a sentence. Your agent reads the market every hour, weighs the evidence for and
            against, and writes down why it acted or waited. Practise with paper money now; vaults only you can
            withdraw from come with live trading.
          </p>
          <div className="cta">
            <Link className="btn blue xl" href="/app/studio">
              Build your agent
            </Link>
            <a className="btn ghost xl" href="#decision">
              Read a decision
            </a>
          </div>
        </div>
        <Stage floats={heroFloats(latest)} />
      </div>
      <Ticker decisions={decisions} />
    </section>
  );
}

function Ticker({ decisions }: { decisions: DecisionDTO[] }) {
  if (decisions.length === 0) {
    return (
      <div className="ticker" aria-label="Latest decisions">
        <div className="track still">
          <span>No decisions yet. The first paper agents report on the hour.</span>
        </div>
      </div>
    );
  }
  const items = decisions.slice(0, 12);
  const item = (d: DecisionDTO, copy: boolean) => (
    <span key={`${copy ? "c" : "o"}${d.id}`} aria-hidden={copy || undefined}>
      <i className={`pill ${actionTag(d.action)}`} style={{ fontStyle: "normal" }}>
        {actionLabel(d.action)}
      </i>
      <b>{d.agentName}</b>
      {leadSentence(d.explanation, 80)}
    </span>
  );
  return (
    <div className="ticker" aria-label="Latest decisions">
      <div className="track">
        {items.map((d) => item(d, false))}
        {items.map((d) => item(d, true))}
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
          <h2>Type a sentence. Get an agent.</h2>
          <p className="sub">
            No templates and no sliders. Say what you want, check how it was understood, and test it on prices it has
            never seen.
          </p>
        </div>
        <div className="browser">
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
                {r ? `Backtest, ${r.tunedDays + r.unseenDays} days` : "Backtest"}
              </div>
              {r && bt ? (
                <>
                  <div className="shot-nums">
                    <div>
                      <small>Unseen days</small>
                      <b className={`num ${upDown(r.unseenReturnPct)}`}>{pct(r.unseenReturnPct)}</b>
                    </div>
                    <div>
                      <small>Holding</small>
                      <b className="num">{pct(r.holdingUnseenPct)}</b>
                    </div>
                    <div>
                      <small>Worst drop</small>
                      <b className="down num">{pct(r.maxDrawdownPct)}</b>
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
            <h2>Read one decision from start to finish.</h2>
            <p className="sub">
              This is what you see for every trade your agent makes or refuses. What it saw, how it weighed it, and
              what stopped it.
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
    <div className="tape" aria-label="The latest agent decision">
      <div className="tape-head">
        <b>{d.agentName}</b>
        <span className="pill">{d.marketLabel}</span>
        <span className="pill plain">Paper</span>
        <span className="when">{hourLabel(d.hour)}</span>
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
    <div className="tape" aria-label="Agent decision">
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

export function Thinks({ latest: d }: { latest: DecisionDTO | null }) {
  const tabs = [
    { title: "Sense", text: "Gathers market evidence." },
    { title: "Read the regime", text: "Decides what kind of market this is." },
    { title: "Weigh", text: "Scores evidence for and against the trade." },
    { title: "Guard", text: "A separate risk check can veto." },
    { title: "Explain and learn", text: "Writes the reason, then reviews itself." },
  ];
  const views: ReactNode[] = [
    <>
      <h3>{d ? `What ${d.agentName} looked at, ${hourLabel(d.hour)}` : "What the agent looks at"}</h3>
      <div className="src">
        {d ? (
          d.evidence.map((e) => (
            <div key={e.name}>
              <small>{e.name}</small>
              <b>{e.value}</b>
            </div>
          ))
        ) : (
          <>
            <div>
              <small>Price</small>
              <b>Read every hour</b>
            </div>
            <div>
              <small>Volume</small>
              <b>Read every hour</b>
            </div>
          </>
        )}
        {NOT_COLLECTED.map((n) => (
          <div key={n} className="off">
            <small>{n}</small>
            <b>Not collected yet</b>
          </div>
        ))}
      </div>
    </>,
    <>
      <h3>The same rule behaves differently in each market</h3>
      <div className="regime">
        {(["trending", "ranging", "stressed"] as const).map((r) => (
          <div key={r} className={d?.regime === r ? "pick" : undefined}>
            <b>{regimeLabel(r)}</b>
            <span>{REGIME_TEXT[r]}</span>
          </div>
        ))}
      </div>
      <p className="note">
        {d
          ? `At ${hourLabel(d.hour)} the agent classed ${d.marketLabel} as ${d.regime}, from its trend slope and volatility.`
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

/* ---------- bento ---------- */

export function Bento({ board, example }: { board: LeaderboardRowDTO[]; example: ExampleDTO | null }) {
  const r = example?.backtest?.status === "done" ? example.backtest.result : undefined;
  return (
    <section className="band paper" id="does">
      <div className="wrap">
        <h2>One wallet, the whole desk.</h2>
        <div className="bento">
          <article className="b-wide">
            <div>
              <h3>Copy a proven agent</h3>
              <p>
                The leaderboard ranks agents by how much they beat holding, after costs. Copying one into your own vault
                with your own limits comes with live trading.
              </p>
            </div>
            <div className="mini lbmini">
              {board.length > 0 ? (
                <>
                  {board.slice(0, 3).map((row) => (
                    <div key={row.agentId}>
                      <span>{row.name}</span>
                      <span>{row.market}</span>
                      <b className="num">{pct(row.edgePct)}</b>
                    </div>
                  ))}
                  <small>Edge over holding, paper agents</small>
                </>
              ) : (
                <>
                  <span className="lbempty">No ranked agents yet</span>
                  <small>Paper agents appear here once they have made decisions.</small>
                </>
              )}
            </div>
          </article>
          <article>
            <h3>Backtests you can trust</h3>
            <p>Tuned on one stretch of history, scored on a later one it never saw.</p>
            <div className="mini two">
              <div>
                <small>Tuned</small>
                <b className="num">{r ? pct(r.tunedReturnPct) : "—"}</b>
              </div>
              <div className="hl">
                <small>Unseen</small>
                <b className="num">{r ? pct(r.unseenReturnPct) : "—"}</b>
              </div>
            </div>
          </article>
          <article>
            <h3>
              Portfolio agents<span className="tagsoon">Coming later</span>
            </h3>
            <p>Hold target weights across markets and rebalance on a schedule.</p>
            <div className="mini bars">
              <div style={cssVars({ "--w": "50%" })}>
                <span>ETH</span>
                <b>50%</b>
              </div>
              <div style={cssVars({ "--w": "30%" })}>
                <span>BTC</span>
                <b>30%</b>
              </div>
              <div style={cssVars({ "--w": "20%" })}>
                <span>SPY</span>
                <b>20%</b>
              </div>
              <small>Example split</small>
            </div>
          </article>
          <article>
            <h3>
              Payroll from profits<span className="tagsoon">Coming later</span>
            </h3>
            <p>Pay your team in USDG or stock tokens, on schedule.</p>
            <div className="mini run">
              <b className="word">Later</b>
              <span>Payroll arrives with live vaults</span>
            </div>
          </article>
          <article>
            <h3>
              Telegram control<span className="tagsoon">Coming later</span>
            </h3>
            <p>Every decision as a message. Pause or ask why from your phone.</p>
            <div className="mini chat">
              <div className="me">Why did you sell?</div>
              <div>Price closed back above the short average and reached your target.</div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------- comparison, safety, pricing, faq ---------- */

export function Compare() {
  return (
    <section className="band">
      <div className="wrap">
        <h2>What changes when the agent can reason.</h2>
        <div className="cmp">
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
          Paper agents read price and volume today. Funding, liquidations, wallet flows and news are being added.
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
            <h2>The agent trades. Only you withdraw.</h2>
            <p className="sub">
              Your funds sit in a vault contract that belongs to your wallet. The agent&apos;s key can swap inside it and
              nothing else. If that key were ever stolen, the contract still caps what a day of bad trades could cost
              you.
            </p>
            <p className="safenote">Live vaults are not open yet. Paper trading uses virtual money only.</p>
          </div>
          <div className="rules">
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
        <h2>Questions people ask first.</h2>
        <div className="faq">
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
        <div className="closer">
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
            <a href="#plans">Pricing</a>
          </div>
          <div>
            <b>Trust</b>
            <a href="#safety">Vault safety</a>
            <a href="#decision">Read a decision</a>
            <a href="#thinks">How it decides</a>
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
          backtested results do not predict future returns.
        </p>
      </div>
    </footer>
  );
}
