"use client";

import { RISK_LIMITS, type MeDTO } from "@rationale/config";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import { ConnectPanel, useSession } from "../../../components/app/Session";
import { ApiFailure, patch } from "../../../lib/api";

export default function SettingsPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [size, setSize] = useState("");
  const [loss, setLoss] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (me) {
      setSize(String(me.maxSizePct));
      setLoss(String(me.dailyLossCapPct));
    }
  }, [me]);

  if (!me) return <ConnectPanel text="Sign in with your wallet to set your own risk limits." />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await patch<MeDTO>("/me", { maxSizePct: Number(size), dailyLossCapPct: Number(loss) });
      qc.setQueryData(["me"], updated);
      toast("Limits saved");
    } catch (err) {
      toast(err instanceof ApiFailure ? err.message : "Could not save your limits.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel">
      <h2>Your risk limits</h2>
      <p className="hint">
        These apply to new strategies, backtests and agents. Agents already running keep the limits they launched with, so
        their record stays comparable.
      </p>
      <form className="settings" onSubmit={(e) => void save(e)}>
        <label>
          Largest share of cash per trade (%)
          <small>
            A strategy that asks for more is refused. Allowed: {RISK_LIMITS.maxSizePct.min} to {RISK_LIMITS.maxSizePct.max}.
          </small>
          <input
            type="number"
            min={RISK_LIMITS.maxSizePct.min}
            max={RISK_LIMITS.maxSizePct.max}
            step="1"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            required
          />
        </label>
        <label>
          Daily loss cap (%)
          <small>
            Once an agent is down this much in a UTC day, it makes no new buys until the next day. Allowed:{" "}
            {RISK_LIMITS.dailyLossCapPct.min} to {RISK_LIMITS.dailyLossCapPct.max}.
          </small>
          <input
            type="number"
            min={RISK_LIMITS.dailyLossCapPct.min}
            max={RISK_LIMITS.dailyLossCapPct.max}
            step="0.5"
            value={loss}
            onChange={(e) => setLoss(e.target.value)}
            required
          />
        </label>
        <div className="row2">
          <button className="btn" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save limits"}
          </button>
        </div>
      </form>
    </div>
  );
}
