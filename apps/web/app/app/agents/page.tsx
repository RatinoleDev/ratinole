"use client";

import type { AgentDTO, DecisionDTO } from "@rationale/config";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { PlanRows } from "../../../components/PlanRow";
import { useToast } from "../../../components/Toast";
import { DecisionRow } from "../../../components/app/DecisionFeed";
import { ConnectPanel, useSession } from "../../../components/app/Session";
import { Robot3D } from "../../../components/robot/Robot3D";
import { RobotAvatar } from "../../../components/robot/RobotAvatar";
import { api, del, patch } from "../../../lib/api";
import { dateLabel, pct, upDown } from "../../../lib/format";

function AgentLog({ agent }: { agent: AgentDTO }) {
  const q = useQuery({
    queryKey: ["decisions", agent.id],
    queryFn: () => api<DecisionDTO[]>(`/agents/${agent.id}/decisions?limit=50`),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <p className="empty" style={{ padding: "12px 0" }}>Loading decisions…</p>;
  if (q.isError) return <p className="empty" style={{ padding: "12px 0" }}>Decisions could not be loaded. Try again in a moment.</p>;
  const list = q.data ?? [];
  if (list.length === 0)
    return (
      <p className="empty" style={{ padding: "12px 0" }}>
        No decisions yet. {agent.status === "active" ? "The first one is written at the top of the next hour." : "This agent is paused."}
      </p>
    );
  return (
    <>
      {list.map((d) => (
        <DecisionRow key={d.id} d={d} />
      ))}
    </>
  );
}

function AgentCard({ agent, first }: { agent: AgentDTO; first: boolean }) {
  const [open, setOpen] = useState(first);
  const [busy, setBusy] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const status = agent.status === "paused" ? "Paused" : agent.inPosition ? "In position" : "Watching";

  async function toggle() {
    setBusy(true);
    try {
      const next = agent.status === "active" ? "paused" : "active";
      await patch<AgentDTO>(`/agents/${agent.id}`, { status: next });
      await qc.invalidateQueries({ queryKey: ["agents"] });
      toast(next === "paused" ? `${agent.name} paused` : `${agent.name} resumed`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not change the agent.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = window.confirm(
      `Delete ${agent.name}? It stops running and leaves your list and the leaderboard. Its past decisions stay on record. This cannot be undone.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await del(`/agents/${agent.id}`);
      await qc.invalidateQueries({ queryKey: ["agents"] });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast(`${agent.name} deleted`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not delete the agent.");
      setBusy(false);
    }
  }

  return (
    <details className="agent" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <div className="agid">
          <RobotAvatar
            seed={agent.id}
            size={56}
            tile
            house={agent.house}
            mood={agent.status === "paused" ? "sleep" : agent.inPosition ? "hold" : "watch"}
          />
          <div>
            <h3>{agent.name}</h3>
            <small>
              {agent.marketLabel}, Paper
            </small>
          </div>
        </div>
        <div>
          <small>Return</small>
          <span className={`val num ${upDown(agent.returnPct)}`}>{pct(agent.returnPct)}</span>
        </div>
        <div>
          <small>Holding</small>
          <span className="val num">{pct(agent.holdingPct)}</span>
        </div>
        <div>
          <small>Status</small>
          <span className={`val stat ${agent.status === "paused" ? "off" : agent.inPosition ? "in" : "on"}`}>{status}</span>
        </div>
        <span className="tog" />
      </summary>
      <div className="log feed">
        <div className="ctl">
          <p>
            Launched {dateLabel(agent.launchedAt)} with ${agent.startingCash.toLocaleString("en-US")} virtual.{" "}
            {agent.decisions} decision{agent.decisions === 1 ? "" : "s"} so far.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm ghost" onClick={() => setShowPlan((s) => !s)} aria-expanded={showPlan}>
              {showPlan ? "Hide plan" : "Show plan"}
            </button>
            <button className="btn sm" onClick={() => void toggle()} disabled={busy}>
              {agent.status === "active" ? "Pause" : "Resume"}
            </button>
            <button className="btn sm ghost" onClick={() => void remove()} disabled={busy}>
              Delete
            </button>
          </div>
        </div>
        {showPlan && (
          <div className="row">
            <p style={{ marginBottom: 10, fontStyle: "italic" }}>&ldquo;{agent.sentence}&rdquo;</p>
            <PlanRows rows={agent.rows} />
            {agent.paramsText.length > 0 && (
              <ul className="paramlist">
                {agent.paramsText.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {open && <AgentLog agent={agent} />}
      </div>
    </details>
  );
}

export default function AgentsPage() {
  const { me } = useSession();
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentDTO[]>("/agents"),
    enabled: !!me,
    refetchInterval: 60_000,
  });
  if (!me) return <ConnectPanel text="Sign in with your wallet to see your paper agents and every decision they make." />;
  if (q.isLoading) return <div className="panel"><p className="empty">Loading your agents…</p></div>;
  if (q.isError)
    return (
      <div className="panel">
        <p className="empty">Your agents could not be loaded. Try again in a moment.</p>
      </div>
    );
  const list = q.data ?? [];
  if (list.length === 0)
    return (
      <div className="panel connect withbot">
        <Robot3D mood="sleeping" greet={false} />
        <div>
          <h2>No agents yet</h2>
          <p>Write a strategy in a sentence, check how it was understood, backtest it, then launch it in paper mode.</p>
          <Link className="btn blue" href="/app/studio">
            Open Agent Studio
          </Link>
        </div>
      </div>
    );
  return (
    <section>
      {list.map((a, i) => (
        <AgentCard key={a.id} agent={a} first={i === 0} />
      ))}
    </section>
  );
}
