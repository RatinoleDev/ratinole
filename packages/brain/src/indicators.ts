/**
 * Price indicators. Every function is causal: the value at index i uses only
 * inputs at indices <= i, so a backtest that precomputes a series over all
 * candles never sees the future. Entries without enough history are null.
 */

export type Series = (number | null)[];

function nulls(n: number): Series {
  return new Array<number | null>(n).fill(null);
}

/** Simple moving average over `w` values. */
export function sma(values: readonly number[], w: number): Series {
  const out = nulls(values.length);
  if (w < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= w) sum -= values[i - w]!;
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

/** Relative strength index with Wilder smoothing. */
export function rsi(closes: readonly number[], w = 14): Series {
  const out = nulls(closes.length);
  if (w < 1 || closes.length <= w) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= w; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / w;
  let avgLoss = loss / w;
  const value = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[w] = value();
  for (let i = w + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (w - 1) + Math.max(d, 0)) / w;
    avgLoss = (avgLoss * (w - 1) + Math.max(-d, 0)) / w;
    out[i] = value();
  }
  return out;
}

/** Hourly log returns; index 0 is null. */
export function logReturns(closes: readonly number[]): Series {
  const out = nulls(closes.length);
  for (let i = 1; i < closes.length; i++) out[i] = Math.log(closes[i]! / closes[i - 1]!);
  return out;
}

/** Sample standard deviation of the last `w` non-null values ending at i. */
export function rollingStd(values: Series, w: number): Series {
  const out = nulls(values.length);
  if (w < 2) return out;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null) {
      sum += v;
      sumSq += v * v;
      count++;
    }
    const drop = i - w >= 0 ? values[i - w] : null;
    if (drop != null) {
      sum -= drop;
      sumSq -= drop * drop;
      count--;
    }
    if (count === w) {
      const mean = sum / w;
      const variance = Math.max(0, (sumSq - w * mean * mean) / (w - 1));
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

/** Highest value over the last `w` values ending at i (monotonic deque, O(n)). */
export function rollingMax(values: readonly number[], w: number): Series {
  const out = nulls(values.length);
  const dq: number[] = [];
  for (let i = 0; i < values.length; i++) {
    while (dq.length && values[dq[dq.length - 1]!]! <= values[i]!) dq.pop();
    dq.push(i);
    if (dq[0]! <= i - w) dq.shift();
    if (i >= w - 1) out[i] = values[dq[0]!]!;
  }
  return out;
}

/** Percent change of a series over `lag` steps. */
export function pctChange(values: Series, lag: number): Series {
  const out = nulls(values.length);
  for (let i = lag; i < values.length; i++) {
    const a = values[i - lag];
    const b = values[i];
    if (a != null && b != null && a !== 0) out[i] = (b / a - 1) * 100;
  }
  return out;
}

/** Mean of the `w` values before i (excluding i). */
export function trailingMeanExcl(values: readonly number[], w: number): Series {
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i >= w) out[i] = sum / w;
    sum += values[i]!;
    if (i >= w) sum -= values[i - w]!;
  }
  return out;
}
