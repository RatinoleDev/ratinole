import { z } from "zod";
import { SIGNAL_IDS, isSignalId } from "./signals";

export const OpSchema = z.enum(["<", ">", "crosses_above", "crosses_below"]);
export const FilterSchema = z.enum(["negative_news", "earnings_week", "stressed_regime", "macro_print"]);
export const KindSchema = z.enum(["entry_exit", "rebalance", "dca", "grid"]);

/** A condition inside a confirmed Plan. */
export const ConditionSchema = z.strictObject({
  signal: z.string().refine(isSignalId, { message: "Unknown signal" }),
  op: OpSchema,
  value: z.number().finite(),
  window: z.number().int().min(1).max(1000).optional(),
});

/** A confirmed Plan (HANDOFF 5.1). Used to re-validate plans sent back by the browser. */
export const PlanSchema = z.strictObject({
  markets: z.array(z.string().min(1).max(12)).min(1).max(5),
  kind: KindSchema,
  entry: z.array(ConditionSchema).max(6),
  exit: z.strictObject({
    takeProfitPct: z.number().gt(0).max(1000).optional(),
    stopLossPct: z.number().gt(0).lt(100).optional(),
    trailingStopPct: z.number().gt(0).lt(100).optional(),
    conditions: z.array(ConditionSchema).max(6).optional(),
  }),
  filters: z.array(FilterSchema).max(4),
  sizePctOfCash: z.number().min(1).max(100),
  weights: z.record(z.string(), z.number().min(0).max(100)).optional(),
  cadenceHours: z.number().int().min(1).max(8760).optional(),
});

/**
 * What the LLM must return. Unknowns are null rather than guessed; the intake
 * code fills documented defaults and tells the user.
 */
export const DraftConditionSchema = z.object({
  signal: z.enum(SIGNAL_IDS as [string, ...string[]]),
  op: OpSchema,
  value: z.number(),
  window: z.number().int().nullable(),
});

export const DraftSchema = z.object({
  understood: z.boolean(),
  problem: z.string().nullable(),
  markets: z.array(z.string()),
  kind: KindSchema,
  entry: z.array(DraftConditionSchema),
  exit: z.object({
    takeProfitPct: z.number().nullable(),
    stopLossPct: z.number().nullable(),
    trailingStopPct: z.number().nullable(),
    conditions: z.array(DraftConditionSchema),
  }),
  filters: z.array(FilterSchema),
  sizePctOfCash: z.number().nullable(),
  weights: z.array(z.object({ market: z.string(), pct: z.number() })),
  cadenceHours: z.number().int().nullable(),
});

export type Draft = z.infer<typeof DraftSchema>;
