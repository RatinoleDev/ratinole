/**
 * Walk-forward backtest (HANDOFF 5.4). The tuner may only look at the first
 * part of the window; the rest is scored with the tuned settings, fresh cash
 * and no peeking. With folds = 1 this is the handoff's split: tune on the
 * first two thirds, score on the last third. With more folds the unseen part
 * is cut into consecutive slices, and each slice is scored with settings tuned
 * on everything before it.
 *
 * The tuner never changes a number the user wrote. It only chooses what the
 * sentence left open: lookbacks for conditions without one, and the confidence
 * an entry needs.
 */
import { DEFAULT_PARAMS, type AgentParams, type DecideContext } from "../decide";
import { describeCondition } from "../describe";
import { DEFAULT_REGIME_PARAMS } from "../regime";
import { SIGNALS, SeriesSource, type SignalId } from "../signals";
import { HOUR_MS, type Candle, type Plan } from "../types";
import { downsample, maxDrawdownPct } from "./metrics";
import { simulate, type SimResult } from "./simulate";

export const DEFAULT_THRESHOLDS = [50, 40, 60, 70];
const MAX_GRID = 64;

interface Tunable {
  path: string;
  choices: number[];
}

function tunables(plan: Plan): Tunable[] {
  const out: Tunable[] = [];
  const scan = (conds: Plan["entry"], prefix: string) =>
    conds.forEach((c, k) => {
      if (c.window != null) return;
      const choices = SIGNALS[c.signal as SignalId]?.windowChoices ?? [];
      if (choices.length > 1) out.push({ path: `${prefix}.${k}`, choices });
    });
  scan(plan.entry, "entry");
  scan(plan.exit.conditions ?? [], "exit");
  return out;
}

/** Every combination the tuner tries, default settings first. */
export function buildGrid(plan: Plan, thresholds: number[] = DEFAULT_THRESHOLDS): AgentParams[] {
  const ts = plan.kind === "dca" ? [DEFAULT_PARAMS.confidenceThreshold] : thresholds;
  let combos: Record<string, number>[] = [{}];
  for (const t of tunables(plan)) {
    combos = combos.flatMap((w) => t.choices.map((c) => ({ ...w, [t.path]: c })));
  }
  const grid: AgentParams[] = [];
  for (const windows of combos) for (const confidenceThreshold of ts) grid.push({ confidenceThreshold, windows });
  return grid.slice(0, MAX_GRID);
}

/** Candles needed before the first decision so every indicator has history. */
export function requiredWarmup(plan: Plan): number {
  const conds = [...plan.entry, ...(plan.exit.conditions ?? [])];
  let longest = 0;
  for (const c of conds) {
    const spec = SIGNALS[c.signal as SignalId];
    const ws = c.window != null ? [c.window] : (spec?.windowChoices ?? [spec?.defaultWindow ?? 1]);
    const extra = c.signal === "trend_pct" ? 24 : 1;
    for (const w of ws) longest = Math.max(longest, w + extra);
  }
  const p = DEFAULT_REGIME_PARAMS;
  return Math.max(longest, p.baselineWindow, p.trendWindow + p.slopeLookback, 174) + 1;
}

export interface SegmentStats {
  from: number;
  to: number;
  hours: number;
  returnPct: number;
  holdingPct: number;
  maxDrawdownPct: number;
  trades: number;
}

export interface FoldResult {
  params: AgentParams;
  tune: SegmentStats;
  test: SegmentStats;
}

export interface WalkForwardResult {
  /** Settings to run live: those tuned for the last fold. */
  params: AgentParams;
  gridSize: number;
  tune: SegmentStats;
  unseen: SegmentStats;
  folds: FoldResult[];
  /** 100 = starting cash. Tuning days, then unseen days chained on. */
  curve: { t: number; strategy: number; holding: number }[];
  splitHour: number;
}

export interface WalkForwardInput {
  plan: Plan;
  candles: readonly Candle[];
  /** Index of the first decision of the scored window. */
  evalStart: number;
  folds?: number;
  tuneFraction?: number;
  startCash: number;
  costPct: number;
  limits: DecideContext["limits"];
  thresholds?: number[];
  curvePoints?: number;
}

function stats(sim: SimResult): SegmentStats {
  return {
    from: sim.hours[0]!,
    to: sim.hours[sim.hours.length - 1]!,
    hours: sim.hours.length,
    returnPct: sim.returnPct,
    holdingPct: sim.holdingPct,
    maxDrawdownPct: sim.maxDrawdownPct,
    trades: sim.trades.length,
  };
}

/** Higher is better: return, penalised by half the worst drop. */
function score(sim: SimResult): number {
  return sim.returnPct + 0.5 * sim.maxDrawdownPct;
}

export function walkForward(w: WalkForwardInput): WalkForwardResult {
  const folds = Math.max(1, Math.floor(w.folds ?? 1));
  const tuneFraction = w.tuneFraction ?? 2 / 3;
  const src = new SeriesSource(w.candles);
  const last = src.length - 2; // last decision index that still has a next candle to fill at
  const n = last - w.evalStart + 1;
  if (w.evalStart < 1 || n < 48) throw new Error("Not enough candles for a backtest window");
  const split = w.evalStart + Math.floor(n * tuneFraction);
  const grid = buildGrid(w.plan, w.thresholds);

  const ctxFor = (params: AgentParams): DecideContext => ({
    agentId: "backtest",
    plan: w.plan,
    params,
    limits: w.limits,
    costPct: w.costPct,
  });
  const run = (params: AgentParams, start: number, end: number) =>
    simulate({ ctx: ctxFor(params), src, start, end, startCash: w.startCash });

  // Pick the best-scoring setting among those that actually traded. A setting
  // that never trades would "win" whenever trading lost money, and leave the
  // unseen days with nothing to test; it is chosen only if nothing traded.
  const tuneOn = (start: number, end: number) => {
    const results = grid.map((params) => ({ params, sim: run(params, start, end) }));
    const trading = results.filter((r) => r.sim.trades.length > 0);
    const pool = trading.length ? trading : results;
    let best = pool[0]!;
    for (const r of pool) if (score(r.sim) > score(best.sim)) best = r;
    return best;
  };

  const testLen = last + 1 - split;
  const foldResults: FoldResult[] = [];
  const testSims: SimResult[] = [];
  let firstTune: { params: AgentParams; sim: SimResult } | null = null;
  for (let k = 0; k < folds; k++) {
    const testStart = split + Math.floor((testLen * k) / folds);
    const testEnd = split + Math.floor((testLen * (k + 1)) / folds);
    if (testEnd - testStart < 2) continue;
    const tuned = tuneOn(w.evalStart, testStart);
    if (!firstTune) firstTune = tuned;
    const test = run(tuned.params, testStart, testEnd);
    testSims.push(test);
    foldResults.push({ params: tuned.params, tune: stats(tuned.sim), test: stats(test) });
  }
  if (!firstTune || !testSims.length) throw new Error("Backtest window too short for the requested folds");

  // Unseen stats across folds: compound the returns, chain the equity.
  const chained: number[] = [];
  let scale = 1;
  for (const s of testSims) {
    for (const v of s.equity) chained.push(v * scale);
    scale = chained[chained.length - 1]! / w.startCash;
  }
  const unseenSim = run(foldResults[0]!.params, split, last + 1); // only for holding over the whole unseen span
  const unseen: SegmentStats = {
    from: testSims[0]!.hours[0]!,
    to: testSims[testSims.length - 1]!.hours.at(-1)!,
    hours: chained.length,
    returnPct: (chained[chained.length - 1]! / w.startCash - 1) * 100,
    holdingPct: unseenSim.holdingPct,
    maxDrawdownPct: maxDrawdownPct(chained, w.startCash),
    trades: testSims.reduce((a, s) => a + s.trades.length, 0),
  };

  // Curve: tuning-days run of the first fold's settings, then unseen days chained on.
  const tuneSim = firstTune.sim;
  const tuneEndFactor = tuneSim.equity[tuneSim.equity.length - 1]! / w.startCash;
  const holdAll = run(foldResults[0]!.params, w.evalStart, last + 1).holding;
  const points: { t: number; strategy: number; holding: number }[] = [];
  tuneSim.hours.forEach((t, k) => points.push({ t, strategy: (tuneSim.equity[k]! / w.startCash) * 100, holding: (holdAll[k]! / w.startCash) * 100 }));
  const testHours = testSims.flatMap((s) => s.hours);
  testHours.forEach((t, k) =>
    points.push({
      t,
      strategy: (chained[k]! / w.startCash) * tuneEndFactor * 100,
      holding: (holdAll[tuneSim.hours.length + k]! / w.startCash) * 100,
    }),
  );

  return {
    params: foldResults[foldResults.length - 1]!.params,
    gridSize: grid.length,
    tune: stats(tuneSim),
    unseen,
    folds: foldResults,
    curve: downsample(points, w.curvePoints ?? 360),
    splitHour: src.candles[split]!.t + HOUR_MS,
  };
}

/** Plain-language lines about what the tuner chose. */
export function paramsText(plan: Plan, params: AgentParams): string[] {
  const lines: string[] = [];
  const scan = (conds: Plan["entry"], prefix: string) =>
    conds.forEach((c, k) => {
      const w = params.windows[`${prefix}.${k}`];
      if (c.window == null && w != null) lines.push(`"${describeCondition(c)}" uses the ${w}-hour window, chosen on the tuning days.`);
    });
  scan(plan.entry, "entry");
  scan(plan.exit.conditions ?? [], "exit");
  if (plan.kind === "dca") lines.push("Scheduled buys happen whatever the confidence.");
  else lines.push(`Buys only when confidence is at least ${params.confidenceThreshold}%, chosen on the tuning days.`);
  return lines;
}
