/**
 * Step 4, Guard (HANDOFF 5.2): a separate deterministic gate that can veto.
 * A veto always wins. Checks depend on the action: limits on new risk apply to
 * buys, so a veto can never block a stop-loss exit; stale data blocks both.
 *
 * Every row here is something this code really checked this hour. What the vault enforces on its own (the pool's
 * price against the oracle, its daily limit) is not listed: the guard does not check it, the vault does.
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
}

export function runGuard(g: GuardInput): GuardCheck[] {
  const checks: GuardCheck[] = [{ check: "Fresh data", pass: g.fresh.ok, detail: g.fresh.detail }];

  if (g.action === "buy") {
    // A statement about the plan, true in every hour, whether or not an order follows.
    const sizeOk = g.sizePctOfCash <= g.maxSizePct;
    checks.push({
      check: "Trade size",
      pass: sizeOk,
      detail: `The plan uses ${g.sizePctOfCash}% of cash per trade, ${sizeOk ? "within" : "over"} your ${g.maxSizePct}% cap.`,
    });

    const lossOk = g.dailyPnlPct > -g.dailyLossCapPct;
    // Shown to one decimal. A change that rounds to nothing is "flat", never "down 0.0%".
    const abs = Math.abs(g.dailyPnlPct);
    const shown = Math.round(abs * 10) / 10;
    // Right at the cap one decimal cannot tell the two sides apart ("down 3.0%, under your 3% cap"), so a second
    // is shown; closer than that, the words say which side it is on.
    const atCap = shown === g.dailyLossCapPct && abs !== g.dailyLossCapPct;
    const two = Number(abs.toFixed(2));
    const amount = !atCap ? `${shown.toFixed(1)}%` : two !== g.dailyLossCapPct ? `${abs.toFixed(2)}%` : lossOk ? `just under ${g.dailyLossCapPct}%` : `just over ${g.dailyLossCapPct}%`;
    checks.push({
      check: "Daily loss",
      pass: lossOk,
      detail: !lossOk
        ? `Down ${amount} today, ${abs > g.dailyLossCapPct ? "past" : "at"} your ${g.dailyLossCapPct}% cap. No new buys until the next UTC day.`
        : shown === 0
          ? `Flat today. Your cap is a ${g.dailyLossCapPct}% daily loss.`
          : g.dailyPnlPct < 0
            ? `Down ${amount} today, under your ${g.dailyLossCapPct}% cap.`
            : `Up ${amount} today. Your cap is a ${g.dailyLossCapPct}% daily loss.`,
    });

    if (g.standsAsideWhenStressed) {
      const calm = g.regime !== "stressed";
      checks.push({
        check: "Market stress",
        pass: calm,
        detail: calm ? `The market is ${g.regime}, not stressed.` : "The market is classed as stressed, and your plan stands aside.",
      });
    }
  }
  return checks;
}

export function vetoes(checks: GuardCheck[]): GuardCheck[] {
  return checks.filter((c) => !c.pass);
}
