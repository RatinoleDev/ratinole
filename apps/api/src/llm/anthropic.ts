/**
 * The only place the API talks to an LLM: turning a sentence into a draft plan
 * (HANDOFF 5.3). The model receives the sentence and the schema, nothing else:
 * no keys, no balances, no tools. Its answer is constrained to the draft schema
 * and validated again by the brain. Every call's token use is recorded so the
 * monthly budget can be enforced.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { DraftSchema, buildIntakeSystemPrompt, buildIntakeUserMessage, type PlanDrafter } from "@rationale/brain";
import type { PrismaClient } from "@rationale/db";

/** USD per million tokens (input, output), first-party API list prices. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = PRICES[model] ?? PRICES["claude-opus-5-5"]!; // unknown models are priced conservatively
  return (inputTokens * pin + outputTokens * pout) / 1_000_000;
}

export class LlmRefusedError extends Error {}

type ParseClient = Pick<Anthropic, "beta">;

export function anthropicDrafter(opts: { apiKey: string; model: string; prisma: PrismaClient; userId?: string; client?: ParseClient }): PlanDrafter {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60_000 });
  const system = buildIntakeSystemPrompt();
  return async (sentence: string) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let ok = false;
    try {
      const res = await client.beta.messages.parse({
        model: opts.model,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: buildIntakeUserMessage(sentence) }],
        output_config: { format: betaZodOutputFormat(DraftSchema), effort: "low" },
        // If a safety classifier declines, the API retries on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      inputTokens = res.usage.input_tokens;
      outputTokens = res.usage.output_tokens;
      if (res.stop_reason === "refusal") throw new LlmRefusedError("The model declined to read this sentence");
      ok = true;
      // null when the output did not parse; the brain then asks the user to rephrase.
      return res.parsed_output ?? null;
    } finally {
      await opts.prisma.llmUsage
        .create({
          data: {
            userId: opts.userId ?? null,
            model: opts.model,
            purpose: "intake",
            inputTokens,
            outputTokens,
            costUsd: estimateCostUsd(opts.model, inputTokens, outputTokens),
            ok,
          },
        })
        .catch(() => undefined);
    }
  };
}

/** Estimated spend this calendar month (UTC). */
export async function monthSpendUsd(prisma: PrismaClient, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await prisma.llmUsage.aggregate({ where: { at: { gte: start } }, _sum: { costUsd: true } });
  return agg._sum.costUsd ?? 0;
}
