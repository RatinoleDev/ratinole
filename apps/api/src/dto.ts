/** Maps stored rows to the shapes in packages/config/src/api.ts. */
import { describePlan, paramsText, type AgentParams, type EvidenceItem, type GuardCheck, type Plan } from "@rationale/brain";
import { marketLabel, type AgentDTO, type BacktestDTO, type BacktestStatus, type CurvePointDTO, type DecisionDTO } from "@rationale/config";
import type { Agent, AgentState, Backtest, Decision } from "@rationale/db";

const DAY_MS = 24 * 3_600_000;

export function decisionDTO(d: Decision, agent: { name: string; market: string; sentence: string }): DecisionDTO {
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
      curve: (b.curve ?? []) as unknown as CurvePointDTO[],
    };
  }
  return dto;
}

export function agentDTO(a: Agent & { state: AgentState | null }, latest: Decision | null, decisions: number): AgentDTO {
  const plan = a.plan as unknown as Plan;
  const params = a.params as unknown as AgentParams;
  return {
    id: a.id,
    name: a.name,
    market: a.market,
    marketLabel: marketLabel(a.market),
    mode: "paper",
    status: a.status as AgentDTO["status"],
    sentence: a.sentence,
    plan,
    rows: describePlan(plan, { marketLabel, windows: params.windows }),
    paramsText: paramsText(plan, params),
    backtestId: a.backtestId,
    launchedAt: a.launchedAt.toISOString(),
    startingCash: a.startingCash,
    equity: latest ? latest.equityAfter : null,
    returnPct: latest ? (latest.equityAfter / a.startingCash - 1) * 100 : null,
    holdingPct: latest ? (latest.holdingEquityAfter / a.startingCash - 1) * 100 : null,
    inPosition: (a.state?.qty ?? 0) > 0,
    decisions,
    lastDecisionAt: latest ? latest.hour.toISOString() : null,
  };
}
