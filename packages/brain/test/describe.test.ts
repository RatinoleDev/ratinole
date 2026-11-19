import { describe, expect, it } from "vitest";
import { cadenceText, describeCondition, describePlan, planChecks } from "../src/describe";
import type { Plan } from "../src/types";

describe("describeCondition", () => {
  it("reads common rules in plain language", () => {
    expect(describeCondition({ signal: "rsi", op: "<", value: 30 })).toBe("RSI is below 30");
    expect(describeCondition({ signal: "rsi", op: "crosses_above", value: 30 })).toBe("RSI crosses above 30");
    expect(describeCondition({ signal: "price_vs_sma_pct", op: "<", value: -3, window: 20 })).toBe("Price is more than 3% under its 20-hour average");
    expect(describeCondition({ signal: "price_vs_sma_pct", op: "<", value: -3 })).toBe("Price is more than 3% under its short average");
    expect(describeCondition({ signal: "price_vs_sma_pct", op: "crosses_above", value: 0 }, 20)).toBe("Price crosses back above its 20-hour average");
    expect(describeCondition({ signal: "trend_pct", op: ">", value: 0 })).toBe("The long trend is rising");
    expect(describeCondition({ signal: "trend_pct", op: ">", value: 0 }, 200)).toBe("The 200-hour trend is rising");
    expect(describeCondition({ signal: "change_pct", op: "<", value: -5 })).toBe("Price fell more than 5% in the last 24 hours");
    expect(describeCondition({ signal: "from_high_pct", op: "<", value: -5, window: 72 })).toBe("Price is more than 5% below its 72-hour high");
    expect(describeCondition({ signal: "volume_ratio", op: ">", value: 2 })).toBe("Volume is above 2× its 24-hour average");
  });
});

describe("cadenceText", () => {
  it("names common schedules", () => {
    expect(cadenceText(168)).toBe("every week");
    expect(cadenceText(24)).toBe("every day");
    expect(cadenceText(72)).toBe("every 3 days");
    expect(cadenceText(6)).toBe("every 6 hours");
  });
});

const plan: Plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [
    { signal: "rsi", op: "<", value: 30 },
    { signal: "trend_pct", op: ">", value: 0 },
  ],
  exit: { takeProfitPct: 8, stopLossPct: 4 },
  filters: ["negative_news", "stressed_regime"],
  sizePctOfCash: 25,
};

describe("describePlan", () => {
  it("produces the confirmation rows", () => {
    const rows = describePlan(plan, { marketLabel: (m) => `${m} / USDG`, windows: { "entry.1": 200 } });
    expect(rows.map((r) => r.label)).toEqual(["Market", "Buy when", "Sell when", "Stands aside", "Size per trade"]);
    expect(rows[0]!.lines).toEqual(["ETH / USDG"]);
    expect(rows[1]!.lines).toEqual(["RSI is below 30", "The 200-hour trend is rising"]);
    expect(rows[2]!.lines).toEqual(["Take profit at +8%", "Stop loss at −4%"]);
    expect(rows[3]!.lines).toEqual(["When headline sentiment is negative (not checked yet)", "When the market is classed as stressed"]);
    expect(rows[4]!.lines).toEqual(["25% of cash"]);
  });
  it("describes a schedule for dca", () => {
    const rows = describePlan({ ...plan, kind: "dca", entry: [], cadenceHours: 168 });
    expect(rows[1]!.lines).toEqual(["Buys every week"]);
  });
});

describe("planChecks", () => {
  it("mirrors the prototype's checklist", () => {
    expect(planChecks(plan, 35).every((c) => c.pass)).toBe(true);
    const risky = planChecks({ ...plan, filters: [], sizePctOfCash: 50, exit: { takeProfitPct: 8 } }, 35);
    expect(risky.map((c) => c.pass)).toEqual([true, false, false, false]);
    expect(risky[3]!.label).toBe("Risk per trade is 35% or less");
  });
});
