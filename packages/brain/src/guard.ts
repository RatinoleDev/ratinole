/**
 * Step 4, Guard (HANDOFF 5.2): a separate deterministic gate that can veto.
 * A veto always wins. Checks depend on the action: limits on new risk apply to
 * buys, so a veto can never block a stop-loss exit; stale data blocks both.
 */
import type { GuardCheck, Regime } from "./types";

export interface GuardInput {
  action: "buy" | "sell";
  fresh: { ok: boolean; detail: string };
  sizePctOfCash: number;
  maxSizePct: number;
  /** Equity change since the start of the UTC day, percent. */
  dailyPnlPct: number;
  dailyLossCapPct: number;
  regime: Regime;
  standsAsideWhenStressed: boolean;
  costPct: number;
  /** Real money: the order goes through a pool, and the vault checks its price. */
  live?: boolean;
}

const p1 = (v: number) => Math.abs(v).toFixed(1);

export function runGuard(g: GuardInput): GuardCheck[] {
  const checks: GuardCheck[] = [{ check: "Fresh data", pass: g.fresh.ok, detail: g.fresh.detail }];

  if (g.action === "buy") {
    const sizeOk = g.sizePctOfCash <= g.maxSizePct;
    checks.push({
      check: "Position size",
      pass: sizeOk,
      detail: sizeOk
        ? `Uses ${g.sizePctOfCash}% of cash, within your ${g.maxSizePct}% cap.`
        : `Would use ${g.sizePctOfCash}% of cash, over your ${g.maxSizePct}% cap.`,
    });

    const lossOk = g.dailyPnlPct > -g.dailyLossCapPct;
    checks.push({
      check: "Daily loss",
      pass: lossOk,
      detail: !lossOk
        ? `Down ${p1(g.dailyPnlPct)}% today, past your ${g.dailyLossCapPct}% cap. No new buys until the next UTC day.`
        : g.dailyPnlPct < 0
          ? `Down ${p1(g.dailyPnlPct)}% today, under your ${g.dailyLossCapPct}% cap.`
          : `${g.dailyPnlPct > 0 ? `Up ${p1(g.dailyPnlPct)}%` : "Flat"} today. Your cap is a ${g.dailyLossCapPct}% daily loss.`,
    });

    if (g.standsAsideWhenStressed) {
      const calm = g.regime !== "stressed";
      checks.push({
        check: "Market stress",
        pass: calm,
        detail: calm ? `Market is ${g.regime}, not stressed.` : "Market is classed as stressed, and your plan stands aside.",
      });
    }
  }

  checks.push({
    check: "Pool depth",
    pass: true,
    detail: g.live
      ? "Live: the order goes through the vault's pool, and the vault refuses a price outside its slippage limit of the Chainlink price."
      : `Paper mode: filled at the next hour's opening price with a ${g.costPct}% cost.`,
  });
  return checks;
}

export function vetoes(checks: GuardCheck[]): GuardCheck[] {
  return checks.filter((c) => !c.pass);
}
