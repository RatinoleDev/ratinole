/**
 * Plain warnings shown next to backtest numbers. A handful of trades cannot
 * separate skill from luck, and a tuner that picked "never trade" should say so.
 * Trade counts are fills: a buy and its sell count as two.
 */
export const MIN_FILLS_TO_JUDGE = 10;

export function backtestWarnings(r: { tunedTrades: number; unseenTrades: number }): string[] {
  const out: string[] = [];
  if (r.tunedTrades === 0) {
    out.push("No trades on the tuning days: every setting that traded did worse than standing aside, so the tuner chose the strictest one.");
  }
  if (r.unseenTrades === 0) {
    out.push("No trades on the unseen days, so there is nothing to judge yet.");
  } else if (r.unseenTrades < MIN_FILLS_TO_JUDGE) {
    out.push(
      `Only ${r.unseenTrades} buy${r.unseenTrades === 1 ? "" : "s and sells"} on the unseen days: too few to tell skill from luck. Treat the result as a rough guide.`,
    );
  }
  return out;
}
