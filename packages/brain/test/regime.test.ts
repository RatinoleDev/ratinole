import { describe, expect, it } from "vitest";
import { classifyRegime, regimeWarmup } from "../src/regime";
import { SeriesSource } from "../src/signals";
import { fromCloses, realEth, rng, walk } from "./helpers";

function sine(n: number, seed = 1): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => 1000 * (1 + 0.01 * Math.sin((2 * Math.PI * i) / 48)) * (1 + (r() - 0.5) * 0.002));
}

describe("classifyRegime", () => {
  it("returns null without enough history", () => {
    const src = new SeriesSource(walk(100));
    expect(classifyRegime(src, 99)).toBeNull();
    expect(regimeWarmup()).toBeGreaterThan(200);
  });

  it("classes a steady climb as trending up", () => {
    const src = new SeriesSource(walk(900, { drift: 0.001, vol: 0.003 }));
    const r = classifyRegime(src, 899)!;
    expect(r.regime).toBe("trending");
    expect(r.direction).toBe("up");
    expect(r.reason).toMatch(/rising/);
  });

  it("classes a steady fall as trending down", () => {
    const src = new SeriesSource(walk(900, { drift: -0.001, vol: 0.003 }));
    expect(classifyRegime(src, 899)).toMatchObject({ regime: "trending", direction: "down" });
  });

  it("classes a sideways oscillation as ranging", () => {
    const src = new SeriesSource(fromCloses(sine(900)));
    expect(classifyRegime(src, 899)!.regime).toBe("ranging");
  });

  it("classes a volatility burst as stressed", () => {
    const calm = sine(880);
    const r = rng(9);
    let p = calm[calm.length - 1]!;
    for (let k = 0; k < 24; k++) {
      p *= 1 + (r() - 0.5) * 0.08;
      calm.push(p);
    }
    const src = new SeriesSource(fromCloses(calm));
    const out = classifyRegime(src, calm.length - 1)!;
    expect(out.regime).toBe("stressed");
    expect(out.volRatio).toBeGreaterThanOrEqual(2);
  });

  it("classes a sharp drop from the day's high as stressed", () => {
    const closes = sine(880);
    let p = closes[closes.length - 1]!;
    for (let k = 0; k < 20; k++) {
      p *= 0.995;
      closes.push(p);
    }
    const out = classifyRegime(new SeriesSource(fromCloses(closes)), closes.length - 1)!;
    expect(out.regime).toBe("stressed");
    expect(out.fromHighPct).toBeLessThanOrEqual(-8);
  });

  it("finds all three regimes in real ETH history, with none dominating completely", () => {
    const candles = realEth();
    const src = new SeriesSource(candles);
    const counts = { trending: 0, ranging: 0, stressed: 0 };
    for (let i = 800; i < candles.length; i++) counts[classifyRegime(src, i)!.regime]++;
    const total = candles.length - 800;
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) {
      expect(counts[k] / total).toBeGreaterThan(0.01);
      expect(counts[k] / total).toBeLessThan(0.95);
    }
  });
});
