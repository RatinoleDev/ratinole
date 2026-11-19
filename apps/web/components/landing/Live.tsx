/**
 * Feature cards with small visuals. Everything shown comes from stored records
 * (decisions, the leaderboard, the example backtest) or is plain description.
 */
import type { DecisionDTO, ExampleDTO, LeaderboardRowDTO } from "@rationale/config";
import { LEADERBOARD } from "@rationale/config";
import Link from "next/link";
import { actionLabel, actionTag, pct } from "../../lib/format";

/* ---------- features with small visuals ---------- */

function MiniLeaderboard({ board }: { board: LeaderboardRowDTO[] }) {
  const rows = board.slice(0, 4);
  if (rows.length === 0) {
    return (
      <div className="mini lbmini">
        <span className="lbempty">No agents have reported yet</span>
        <small>Agents appear after their first hourly decision and are ranked after {LEADERBOARD.minDaysToRank} days.</small>
      </div>
    );
  }
  return (
    <div className="mini lbmini">
      {rows.map((r) => (
        <div key={r.agentId}>
          <span>
            {r.name}
            {r.house ? <em className="housetag">House</em> : null}
          </span>
          <span>{r.ranked ? r.market : "New"}</span>
          <b className="num">{pct(r.edgePct)}</b>
        </div>
      ))}
      <small>Edge over holding the same market since launch, paper agents.</small>
    </div>
  );
}

function MiniTimeline({ decisions }: { decisions: DecisionDTO[] }) {
  const SLOTS = 12;
  const recent = decisions.slice(0, SLOTS).reverse();
  const empty = SLOTS - recent.length;
  return (
    <div className="mini tline" aria-hidden="true">
      <div className="dots">
        {Array.from({ length: empty }, (_, k) => (
          <i key={`e${k}`} className="off" />
        ))}
        {recent.map((d) => (
          <i key={d.id} className={actionTag(d.action)} title={`${d.agentName}: ${actionLabel(d.action)}`} />
        ))}
      </div>
      <div className="tlegend">
        <span>
          <i className="plain" /> Hold
        </span>
        <span>
          <i className="gain" /> Buy
        </span>
        <span>
          <i className="loss" /> Sell
        </span>
      </div>
      <small>{recent.length ? `The latest ${recent.length} hourly decisions, newest on the right` : "The first decisions arrive on the hour"}</small>
    </div>
  );
}

export function Features({ board, example, decisions }: { board: LeaderboardRowDTO[]; example: ExampleDTO | null; decisions: DecisionDTO[] }) {
  const r = example?.backtest?.status === "done" ? example.backtest.result : undefined;
  const latest = decisions[0];
  const planLines = example?.rows.find((row) => row.label === "Buy when")?.lines.slice(0, 2) ?? [];
  const biggest = r ? Math.max(Math.abs(r.unseenReturnPct), Math.abs(r.holdingUnseenPct), 0.1) : 1;
  const width = (v: number) => `${Math.max(4, (Math.abs(v) / biggest) * 100)}%`;
  return (
    <section className="band paper" id="does">
      <div className="wrap">
        <p className="eyebrow">Available today</p>
        <h2>Everything here works today.</h2>
        <div className="feat">
          <article className="fwide" data-reveal>
            <div>
              <h3>Agents running in the open</h3>
              <p>
                Every paper agent is listed against simply holding its market, after simulated costs. Copying one into
                your own vault comes with live trading.
              </p>
              <Link className="btn sm blue" href="/app/leaderboard">
                Open the leaderboard
              </Link>
            </div>
            <MiniLeaderboard board={board} />
          </article>
          <article data-reveal>
            <div className="ico">Aa</div>
            <h3>Plain-English strategies</h3>
            <p>Write it the way you would tell a trader, then see exactly how it was read before anything runs.</p>
            <div className="mini sentence" aria-hidden="true">
              <div className="bubble">&ldquo;Buy ETH when RSI drops below 30 in an uptrend&rdquo;</div>
              {planLines.map((l) => (
                <div className="row" key={l}>
                  <i />
                  {l}
                </div>
              ))}
            </div>
          </article>
          <article data-reveal>
            <div className="ico">↗</div>
            <h3>Backtests on unseen days</h3>
            <p>Tuned on 60 days of history, then scored on 30 days it never saw, next to simply holding.</p>
            {r ? (
              <div className="mini vs">
                <div>
                  <span>Strategy</span>
                  <s style={{ width: width(r.unseenReturnPct) }} />
                  <b className="num">{pct(r.unseenReturnPct)}</b>
                </div>
                <div className="hold">
                  <span>Holding</span>
                  <s style={{ width: width(r.holdingUnseenPct) }} />
                  <b className="num">{pct(r.holdingUnseenPct)}</b>
                </div>
                <small>Example strategy, last 30 days, ETH</small>
              </div>
            ) : null}
          </article>
          <article data-reveal>
            <div className="ico">◷</div>
            <h3>A reason every hour</h3>
            <p>Every decision is stored with its evidence, its checks and a plain explanation you can read.</p>
            <MiniTimeline decisions={decisions} />
          </article>
          <article data-reveal>
            <div className="ico">⛨</div>
            <h3>A guard that can veto</h3>
            <p>Size and daily loss caps, stale data and market stress. A veto always wins, and it never blocks an exit.</p>
            <div className="mini checks" aria-hidden="true">
              {(latest ? latest.guard.slice(0, 3) : [{ check: "Fresh data", pass: true }, { check: "Position size", pass: true }, { check: "Daily loss", pass: true }]).map((g) => (
                <div key={g.check}>
                  <i className={latest ? (g.pass ? "ok" : "bad") : "neutral"}>{latest ? (g.pass ? "Pass" : "Veto") : "Check"}</i>
                  {g.check}
                </div>
              ))}
            </div>
          </article>
        </div>
        <div className="nextstrip" data-reveal>
          <b>Coming next</b>
          <span>Live vaults on Robinhood Chain</span>
          <span>Copy trading</span>
          <span>Portfolio agents</span>
          <span>Payroll</span>
          <span>Telegram</span>
        </div>
      </div>
    </section>
  );
}
