import type { CSSProperties } from "react";

/** Inline CSS custom properties, e.g. cssVars({ "--p": "71%" }). */
export function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties;
}

/** Style for an evidence bar: width = |score|%, gain colour for positive, loss for negative. */
export function barStyle(score: number): CSSProperties {
  const w = Math.min(100, Math.abs(Math.round(score)));
  return cssVars({ "--p": `${w}%`, "--c": score >= 0 ? "var(--gain)" : "var(--loss)" });
}
