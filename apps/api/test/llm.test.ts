import { prisma } from "@rationale/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmRefusedError, anthropicDrafter, estimateCostUsd, monthSpendUsd } from "../src/llm/anthropic";
import { validDraft, wipe } from "./helpers";

const hasDb = !!process.env.DATABASE_URL;

function stub(response: Record<string, unknown>) {
  const parse = vi.fn(async () => response);
  return { client: { beta: { messages: { parse } } } as never, parse };
}

describe("estimateCostUsd", () => {
  it("uses list prices per million tokens, and prices unknown models like Opus", () => {
    expect(estimateCostUsd("claude-opus-5-5", 1_000_000, 0)).toBe(4);
    expect(estimateCostUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6, 10);
    expect(estimateCostUsd("some-new-model", 0, 1_000_000)).toBe(20);
  });
});

describe.skipIf(!hasDb)("anthropicDrafter", () => {
  beforeEach(wipe);
  afterAll(() => prisma.$disconnect());

  it("sends only the prompt and the sentence, returns the parsed draft and records usage", async () => {
    const { client, parse } = stub({ stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 300 }, parsed_output: validDraft() });
    const draft = anthropicDrafter({ apiKey: "unused", model: "claude-opus-5-5", prisma, userId: "u1", client });
    expect(await draft("Buy ETH when RSI drops below 30")).toEqual(validDraft());
    const args = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(args.model).toBe("claude-opus-5-5");
    expect(args.messages).toEqual([{ role: "user", content: "<sentence>Buy ETH when RSI drops below 30</sentence>" }]);
    expect(args.tools).toBeUndefined();
    expect(args.fallbacks).toBe("default");
    const usage = await prisma.llmUsage.findFirstOrThrow();
    expect(usage).toMatchObject({ userId: "u1", inputTokens: 1200, outputTokens: 300, ok: true, purpose: "intake" });
    expect(await monthSpendUsd(prisma)).toBeCloseTo(estimateCostUsd("claude-opus-5-5", 1200, 300), 10);
  });

  it("treats a refusal as an error and still records the call", async () => {
    const { client } = stub({ stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 }, parsed_output: null });
    const draft = anthropicDrafter({ apiKey: "unused", model: "claude-opus-5-5", prisma, client });
    await expect(draft("x".repeat(20))).rejects.toBeInstanceOf(LlmRefusedError);
    expect((await prisma.llmUsage.findFirstOrThrow()).ok).toBe(false);
  });
});
