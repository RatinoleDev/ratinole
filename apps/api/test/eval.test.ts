import { readFileSync } from "node:fs";
import { describePlan, draftToPlan, intake, planChecks, ruleDrafter } from "@rationale/brain";
import { MARKET_IDS, RISK_DEFAULTS, STUDIO_EXAMPLES } from "@rationale/config";
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

describe("the example strategies offered in Agent Studio", () => {
  // The options the API reads a sentence with, for a wallet with the default limits.
  const api = { supportedMarkets: MARKET_IDS, maxSizePct: RISK_DEFAULTS.maxSizePctOfCash, defaultSizePct: RISK_DEFAULTS.defaultSizePct, defaultStopLossPct: RISK_DEFAULTS.defaultStopLossPct };
  const rows = async (sentence: string) => {
    const out = await intake(sentence, ruleDrafter, api);
    if (!out.ok) throw new Error(`${sentence}: ${out.message}`);
    return { out, text: describePlan(out.plan).map((r) => `${r.label}: ${r.lines.join(" | ")}`) };
  };

  it("are each read exactly as written, with nothing filled in for the user", async () => {
    const read: Record<string, string[]> = {};
    for (const e of STUDIO_EXAMPLES) {
      const { out, text } = await rows(e.sentence);
      // A note means the reader had to assume something (a size, a stop). An example states everything itself.
      expect(out.notes, e.label).toEqual([]);
      read[e.label] = text;
    }
    expect(read).toEqual({
      "Trend dip on ETH": [
        "Market: ETH / USDG",
        "Buy when: Price is more than 3% under its 20-hour average | The long trend is rising",
        "Sell when: Take profit at +6% | Stop loss at −4%",
        "Stands aside: When the market is classed as stressed",
        "Size per trade: 20% of cash",
      ],
      "RSI rebound on BTC": [
        "Market: BTC / USDG",
        "Buy when: RSI crosses above 30",
        "Sell when: Stop loss at −5% | RSI is above 70",
        "Stands aside: When the market is classed as stressed",
        "Size per trade: 25% of cash",
      ],
      "Drop rebound on ETH": [
        "Market: ETH / USDG",
        "Buy when: RSI is below 35 | Price fell more than 5% in the last 24 hours",
        "Sell when: Stop loss at −5% | Price crosses back above its 20-hour average",
        "Stands aside: When the market is classed as stressed",
        "Size per trade: 20% of cash",
      ],
      "Momentum on ETH": [
        "Market: ETH / USDG",
        "Buy when: Volume is above 1.5× its 24-hour average | Price rose more than 3% in the last 24 hours",
        "Sell when: Trailing stop 4% under the high since buying",
        "Stands aside: When the market is classed as stressed",
        "Size per trade: 20% of cash",
      ],
      "Uptrend pullback on BTC": [
        "Market: BTC / USDG",
        "Buy when: RSI is below 45 | The long trend is rising",
        "Sell when: Take profit at +5% | Trailing stop 3% under the high since buying",
        "Stands aside: When the market is classed as stressed",
        "Size per trade: 20% of cash",
      ],
      "Weekly ETH buyer": ["Market: ETH / USDG", "Buy when: Buys every week", "Sell when: Stop loss at −15%", "Stands aside: When the market is classed as stressed", "Size per trade: 10% of cash"],
    });
  });

  it("each pass every row of the plan check, and none needs a feed that can be missing", async () => {
    for (const e of STUDIO_EXAMPLES) {
      const { out } = await rows(e.sentence);
      if (!out.ok) continue;
      expect(planChecks(out.plan, api.maxSizePct).filter((c) => !c.pass), e.label).toEqual([]);
      const signals = [...out.plan.entry, ...(out.plan.exit.conditions ?? [])].map((c) => c.signal);
      expect(signals, e.label).not.toContain("funding_rate");
    }
  });

  it("have short, distinct labels and fit the sentence box", () => {
    const labels = STUDIO_EXAMPLES.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const e of STUDIO_EXAMPLES) {
      expect(e.label.length, e.label).toBeLessThanOrEqual(26);
      expect(e.sentence.length, e.label).toBeLessThanOrEqual(240);
    }
  });
});
