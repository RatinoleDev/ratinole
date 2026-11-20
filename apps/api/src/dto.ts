/** Maps stored rows to the shapes in packages/config/src/api.ts. */
import { backtestWarnings, describePlan, paramsText, type AgentParams, type EvidenceItem, type GuardCheck, type Plan } from "@rationale/brain";
import { marketLabel, type AgentDTO, type BacktestDTO, type BacktestStatus, type CurvePointDTO, type DecisionDTO, type MarketDTO } from "@rationale/config";
import type { Agent, AgentState, Backtest, Decision, MarketSnapshot } from "@rationale/db";

const DAY_MS = 24 * 3_600_000;

export function decisionDTO(d: Decision, agent: { name: string; market: string; sentence: string; house: boolean; mode: string }): DecisionDTO {
  return {
    id: d.id,
    agentId: d.agentId,
    at: d.hour.toISOString(),
    hour: d.hour.toISOString(),
    action: d.action as DecisionDTO["action"],
    confidence: d.confidence,
    regime: d.regime as DecisionDTO["regime"],
    evidence: d.evidence as unknown as EvidenceItem[],
    guard: d.guard as unknown as GuardCheck[],
    explanation: d.explanation,
    ...(d.txHash ? { txHash: d.txHash } : {}),
    late: d.late,
    fill:
      d.fillSide && d.fillPrice != null
        ? { side: d.fillSide as "buy" | "sell", price: d.fillPrice, qty: d.fillQty ?? 0, notional: d.fillNotional ?? 0, fee: d.fillFee ?? 0 }
        : null,
    equityAfter: d.equityAfter,
    holdingEquityAfter: d.holdingEquityAfter,
    markPrice: d.markPrice,
    candleSource: d.candleSource,
    agentName: agent.name,
    mode: agent.mode === "live" ? "live" : "paper",
    ...(d.execError ? { execError: d.execError } : {}),
    ...(d.flowUsd != null ? { flowUsd: d.flowUsd } : {}),
    house: agent.house,
    strategy: agent.sentence,
    market: agent.market,
    marketLabel: marketLabel(agent.market),
  };
}

export function backtestDTO(b: Backtest): BacktestDTO {
  const plan = b.plan as unknown as Plan;
  const params = (b.params ?? null) as AgentParams | null;
  const dto: BacktestDTO = {
    id: b.id,
    status: b.status as BacktestStatus,
    ...(b.error ? { error: b.error } : {}),
    sentence: b.sentence,
    plan,
    market: b.market,
    marketLabel: marketLabel(b.market),
    source: b.source ?? "",
    label: b.label,
    createdAt: b.createdAt.toISOString(),
  };
  if (b.status === "done" && b.fromTime && b.splitTime && b.toTime && params) {
    dto.result = {
      from: b.fromTime.toISOString(),
      split: b.splitTime.toISOString(),
      to: b.toTime.toISOString(),
      candles: b.candles ?? 0,
      costPct: b.costPct,
      tunedDays: Math.round((b.splitTime.getTime() - b.fromTime.getTime()) / DAY_MS),
      unseenDays: Math.round((b.toTime.getTime() - b.splitTime.getTime() + 3_600_000) / DAY_MS),
      tunedReturnPct: b.tunedReturnPct ?? 0,
      unseenReturnPct: b.unseenReturnPct ?? 0,
      holdingTunedPct: b.holdingTunedPct ?? 0,
      holdingUnseenPct: b.holdingUnseenPct ?? 0,
      maxDrawdownPct: b.maxDrawdownPct ?? 0,
      tunedTrades: b.tunedTrades ?? 0,
      unseenTrades: b.unseenTrades ?? 0,
      paramsText: paramsText(plan, params),
      warnings: backtestWarnings({ tunedTrades: b.tunedTrades ?? 0, unseenTrades: b.unseenTrades ?? 0, tunedReturnPct: b.tunedReturnPct ?? undefined }),
      curve: (b.curve ?? []) as unknown as CurvePointDTO[],
    };
  }
  return dto;
}

/** The base a decision's value is measured against: the one stored with it, or the agent's own for older rows and paper agents. */
const base = (a: Agent, d: Decision) => (d.basisAfter != null && d.basisAfter > 0 ? d.basisAfter : a.startingCash);

export function agentDTO(a: Agent & { state: AgentState | null }, latest: Decision | null, decisions: number): AgentDTO {
  const plan = a.plan as unknown as Plan;
  const params = a.params as unknown as AgentParams;
  return {
    id: a.id,
    name: a.name,
    market: a.market,
    marketLabel: marketLabel(a.market),
    mode: a.mode === "live" ? "live" : "paper",
    vault: a.vault,
    pausedReason: a.status === "paused" ? a.pausedReason : null,
    house: a.house,
    status: a.status as AgentDTO["status"],
    sentence: a.sentence,
    plan,
    rows: describePlan(plan, { marketLabel, windows: params.windows }),
    paramsText: paramsText(plan, params),
    backtestId: a.backtestId,
    launchedAt: a.launchedAt.toISOString(),
    startingCash: a.startingCash,
    equity: latest ? latest.equityAfter : null,
    // Each decision is measured against the base it was made on. For a live agent that base moves with deposits
    // and withdrawals, and is stored with the decision: never divide an old value by a newer base.
    returnPct: latest && base(a, latest) > 0 ? (latest.equityAfter / base(a, latest) - 1) * 100 : null,
    holdingPct: latest && base(a, latest) > 0 ? (latest.holdingEquityAfter / base(a, latest) - 1) * 100 : null,
    inPosition: (a.state?.qty ?? 0) > 0,
    decisions,
    lastDecisionAt: latest ? latest.hour.toISOString() : null,
  };
}

export function marketDTO(m: MarketSnapshot): MarketDTO {
  return {
    market: m.market,
    marketLabel: marketLabel(m.market),
    price: m.price,
    change24Pct: m.change24Pct,
    regime: m.regime as MarketDTO["regime"],
    direction: m.direction as MarketDTO["direction"],
    reason: m.reason,
    rsi: m.rsi,
    funding8hPct: m.funding8hPct,
    dailyVolPct: m.dailyVolPct,
    closes7d: m.closes7d as unknown as number[],
    asOf: m.hour.toISOString(),
    candleSource: m.candleSource,
    fundingSource: m.fundingSource,
  };
}
