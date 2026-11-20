/** Amounts typed on the Vault page become raw token units here. Real money: it never rounds up and never guesses. */
import { parseAmount } from "@rationale/config";
import { describe, expect, it } from "vitest";

const raw = (text: string, decimals = 6) => {
  const p = parseAmount(text, decimals);
  return p.ok ? p.raw : null;
};
const why = (text: string, decimals = 6) => {
  const p = parseAmount(text, decimals);
  return p.ok ? "OK" : p.error;
};

describe("parseAmount", () => {
  it("reads plain amounts exactly", () => {
    expect(raw("100")).toBe(100_000_000n);
    expect(raw("0.5")).toBe(500_000n);
    expect(raw(".5")).toBe(500_000n);
    expect(raw("5.")).toBe(5_000_000n);
    expect(raw(" 12.34 ")).toBe(12_340_000n);
    expect(raw("007")).toBe(7_000_000n);
    expect(raw("0.000001")).toBe(1n);
    // 18 decimals, far past what a floating point number can hold exactly.
    expect(raw("123456789.123456789123456789", 18)).toBe(123456789123456789123456789n);
  });

  it("reads one comma as the decimal mark", () => {
    expect(raw("10,5")).toBe(10_500_000n);
    expect(raw(",5")).toBe(500_000n);
    expect(raw("0,500")).toBe(500_000n);
    expect(raw("1,25")).toBe(1_250_000n);
  });

  it("refuses what could be read two ways, and says why", () => {
    expect(why("1,000")).toBe("Is that 1.000 or 1000? Write it with a dot, or without the comma.");
    expect(why("12,500")).toMatch(/12\.500 or 12500/);
    expect(why("1,000.50")).toMatch(/without thousands separators/);
    expect(why("1,000,000")).toMatch(/without thousands separators/);
    expect(why("1.2.3")).toMatch(/one dot/);
  });

  it("refuses anything that is not an amount", () => {
    expect(why("")).toBeNull();
    expect(why("   ")).toBeNull();
    expect(why("abc")).toMatch(/digits only/);
    // A space between digits is never dropped: "1 5" must not become fifteen.
    expect(raw("1 5")).toBeNull();
    expect(why("1 5")).toBe("Write the amount without spaces, like 1000.50.");
    expect(why("10 000")).toMatch(/without spaces/);
    expect(why("1\t5")).toMatch(/without spaces/);
    expect(why("-5")).toMatch(/digits only/);
    expect(why("1e6")).toMatch(/digits only/);
    expect(why("0x10")).toMatch(/digits only/);
    expect(why(".")).toBe("Enter an amount.");
    expect(why("0")).toBe("Enter an amount above zero.");
    expect(why("0.00")).toBe("Enter an amount above zero.");
  });

  it("drops digits the token does not have, never rounding up, and says so", () => {
    const p = parseAmount("1.23456789", 6);
    expect(p).toEqual({ ok: true, raw: 1_234_567n, note: "Only 6 decimals count: using 1.234567." });
    expect(parseAmount("1.999999999", 6)).toMatchObject({ ok: true, raw: 1_999_999n });
    // Trailing zeros are not "dropped digits".
    expect(parseAmount("1.5000000000", 6)).toEqual({ ok: true, raw: 1_500_000n, note: null });
    expect(why("0.0000001")).toBe("That is smaller than the smallest amount of this token.");
  });

  it("gives back exactly what the Max button fills in", () => {
    for (const [units, decimals] of [[123_456_789n, 6], [1n, 8], [28_884_131_400_286_808n, 18], [5_000_000n, 6]] as const) {
      const base = 10n ** BigInt(decimals);
      const text = `${units / base}.${(units % base).toString().padStart(decimals, "0")}`;
      expect(raw(text, decimals)).toBe(units);
    }
  });
});
