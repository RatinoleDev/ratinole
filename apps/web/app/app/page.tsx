"use client";

import type { OverviewDTO } from "@rationale/config";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Chart } from "../../components/Chart";
import { DecisionRow } from "../../components/app/DecisionFeed";
import { ConnectPanel, useSession } from "../../components/app/Session";
import { api } from "../../lib/api";
import { pct, upDown, usd } from "../../lib/format";

export default function OverviewPage() {
  const { me } = useSession();
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<OverviewDTO>("/overview"),
    enabled: !!me,
    refetchInterval: 60_000,
  });
  const o = q.data;
  const k = o?.kpis ?? null;
  return (
    <section>
      <div className="kpis">
        <div className="kpi">
          <small>Portfolio value</small>
          <b className="num">{k ? usd(k.equity) : "–"}</b>
        </div>
        <div className="kpi">
          <small>Return since start</small>
          <b className={`num ${upDown(k?.returnPct)}`}>{k ? pct(k.returnPct) : "–"}</b>
        </div>
        <div className="kpi">
          <small>Holding would have made</small>
          <b className="num">{k ? pct(k.holdingPct) : "–"}</b>
        </div>
        <div className="kpi">
          <small>Worst drop so far</small>
          <b className={`num ${k ? "down" : ""}`}>{k ? pct(k.maxDrawdownPct) : "–"}</b>
        </div>
      </div>
      {!me ? (
        <ConnectPanel text="Sign in with your wallet to see your paper agents, their results against holding, and every decision they make." />
      ) : (
        <div className="grid2">
          <div className="panel">
            <h2>Your agents against simply holding</h2>
            <p className="hint">Last 30 days, all agents combined. 100 = starting cash.</p>
            {q.isError ? (
              <p className="empty">The service is not available right now. Try again in a moment.</p>
            ) : o && o.series.length > 1 ? (
              <>
                <Chart
                  strategy={o.series.map((p) => p.strategy)}
                  holding={o.series.map((p) => p.holding)}
                  label="Combined agent equity against holding"
                />
                <div className="legend">
                  <span>
                    <i style={{ background: "var(--blue)" }} />
                    Agents
                  </span>
                  <span>
                    <i style={{ background: "var(--ink3)" }} />
                    Holding
                  </span>
                </div>
              </>
            ) : (
              <div className="connect">
                <p className="empty">
                  {o && o.agentCount > 0
                    ? "Your agents have not made their first hourly decision yet. The chart fills in as they run."
                    : "Launch your first agent in Agent Studio. Its results against holding appear here."}
                </p>
                {!(o && o.agentCount > 0) && (
                  <Link className="btn blue" href="/app/studio">
                    Open Agent Studio
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="panel">
            <h2>Latest decisions</h2>
            <p className="hint">Newest first.</p>
            <div className="feed">
              {o && o.latest.length > 0 ? (
                o.latest.map((d) => <DecisionRow key={d.id} d={d} showAgent />)
              ) : (
                <p className="empty">{q.isLoading ? "Loading…" : "No decisions yet. Agents decide once an hour."}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
