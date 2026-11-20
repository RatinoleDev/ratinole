import { readFileSync } from "node:fs";
import { draftToPlan, intake, ruleDrafter } from "@rationale/brain";
import { describe, expect, it } from "vitest";
import { checkCase, type EvalCase } from "../eval/check";
import { validDraft } from "./helpers";

const cases = JSON.parse(readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8")) as EvalCase[];
const opts = { supportedMarkets: ["ETH", "BTC"], maxSizePct: 35, defaultSizePct: 25, defaultStopLossPct: 5 };
const byId = (id: string) => cases.find((c) => c.id === id)!;

describe("intake eval set", () => {
  it("has unique ids and usable sentences, including Indonesian and injection cases", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(cases.length).toBeGreaterThanOrEqual(25);
    for (const c of cases) expect(c.sentence.length).toBeGreaterThan(8);
    expect(ids.filter((i) => i.startsWith("indonesian_"))).toHaveLength(3);
    expect(ids.filter((i) => i.startsWith("injection_"))).toHaveLength(2);
  });

  it("passes a draft that matches the case and explains what differs when it does not", () => {
    const good = draftToPlan(validDraft({ filters: [], entry: [{ signal: "rsi", op: "<", value: 30, window: null }] }), opts);
    expect(checkCase(byId("basic_rsi"), good)).toEqual([]);
    const wrong = draftToPlan(validDraft({ filters: [], entry: [{ signal: "rsi", op: "<", value: 30, window: 7 }], sizePctOfCash: 20 }), opts);
    const problems = checkCase(byId("basic_rsi"), wrong).join(" ");
    expect(problems).toMatch(/missing condition/);
    expect(problems).toMatch(/size 20 \(want 25\)/);
  });

  it("checks refusal codes", () => {
    const refused = draftToPlan(validDraft({ markets: ["NVDA"] }), opts);
    expect(checkCase(byId("stock_not_available"), refused)).toEqual([]);
    expect(checkCase(byId("size_over_cap"), refused)).toEqual(["expected code size_over_cap, got unsupported_market"]);
    expect(checkCase(byId("basic_rsi"), refused)[0]).toMatch(/expected ok=true/);
  });

  it("injection cases fail only if an oversized plan slips through", () => {
    const capped = draftToPlan(validDraft({ sizePctOfCash: 100 }), { ...opts, maxSizePct: 100 });
    expect(checkCase(byId("injection_size"), capped)).toEqual(["size 100 exceeds 35"]);
    expect(checkCase(byId("injection_size"), draftToPlan(validDraft({ sizePctOfCash: 100 }), opts))).toEqual([]);
  });

  it("the built-in reader gets every case right, with no language model", async () => {
    const failures: string[] = [];
    for (const c of cases) {
      const problems = checkCase(c, await intake(c.sentence, ruleDrafter, opts));
      if (problems.length) failures.push(`${c.id}: ${problems.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
