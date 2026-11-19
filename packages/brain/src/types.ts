/**
 * Core types from HANDOFF section 5. Plan and Decision follow the handoff as
 * written; the only addition is Plan.cadenceHours (see below).
 */

export type Op = "<" | ">" | "crosses_above" | "crosses_below";

export type Condition = {
  signal: string;
  op: Op;
  value: number;
  /** Lookback in hours. When absent, the backtest tuner picks it. */
  window?: number;
};

export type Filter = "negative_news" | "earnings_week" | "stressed_regime" | "macro_print";

export type PlanKind = "entry_exit" | "rebalance" | "dca" | "grid";

export type Plan = {
  markets: string[];
  kind: PlanKind;
  /** All must hold. */
  entry: Condition[];
  exit: {
    takeProfitPct?: number;
    stopLossPct?: number;
    trailingStopPct?: number;
    /** Any one holding triggers a sell. */
    conditions?: Condition[];
  };
  /** Reasons to stand aside. */
  filters: Filter[];
  /** 1 to 100. */
  sizePctOfCash: number;
  /** For rebalance. */
  weights?: Record<string, number>;
  /**
   * Addition to the handoff's type: how often a "dca" or "rebalance" plan acts,
   * in hours (168 = weekly). The handoff's Plan has no field for this.
   */
  cadenceHours?: number;
};

export type Regime = "trending" | "ranging" | "stressed";
export type Action = "buy" | "sell" | "hold";

export type EvidenceItem = { name: string; value: string; score: number };
export type GuardCheck = { check: string; pass: boolean; detail: string };

export type Decision = {
  agentId: string;
  /** ISO time of the hour this decision belongs to. */
  at: string;
  action: Action;
  /** 0 to 100: confidence in the action taken. */
  confidence: number;
  regime: Regime;
  evidence: EvidenceItem[];
  guard: GuardCheck[];
  /** What the user reads. */
  explanation: string;
  /** Live trades only. */
  txHash?: string;
};

/** One hourly candle. `t` is the open time in ms since epoch (UTC). */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export const HOUR_MS = 3_600_000;
