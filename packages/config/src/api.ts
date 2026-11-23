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
  /** "live" decisions moved real money in the owner's vault. */
  mode: AgentMode;
  /** Live only: why this hour's order did not go through. */
  execError?: string;
  /** Live only: dollars the owner moved into (+) or out of (-) the vault since the previous decision. */
  flowUsd?: number;
  /** Run by the Ratinole team (labelled "House"). */
  house: boolean;
  /** The agent's strategy sentence. */
  strategy: string;
  market: string;
  marketLabel: string;
}

export type AgentMode = "paper" | "live";

export interface AgentDTO {
  id: string;
  name: string;
  market: string;
  marketLabel: string;
  mode: AgentMode;
  /** Live only: the owner's vault on Robinhood Chain. */
  vault: string | null;
  /** Set when the engine stopped a live agent itself, in plain words. */
  pausedReason: string | null;
  house: boolean;
  /** "archived" agents were deleted by their owner; their decisions are kept. */
  status: "active" | "paused" | "archived";
  sentence: string;
  plan: Plan;
  rows: PlanRowDTO[];
  paramsText: string[];
  backtestId: string | null;
  launchedAt: string;
  /** Paper: virtual cash at launch. Live: the base results are measured against; it moves with deposits and withdrawals. */
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
  /**
   * Active agents whose decision for the latest hour could not be made on fresh market data. While that lasts no
   * stop or target is acted on, so it counts as a problem.
   */
  staleAgents: number;
  /** Present while live trading is configured on this server. */
  live?: {
    /** Live orders that did not go through in the last three hours (a refusal by a vault's own settings counts too). */
    failedOrders: number;
    /** ETH the agent's key holds for network fees; null when the chain could not be asked. */
    operatorEth: number | null;
    /** That is under the level at which trades may stop going through. Counts as a problem. */
    operatorLow: boolean;
  };
}

export interface ApiError {
  error: string;
  message: string;
}

/**
 * What the web app needs to know about live trading. `live` is false until the contracts are deployed and set.
 * `trading` can be false while `live` is true: the owner has paused live trading, so no live agent can start or
 * trade, but everyone can still see their vault and withdraw.
 */
export interface ChainConfigDTO {
  live: boolean;
  trading: boolean;
  chainId: number;
  explorerUrl: string;
  /** The vault factory; null while live trading is off. */
  factory: string | null;
  /** The agent's address: a vault must name it as operator for a live agent to trade it. */
  operator: string | null;
  stable: { symbol: string; address: string; decimals: number };
  tokens: { market: string; symbol: string; address: string; decimals: number }[];
  limits: {
    minVaultUsd: number;
    /** The most a vault may hold when a live agent is launched, while the contracts are unaudited. Null = no cap. */
    maxVaultUsd: number | null;
    defaultSlippageBps: number;
    defaultDailyLimitUsd: number;
  };
  /** Meme vaults (launchpad tokens against ETH); absent or null while their contracts are not deployed and set. */
  meme?: MemeConfigDTO | null;
}

export interface MemeConfigDTO {
  /** The meme vault factory. */
  factory: string;
  /** The one venue this site trades on: an owner allows each token on it. */
  venue: string;
  /** False while the owner has paused meme trading: vaults can still be seen and withdrawn from. */
  trading: boolean;
  limits: { minBuyEth: number; maxBuyEth: number | null; defaultDailyBuyLimitEth: number };
}

/** Where a launch trades right now. "moving": its curve sold out and its pool is being made; a moment at most. */
export type MemePhaseDTO = "curve" | "moving" | "pool" | "rescued";

/**
 * A token as the chain describes it right now. Names and tickers are not unique and prove nothing: the address is
 * the token. `supported` is false, with the reason, for anything the meme vault cannot trade.
 */
export interface MemeTokenDTO {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  supported: boolean;
  /** Why not, in plain words. */
  unsupportedReason?: string;
  launchpad: "Pons" | null;
  phase: MemePhaseDTO | null;
  /** Charged on every buy and every sale, in percent: the launchpad's fee, and the tax the token's creator set. */
  feePct: number | null;
  creatorTaxPct: number | null;
  /** Before graduation: ETH the curve has collected and what it must collect to graduate. */
  raisedEth: number | null;
  graduationEth: number | null;
  /** ETH for one token, from the curve's reserves; null in a pool (shown as a quote for an amount instead). */
  priceEth: number | null;
  /** The launch's own page. */
  pageUrl: string | null;
  /** The block all of this was read at. */
  block: string;
}

/** What a buy of `ethIn` would return right now, from a dry run of the vault's own buy. */
export interface MemeQuoteDTO {
  ethIn: string;
  tokensOut: string;
  /** ETH the buy would actually use (less than asked when a curve is about to sell out). */
  ethSpent: string;
}

export interface MemeVaultDTO {
  address: string;
  /** Wei, as decimal strings. */
  ethWei: string;
  dailyBuyLimitWei: string;
  remainingDailyWei: string;
  operatorOk: boolean;
  paused: boolean;
  tokens: { address: string; symbol: string; name: string; decimals: number; balanceRaw: string; budgetLeftWei: string; venueOk: boolean }[];
}

export type MemeAgentStage = "buying" | "holding" | "selling" | "sold" | "stopped";

export interface MemeEventDTO {
  id: string;
  at: string;
  /** "bought" | "sold" | "not bought" | "not sold" | "stopped" | "note" */
  kind: string;
  text: string;
  txHash: string | null;
}

export interface MemeAgentDTO {
  id: string;
  name: string;
  vault: string;
  token: string;
  symbol: string;
  tokenName: string;
  decimals: number;
  status: "active" | "paused" | "done" | "archived";
  stage: MemeAgentStage;
  pausedReason: string | null;
  buyWei: string;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  /** From the vault's own events: ETH spent on the buy, tokens received, ETH received from the sale. */
  spentWei: string;
  tokensRaw: string;
  receivedWei: string;
  /** What selling everything would have returned right after the buy: the base the two exits are measured from. */
  entryValueWei: string | null;
  /** What selling everything would return, at the last look. */
  lastValueWei: string | null;
  lastCheckedAt: string | null;
  /** Why the last look could not value the position, if it could not. */
  lastCheckNote: string | null;
  exitKind: string | null;
  launchedAt: string;
  closedAt: string | null;
  events: MemeEventDTO[];
}
