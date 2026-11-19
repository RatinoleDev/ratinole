/**
 * Plain warnings shown next to backtest numbers. A handful of trades cannot
 * separate skill from luck, and a tuner that picked "never trade" should say so.
 * Trade counts are fills: a buy and its sell count as two.
 */
export const MIN_FILLS_TO_JUDGE = 10;

export function backtestWarnings(r: { tunedTrades: number; unseenTrades: number; tunedReturnPct?: number }): string[] {
  const out: string[] = [];
  if (r.tunedTrades === 0) {
    out.push("No trades on the tuning days: the entry rules never held, so there was nothing to tune.");
  } else if (r.tunedReturnPct != null && r.tunedReturnPct < 0) {
    out.push("It lost money on the tuning days even with the best settings the tuner found.");
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
