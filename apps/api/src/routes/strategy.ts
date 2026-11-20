/** Sentence -> plan (intake), and backtests of a confirmed plan. */
import { checkPlan, describePlan, intake, planChecks, ruleDrafter, type IntakeOptions, type IntakeOutcome } from "@rationale/brain";
import { MARKET_IDS, PAPER, RISK_DEFAULTS, marketLabel, type IntakeResponse } from "@rationale/config";
import type { Prisma } from "@rationale/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backtestDTO } from "../dto";
import { allow, requireUser, sendError, type ApiDeps } from "../deps";
import { monthSpendUsd } from "../llm/anthropic";
import { currentUser } from "../auth";

const IntakeBody = z.object({ sentence: z.string().max(2000) });
const BacktestBody = z.object({ sentence: z.string().min(1).max(1000), plan: z.unknown() });

function intakeOptions(user: { maxSizePct: number }): IntakeOptions {
  return {
    supportedMarkets: MARKET_IDS,
    maxSizePct: user.maxSizePct,
    defaultSizePct: RISK_DEFAULTS.defaultSizePct,
    defaultStopLossPct: RISK_DEFAULTS.defaultStopLossPct,
  };
}

export function strategyRoutes(app: FastifyInstance, deps: ApiDeps) {
  app.post("/intake", async (req, reply): Promise<IntakeResponse | typeof reply> => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const body = IntakeBody.safeParse(req.body);
    if (!body.success) return { ok: false, code: "rephrase", message: "Write your strategy as a sentence." };

    if (!(await allow(deps.redis, `intake:${user.id}`, 20, 3600))) {
      return { ok: false, code: "rate_limited", message: "That's a lot of strategies for one hour. Try again later." };
    }

    // The language model reads the sentence when one is configured and within budget. Otherwise, or when the
    // model cannot be reached, the built-in reader does: fixed rules, the same checks, no guessing.
    const opts = intakeOptions(user);
    const model = deps.drafterFor(user.id);
    let outcome: IntakeOutcome | null = null;
    let reader: "model" | "rules" = "rules";
    if (model && (await monthSpendUsd(deps.prisma)) < deps.env.llmMonthlyBudgetUsd) {
      try {
        outcome = await intake(body.data.sentence, model, opts);
        reader = "model";
      } catch (err) {
        req.log.warn({ err: String(err) }, "model intake failed; using the built-in reader");
      }
    }
    outcome ??= await intake(body.data.sentence, ruleDrafter, opts);
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      plan: outcome.plan,
      rows: describePlan(outcome.plan, { marketLabel }),
      checks: planChecks(outcome.plan, user.maxSizePct),
      notes: outcome.notes,
      notChecked: outcome.notChecked,
      reader,
    };
  });

  app.post("/backtests", async (req, reply) => {
    const user = await requireUser(deps, req, reply);
    if (!user) return reply;
    const body = BacktestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, code: "rephrase", message: "Confirm a plan first." });
    // The browser sends the confirmed plan back; it gets the same checks as a fresh intake.
    const checked = checkPlan(body.data.plan, intakeOptions(user));
    if (!checked.ok) return reply.code(400).send(checked);
    if (!(await allow(deps.redis, `backtest:${user.id}`, 15, 3600))) return sendError(reply, 429, "rate_limited", "Too many backtests this hour. Try again later.");

    const bt = await deps.prisma.backtest.create({
      data: {
        userId: user.id,
        kind: "user",
        sentence: body.data.sentence.trim(),
        plan: checked.plan as unknown as Prisma.InputJsonValue,
        market: checked.plan.markets[0]!,
        maxSizePct: user.maxSizePct,
        dailyLossCapPct: user.dailyLossCapPct,
        costPct: PAPER.costPct,
        startCash: PAPER.startingCash,
      },
    });
    await deps.enqueue("backtest", { backtestId: bt.id }, `bt-${bt.id}`);
    return { id: bt.id };
  });

  app.get<{ Params: { id: string } }>("/backtests/:id", async (req, reply) => {
    const bt = await deps.prisma.backtest.findUnique({ where: { id: req.params.id } });
    if (!bt) return sendError(reply, 404, "not_found", "No such backtest.");
    if (bt.kind !== "example") {
      const user = await currentUser(deps.prisma, req);
      if (!user || user.id !== bt.userId) return sendError(reply, 404, "not_found", "No such backtest.");
    }
    return backtestDTO(bt);
  });
}
