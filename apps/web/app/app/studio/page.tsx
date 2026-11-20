"use client";

import type { AgentDTO, BacktestDTO, IntakeResponse } from "@rationale/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Chart, splitIndexOf } from "../../../components/Chart";
import { PlanRows } from "../../../components/PlanRow";
import { useToast } from "../../../components/Toast";
import { useSession } from "../../../components/app/Session";
import { Robot3D } from "../../../components/robot/Robot3D";
import { RobotAvatar } from "../../../components/robot/RobotAvatar";
import { ApiFailure, api, post } from "../../../lib/api";
import { pct, upDown } from "../../../lib/format";
import type { RobotMood } from "../../../lib/robot3d";

const MAX_SENTENCE = 600;
const STEPS = ["Describe", "Check the reading", "Backtest", "Launch"];

const DEFAULT_SENTENCE =
  "Buy ETH when RSI drops below 30 in an uptrend, stay out when the market is stressed, take profit at 8% and stop at 4%, use 25% per trade";

const CHIPS = [
  {
    label: "Dip buyer on ETH",
    text: "Buy ETH on a 3% dip under its 20-hour average while the long trend is rising, take profit at 6%, stop at 4%, use 20% per trade",
  },
  {
    label: "RSI bounce on BTC",
    text: "Buy BTC when RSI crosses back above 30, sell when RSI goes above 70, stop at 5%, use 25% per trade",
  },
  { label: "Weekly ETH buyer", text: "Buy ETH with 10% of cash every week, stop at 15%" },
];

type IntakeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "signin" }
  | { kind: "done"; res: IntakeResponse; sentence: string };

export default function StudioPage() {
  const { me, signIn, signingIn, refresh } = useSession();
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE);
  const [intake, setIntake] = useState<IntakeState>({ kind: "idle" });
  const [backtestId, setBacktestId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const bt = useQuery({
    queryKey: ["backtest", backtestId],
    queryFn: () => api<BacktestDTO>(`/backtests/${backtestId}`),
    enabled: !!backtestId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "done" || s === "failed" ? false : 1500;
    },
  });

  async function understand(text: string) {
    const t = text.trim();
    setBacktestId(null);
    setBtError(null);
    if (!t) return;
    if (!me) {
      setIntake({ kind: "signin" });
      return;
    }
    setIntake({ kind: "loading" });
    try {
      const res = await post<IntakeResponse>("/intake", { sentence: t });
      setIntake({ kind: "done", res, sentence: t });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setIntake({ kind: "signin" });
        return;
      }
      const body = e instanceof ApiFailure ? (e.body as IntakeResponse | null) : null;
      if (body && body.ok === false) setIntake({ kind: "done", res: body, sentence: t });
      else
        setIntake({
          kind: "done",
          res: { ok: false, code: "llm_unavailable", message: e instanceof Error ? e.message : "Something went wrong." },
          sentence: t,
        });
    }
  }

  async function runBacktest() {
    if (intake.kind !== "done" || !intake.res.ok) return;
    setStarting(true);
    setBtError(null);
    try {
      const { id } = await post<{ id: string }>("/backtests", { sentence: intake.sentence, plan: intake.res.plan });
      setBacktestId(id);
    } catch (e) {
      setBtError(e instanceof Error ? e.message : "The backtest could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function launch() {
    if (!backtestId) return;
    setLaunching(true);
    try {
      const agent = await post<AgentDTO>("/agents", { backtestId });
      toast(`${agent.name} launched in paper mode`);
      refresh();
      await qc.invalidateQueries({ queryKey: ["agents"] });
      router.push("/app/agents");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Launch failed.");
    } finally {
      setLaunching(false);
    }
  }

  const res = intake.kind === "done" ? intake.res : null;
  const b = bt.data;
  const r = b?.status === "done" ? b.result : undefined;
  const running = !!backtestId && (!b || b.status === "queued" || b.status === "running");
  const failed = !!btError || b?.status === "failed";
  const step = r ? 3 : backtestId ? 2 : res?.ok ? 1 : 0;

  // The robot acts out what the page is doing. It never reacts to how a backtest scored.
  const [mood, say]: [RobotMood, string] =
    intake.kind === "loading"
      ? ["thinking", "Reading your strategy…"]
      : starting || running
        ? ["thinking", "Running it on real hourly prices…"]
        : failed
          ? ["confused", "The backtest did not finish. The reason is in the Backtest panel."]
          : r
            ? ["idle", "Backtest done. Judge it by the unseen number, not the tuned one."]
            : intake.kind === "signin"
              ? ["idle", "I need a signed-in wallet before I can read a strategy."]
              : res && !res.ok
                ? ["confused", "I could not use that sentence. The reason is below."]
                : res?.ok
                  ? ["happy", "Here is how I read it. Check each line, then run the backtest."]
                  : ["idle", "Tell me your strategy in one sentence. I show you how I read it before anything runs."];

  return (
    <section>
      <ol className="steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step ? "done" : i === step ? "on" : undefined} aria-current={i === step ? "step" : undefined}>
            <i aria-hidden="true">{i < step ? "✓" : i + 1}</i>
            {label}
          </li>
        ))}
      </ol>
      <div className="grid2">
        <div className="panel">
          <div className="botstage">
            <Robot3D mood={mood} />
            <p className="botsay" role="status">
              <small>Studio agent</small>
              {say}
            </p>
          </div>
          <h2>Describe your strategy</h2>
          <p className="hint">
            Write it the way you would explain it to a trader. Name a market, when to buy, when to sell and how much to
            risk.
          </p>
          <div className="tawrap">
            <textarea
              aria-label="Strategy description"
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
              maxLength={MAX_SENTENCE}
            />
            <span className="tacount num" aria-hidden="true">
              {sentence.length} / {MAX_SENTENCE}
            </span>
          </div>
          <div className="chips">
            {CHIPS.map((c) => (
              <button
                key={c.label}
                className="chip"
                onClick={() => {
                  setSentence(c.text);
                  void understand(c.text);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {/* The lime button is always the next step. */}
            <button className={`btn ${step === 0 ? "blue" : "ghost"}`} onClick={() => void understand(sentence)} disabled={intake.kind === "loading"}>
              {intake.kind === "loading" ? "Reading…" : "Understand"}
            </button>
            {res?.ok && !backtestId && (
              <button className="btn blue" onClick={() => void runBacktest()} disabled={starting}>
                {starting ? "Starting…" : "Looks right, run backtest"}
              </button>
            )}
            {r && (
              <button className="btn blue" onClick={() => void launch()} disabled={launching}>
                {launching ? "Launching…" : "Launch in paper mode"}
              </button>
            )}
          </div>

          {intake.kind === "signin" && (
            <div className="errbox connect">
              <p style={{ color: "var(--ink2)" }}>Connect a wallet first. Reading a strategy needs a signed-in wallet.</p>
              <button className="btn sm" onClick={() => void signIn().then((ok) => ok && void understand(sentence))} disabled={signingIn}>
                {signingIn ? "Check your wallet…" : "Connect wallet"}
              </button>
            </div>
          )}

          {res && !res.ok && (
            <div className="errbox">
              <h2>Could not use this sentence</h2>
              <p>{res.message}</p>
            </div>
          )}

          {res?.ok && (
            <div className="planbox">
              <h2>How the agent understood it</h2>
              <p className="hint">
                {res.reader === "rules" ? "Read by the built-in reader, which follows fixed rules. " : ""}
                Edit your sentence and run again if anything here is wrong.
              </p>
              <PlanRows rows={res.rows} />
              <div className="checks">
                {res.checks.map((c) => (
                  <div key={c.label}>
                    <i className={c.pass ? "up" : "down"}>{c.pass ? "Pass" : "Check"}</i>
                    {c.label}
                  </div>
                ))}
              </div>
              {res.notes.length > 0 && (
                <ul className="notes">
                  {res.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {res.notChecked.length > 0 && (
                <div className="warnbox">
                  <b>Not checked yet</b>
                  <ul>
                    {res.notChecked.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Backtest</h2>
          <p className="hint">
            {btError
              ? btError
              : !backtestId
                ? "Run a strategy to see how it would have done."
                : running
                  ? "Running on real hourly prices…"
                  : b?.status === "failed"
                    ? `The backtest failed: ${b.error ?? "unknown error"}`
                    : r
                      ? `${r.tunedDays + r.unseenDays} days of real hourly prices.`
                      : ""}
          </p>
          {!r && !failed && (
            <div className={`btempty${running || starting ? " run" : ""}`}>
              <RobotAvatar seed="backtest" size={64} mood={running || starting ? "watch" : "sleep"} house />
              <Chart strategy={[]} holding={[]} label={running || starting ? "Backtest running" : "No backtest yet"} />
              {(running || starting) && <span className="btbar" aria-hidden="true" />}
            </div>
          )}
          {r && b && (
            <div>
              <div className="bt">
                <div>
                  <small>Tuned on, {r.tunedDays} days</small>
                  <b className={`num ${upDown(r.tunedReturnPct)}`}>{pct(r.tunedReturnPct)}</b>
                </div>
                <div>
                  <small>Unseen, {r.unseenDays} days</small>
                  <b className={`num ${upDown(r.unseenReturnPct)}`}>{pct(r.unseenReturnPct)}</b>
                </div>
                <div>
                  <small>Holding, unseen</small>
                  <b className="num">{pct(r.holdingUnseenPct)}</b>
                </div>
                <div>
                  <small>Worst drop</small>
                  <b className="num down">{pct(r.maxDrawdownPct)}</b>
                </div>
              </div>
              <Chart
                strategy={r.curve.map((p) => p.strategy)}
                holding={r.curve.map((p) => p.holding)}
                splitIndex={splitIndexOf(r.curve, r.split)}
                label="Backtest against holding, unseen days shaded"
              />
              <div className="legend">
                <span>
                  <i style={{ background: "var(--blue)" }} />
                  Strategy
                </span>
                <span>
                  <i style={{ background: "var(--ink3)" }} />
                  Holding
                </span>
                <span>
                  <i style={{ background: "var(--mark)", height: 10 }} />
                  Unseen days
                </span>
              </div>
              {r.warnings.length > 0 && (
                <div className="warnbox" role="note">
                  <b>Read these numbers with care</b>
                  <ul>
                    {r.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {r.paramsText.length > 0 && (
                <ul className="paramlist">
                  {r.paramsText.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
              <p className="btsrc">
                {b.label}. {b.source}, {r.candles.toLocaleString("en-US")} hourly candles, {r.costPct}% cost per trade.
                Trades: {r.tunedTrades} tuned, {r.unseenTrades} unseen.
              </p>
              <p className="hint" style={{ margin: "14px 0 0" }}>
                Judge it by the unseen number. A strategy that only wins on the days it was tuned on is curve-fitted.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
