import type { Action, Regime } from "@rationale/brain";

const MINUS = "−";

/** "+3.8%" / "−2.9%" with a true minus sign, as in the prototype. */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${v > 0 ? "+" : MINUS}${s}%`;
}

/** Signed number without a unit, e.g. evidence scores "+82" / "−91". */
export function signed(v: number): string {
  if (v === 0) return "0";
  return `${v > 0 ? "+" : MINUS}${Math.abs(v)}`;
}

export function usd(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? MINUS : ""}$${s}`;
}

export function upDown(v: number | null | undefined): "up" | "down" | "" {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "up" : "down";
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 19 Nov, 11:00 UTC" */
export function hourLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

export function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function actionLabel(a: Action): string {
  return a === "buy" ? "Buy" : a === "sell" ? "Sell" : "Hold";
}

/** Pill class for an action, as in the prototype's tag(). */
export function actionTag(a: Action): "gain" | "loss" | "plain" {
  return a === "buy" ? "gain" : a === "sell" ? "loss" : "plain";
}

export function regimeLabel(r: Regime): string {
  return r === "trending" ? "Trending" : r === "ranging" ? "Ranging" : "Stressed";
}

/** Splits text into sentences on ". ", "! " or "? ". */
function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i === text.length - 1 || text[i + 1] === " ")) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * The most informative sentence of an explanation for one-line use: skips a
 * leading one- or two-word sentence such as "Hold." and trims to `max` characters.
 */
export function leadSentence(text: string, max = 96): string {
  const parts = sentences(text);
  let s = parts[0] ?? "";
  if (parts.length > 1 && s.split(" ").length <= 2) s = parts[1] ?? s;
  return truncate(s, max);
}

/** Explanation without its leading action word ("Hold. …" becomes "…"). */
export function withoutLeadingAction(text: string): string {
  for (const w of ["Buy.", "Sell.", "Hold."]) {
    if (text.startsWith(w)) return text.slice(w.length).trimStart();
  }
  return text;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
