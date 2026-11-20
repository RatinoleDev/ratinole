/**
 * Shapes the API returns and the web app reads. Every number in these shapes is
 * read from a stored record (Decision, Backtest, Agent) or computed from them.
 * All times are ISO 8601 strings in UTC.
 */
import type { Decision, Plan } from "@rationale/brain";

export interface PlanRowDTO {
  label: string;
  lines: string[];
  /** "missing" rows are shown in the loss colour (the prototype's "Not found" rows). */
  tone?: "missing";
}
export interface PlanCheckDTO {
  pass: boolean;
  label: string;
}

export interface MeDTO {
  address: string;
  maxSizePct: number;
  dailyLossCapPct: number;
  agentCount: number;
  maxAgents: number;
}

export type IntakeErrorCode =
  | "rephrase"
  | "unsupported_market"
  | "unsupported_signal"
  | "unsupported_kind"
  | "size_over_cap"
  | "llm_unavailable"
  | "budget_exhausted"
  | "rate_limited";

export type IntakeResponse =
  | {
      ok: true;
      plan: Plan;
      rows: PlanRowDTO[];
      checks: PlanCheckDTO[];
      /** Things changed or assumed while reading the sentence, e.g. "A 5% stop loss was added." */
      notes: string[];
      /** Parts of the plan that cannot be checked yet, e.g. the news filter. */
      notChecked: string[];
      /** What read the sentence: the language model, or the built-in reader with fixed rules. */
      reader: "model" | "rules";
    }
  | { ok: false; code: IntakeErrorCode; message: string };

export type BacktestStatus = "queued" | "running" | "done" | "failed";

export interface CurvePointDTO {
  t: string;
  /** Strategy equity, 100 = starting cash. */
  strategy: number;
  /** Buy-and-hold equity, 100 = starting cash. */
  holding: number;
}

export interface BacktestDTO {
  id: string;
  status: BacktestStatus;
  error?: string;
  sentence: string;
  plan: Plan;
  market: string;
  marketLabel: string;
  /** e.g. "Binance ETHUSDT hourly" */
  source: string;
  /** What the backtest could use, e.g. "Price and funding signals". */
  label: string;
  createdAt: string;
  result?: {
    from: string;
    split: string;
    to: string;
    candles: number;
    costPct: number;
    tunedDays: number;
    unseenDays: number;
    tunedReturnPct: number;
    unseenReturnPct: number;
    holdingTunedPct: number;
    holdingUnseenPct: number;
    /** Worst peak-to-trough drop on the unseen days, as a negative percent. */
    maxDrawdownPct: number;
    tunedTrades: number;
    unseenTrades: number;
    /** Plain-language lines describing what the tuner chose. */
    paramsText: string[];
    /** Reasons to be careful with these numbers, e.g. too few trades. */
    warnings: string[];
    curve: CurvePointDTO[];
  };
}

export interface FillDTO {
  side: "buy" | "sell";
  price: number;
  qty: number;
  notional: number;
  fee: number;
}

export interface DecisionDTO extends Decision {
  id: string;
  /** The hour boundary this decision belongs to. */
  hour: string;
  /** True when the engine ran this hour after the fact (catch-up). */
  late: boolean;
  fill: FillDTO | null;
  equityAfter: number;
  holdingEquityAfter: number;
  markPrice: number;
  candleSource: string;
  agentName: string;
  /** Run by the Ratinole team (labelled "House"). */
  house: boolean;
  /** The agent's strategy sentence. */
  strategy: string;
  market: string;
  marketLabel: string;
}

export interface AgentDTO {
  id: string;
  name: string;
  market: string;
  marketLabel: string;
  mode: "paper";
  house: boolean;
  /** "archived" agents were deleted by their owner; their decisions are kept. */
  status: "active" | "paused" | "archived";
  sentence: string;
  plan: Plan;
  rows: PlanRowDTO[];
  paramsText: string[];
  backtestId: string | null;
  launchedAt: string;
  startingCash: number;
  /** null until the first decision is stored. */
  equity: number | null;
  returnPct: number | null;
  holdingPct: number | null;
  inPosition: boolean;
  decisions: number;
  lastDecisionAt: string | null;
}

export interface OverviewDTO {
  agentCount: number;
  /** null when the wallet has no agent with a stored decision yet. */
  kpis: {
    equity: number;
    returnPct: number;
    holdingPct: number;
    maxDrawdownPct: number;
  } | null;
  /** Combined equity of all agents vs holding, last 30 days, 100 = start. */
  series: CurvePointDTO[];
  latest: DecisionDTO[];
}

export interface LeaderboardRowDTO {
  agentId: string;
  name: string;
  market: string;
  marketLabel: string;
  mode: "paper";
  house: boolean;
  returnPct: number;
  holdingPct: number;
  edgePct: number;
  maxDrawdownPct: number;
  daysLive: number;
  decisions: number;
  /** False until the agent has been live long enough to be ranked. */
  ranked: boolean;
}

/** The engine's latest stored reading of a market. */
export interface MarketDTO {
  market: string;
  marketLabel: string;
  price: number;
  change24Pct: number;
  regime: "trending" | "ranging" | "stressed";
  direction: "up" | "down" | "flat";
  reason: string;
  rsi: number | null;
  /** Percent per 8 hours, 8-hour average. */
  funding8hPct: number | null;
  dailyVolPct: number;
  /** Hourly closes for the last 7 days, oldest first. */
  closes7d: number[];
  /** The hour this reading belongs to. */
  asOf: string;
  candleSource: string;
  fundingSource: string | null;
}

/** A live price tick (display only; agents decide on closed hourly candles). */
export interface LiveTickDTO {
  market: string;
  price: number;
  open24h: number;
  change24Pct: number;
  high24h: number;
  low24h: number;
  /** Exchange event time, ms since epoch. */
  t: number;
  source: "binance";
}

export interface ExampleDTO {
  sentence: string;
  rows: PlanRowDTO[];
  checks: PlanCheckDTO[];
  backtest: BacktestDTO | null;
}

export interface HealthDTO {
  ok: boolean;
  engine: { lastHeartbeat: string | null; lastTick: string | null };
  activeAgents: number;
  /** Agent-hours with no stored decision, older than the grace period. */
  missedHours: number;
  /** Decisions made after the fact by catch-up. */
  lateDecisions: number;
}

export interface ApiError {
  error: string;
  message: string;
}
