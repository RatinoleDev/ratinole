/**
 * Runs the intake eval set against the real LLM. Costs money, so it only runs
 * with ANTHROPIC_API_KEY set and --yes passed; without --yes it prints the
 * worst-case cost and stops.
 *   pnpm --filter @rationale/api eval:intake            (dry run: shows cost)
 *   pnpm --filter @rationale/api eval:intake --yes      (spends it)
 *   pnpm --filter @rationale/api eval:intake --yes --only=weekly_dca
 */
import { readFileSync } from "node:fs";
import { intake, type IntakeOutcome } from "@rationale/brain";
import { MARKET_IDS, RISK_DEFAULTS } from "@rationale/config";
import type { PrismaClient } from "@rationale/db";
import { anthropicDrafter, estimateCostUsd } from "../src/llm/anthropic";
import { checkCase, type EvalCase } from "./check";

const all = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as EvalCase[];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const cases = only ? all.filter((c) => only.split(",").includes(c.id)) : all;
const model = process.env.LLM_MODEL || "claude-opus-5-5";
// Generous per-call bound: ~3k tokens in, ~3k out (thinking included).
const worstCase = cases.length * estimateCostUsd(model, 3000, 3000);

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!process.argv.includes("--yes")) {
    console.log(`Would run ${cases.length} case(s) on ${model}. Estimated cost at most $${worstCase.toFixed(2)}. Re-run with --yes to spend it.`);
    if (!key) console.log("ANTHROPIC_API_KEY is not set yet; set it in .env first.");
    return;
  }
  if (!key) {
    console.log("ANTHROPIC_API_KEY is not set; nothing to run.");
    process.exitCode = 1;
    return;
  }
  const usage: { costUsd: number }[] = [];
  const recorder = { llmUsage: { create: async ({ data }: { data: { costUsd: number } }) => usage.push(data) } } as unknown as PrismaClient;
  const draft = anthropicDrafter({ apiKey: key, model, prisma: recorder });
  const opts = { supportedMarkets: MARKET_IDS, maxSizePct: RISK_DEFAULTS.maxSizePctOfCash, defaultSizePct: RISK_DEFAULTS.defaultSizePct, defaultStopLossPct: RISK_DEFAULTS.defaultStopLossPct };

  let passed = 0;
  for (const c of cases) {
    let out: IntakeOutcome;
    try {
      out = await intake(c.sentence, draft, opts);
    } catch (err) {
      out = { ok: false, code: "rephrase", message: `LLM error: ${String(err)}` };
    }
    const problems = checkCase(c, out);
    if (problems.length === 0) passed++;
    console.log(`${problems.length ? "FAIL" : "pass"}  ${c.id}${problems.length ? `\n      ${problems.join("\n      ")}` : ""}`);
  }
  const spent = usage.reduce((s, u) => s + u.costUsd, 0);
  console.log(`\n${passed}/${cases.length} passed on ${model}. Estimated spend $${spent.toFixed(3)}.`);
  if (passed < cases.length) process.exitCode = 1;
}

main();
