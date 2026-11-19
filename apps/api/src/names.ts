/** Default agent names, used in order when the user gives none. */
export const AGENT_NAMES = [
  "Meridian",
  "Larkspur",
  "Northing",
  "Calloway",
  "Ember Bay",
  "Solstice",
  "Halcyon",
  "Tidewater",
  "Kestrel",
  "Quiet Harbor",
  "Longshore",
  "Wayfarer",
];

export function pickName(taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = AGENT_NAMES.find((n) => !used.has(n.toLowerCase()));
  return free ?? `Agent ${taken.length + 1}`;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 32 || !/^[\p{L}\p{N} .'-]+$/u.test(n)) return null;
  return n;
}
