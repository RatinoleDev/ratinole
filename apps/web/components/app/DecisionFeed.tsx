"use client";

import type { DecisionDTO } from "@rationale/config";
import { useState } from "react";
import { actionLabel, actionTag, hourLabel, signed, usd } from "../../lib/format";
import { RobotAvatar } from "../robot/RobotAvatar";

/** One decision as a feed row: action, hour, explanation, and its evidence and checks on demand. */
export function DecisionRow({ d, showAgent = false }: { d: DecisionDTO; showAgent?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="row">
      <div className="meta">
        {showAgent && (
          <>
            <RobotAvatar seed={d.agentId} size={24} house={d.house} />
            <b>{d.agentName}</b>
          </>
        )}
        <span className={`pill ${actionTag(d.action)}`}>{actionLabel(d.action)}</span>
        <span>{hourLabel(d.hour)}</span>
        <span>Confidence {d.confidence}%</span>
        {d.late && (
          <span className="pill plain" title="Run after the hour by the catch-up job">
            Late
          </span>
        )}
      </div>
      {d.explanation}
      {d.fill && (
        <div className="meta" style={{ marginTop: 4, marginBottom: 0 }}>
          <span>
            {d.fill.side === "buy" ? "Bought" : "Sold"} {d.fill.qty.toFixed(6)} at {usd(d.fill.price, 2)}, {usd(d.fill.notional, 2)}{" "}
            with {usd(d.fill.fee, 2)} cost
          </span>
        </div>
      )}
      <div>
        <button className="evbtn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide evidence and checks" : "Evidence and checks"}
        </button>
      </div>
      {open && <EvidenceDetail d={d} />}
    </div>
  );
}

export function EvidenceDetail({ d }: { d: DecisionDTO }) {
  return (
    <div className="evd">
      <h4>Evidence ({d.regime} market)</h4>
      <table>
        <tbody>
          {d.evidence.map((e) => (
            <tr key={e.name}>
              <td>{e.name}</td>
              <td>{e.value}</td>
              <td className={`r num ${e.score > 0 ? "up" : e.score < 0 ? "down" : ""}`}>{signed(e.score)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Guard</h4>
      <div className="gchk">
        {d.guard.map((g) => (
          <div key={g.check}>
            <i className={g.pass ? "ok" : "bad"}>{g.pass ? "Pass" : "Veto"}</i>
            <span>
              <b>{g.check}.</b> {g.detail}
            </span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Prices from {d.candleSource}. Equity after this hour {usd(d.equityAfter, 2)}; holding {usd(d.holdingEquityAfter, 2)}.
      </p>
    </div>
  );
}
