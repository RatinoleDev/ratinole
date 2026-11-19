"use client";

import { useState } from "react";

/** Assumptions behind the worst-case figure, shown in the formula text. */
const POOL_FEE_PCT = 0.3;
const ORACLE_LAG_PCT = 0.5;

export default function VaultPage() {
  const [limit, setLimit] = useState(500);
  const [slip, setSlip] = useState(1);
  const worst = (limit * (slip + POOL_FEE_PCT + ORACLE_LAG_PCT)) / 100;
  return (
    <section>
      <div className="grid2">
        <div className="panel">
          <h2>Limits the contract enforces</h2>
          <p className="hint">The agent cannot change these. Only your wallet can.</p>
          <div className="ctrl">
            <label>
              <span>
                Daily trading limit <b className="num">${limit.toLocaleString("en-US")}</b>
              </span>
              <input
                type="range"
                min={50}
                max={5000}
                step={50}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </label>
            <label>
              <span>
                Maximum slippage against the oracle <b className="num">{slip.toFixed(1)}%</b>
              </span>
              <input
                type="range"
                min={0.1}
                max={5}
                step={0.1}
                value={slip}
                onChange={(e) => setSlip(Number(e.target.value))}
              />
            </label>
            <div className="worst">
              <small>Most a stolen agent key could cost you per day</small>
              <b className="num">${worst.toFixed(2)}</b>
              <small>
                Daily limit × (slippage + {POOL_FEE_PCT}% pool fee + {ORACLE_LAG_PCT}% oracle lag). You stop it by pausing.
              </small>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn sm" disabled title="Vaults open with live trading">
                Pause vault
              </button>
              <button className="btn sm ghost" disabled title="Vaults open with live trading">
                Revoke agent access
              </button>
              <button className="btn sm ghost" disabled title="Vaults open with live trading">
                Withdraw
              </button>
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Who can do what</h2>
          <p className="hint">No vault yet. Vaults open with live trading.</p>
          <table className="perm">
            <caption className="hint" style={{ textAlign: "left", captionSide: "bottom", marginTop: 12 }}>
              How a vault will work once live trading opens.
            </caption>
            <thead>
              <tr>
                <th />
                <th>You</th>
                <th>Agent</th>
                <th>Anyone</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Withdraw", true, false, false],
                ["Swap inside the vault", false, true, false],
                ["Change limits", true, false, false],
                ["Pause or revoke", true, false, false],
                ["Move the vault to a new wallet", true, false, false],
              ].map(([label, you, agent, anyone]) => (
                <tr key={label as string}>
                  <td>{label}</td>
                  {[you, agent, anyone].map((v, i) => (
                    <td key={i} className={v ? "yes" : "no"}>
                      {v ? "Yes" : "No"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
