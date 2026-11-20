"use client";

import { LEADERBOARD, type LeaderboardRowDTO } from "@rationale/config";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "../../../lib/api";
import { RobotAvatar } from "../../../components/robot/RobotAvatar";
import { pct, upDown } from "../../../lib/format";

export default function LeaderboardPage() {
  const q = useQuery({
    queryKey: ["leaderboard"],
    queryFn: () => api<LeaderboardRowDTO[]>("/leaderboard"),
    refetchInterval: 60_000,
  });
  const rows = q.data ?? [];
  const ranked = rows.filter((r) => r.ranked);
  const pending = rows.filter((r) => !r.ranked);
  const row = (r: LeaderboardRowDTO, rank: number | null) => (
    <tr key={r.agentId} className={rank == null ? "unranked" : undefined}>
      <td>
        <span className="lbname">
          <RobotAvatar seed={r.agentId} size={40} tile house={r.house} />
          <b>{rank != null ? `${rank}. ` : ""}{r.name}</b>
          {r.house && <i className="housetag">House</i>}
        </span>
      </td>
      <td>{r.marketLabel}</td>
      <td className={`r num ${upDown(r.returnPct)}`}>{pct(r.returnPct)}</td>
      <td className="r num">{pct(r.holdingPct)}</td>
      <td className={`r num ${rank != null ? upDown(r.edgePct) : ""}`}>{pct(r.edgePct)}</td>
      <td className="r num down">{pct(r.maxDrawdownPct)}</td>
      <td className="r num">{r.daysLive}</td>
      <td className="r">
        <button className="btn sm ghost" disabled title="Copy trading arrives with live vaults">
          Copy
        </button>
      </td>
    </tr>
  );
  return (
    <section>
      <div className="panel">
        <h2>Agents ranked against holding</h2>
        <p className="hint">
          Paper agents. Ranked by how much they beat holding the same market since launch, after simulated costs. An agent is
          ranked once it has been live for {LEADERBOARD.minDaysToRank} days.
        </p>
        <div className="lbwrap">
          <table className="lb">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Market</th>
                <th className="r">Return</th>
                <th className="r">Holding</th>
                <th className="r">Edge</th>
                <th className="r">Worst drop</th>
                <th className="r">Days live</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => row(r, i + 1))}
              {pending.length > 0 && (
                <tr className="sep">
                  <td colSpan={8}>Not ranked yet: live for under {LEADERBOARD.minDaysToRank} days</td>
                </tr>
              )}
              {pending.map((r) => row(r, null))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="lbempty-p">
            <p className="empty">
              {q.isLoading
                ? "Loading…"
                : q.isError
                  ? "The leaderboard could not be loaded. Try again in a moment."
                  : "No paper agents have made decisions yet."}
            </p>
            {!q.isLoading && !q.isError && (
              <Link className="btn sm" href="/app/studio" style={{ marginTop: 12 }}>
                Launch one in Agent Studio
              </Link>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
