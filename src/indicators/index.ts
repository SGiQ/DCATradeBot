export type Regime = 'uptrend' | 'neutral' | 'downtrend';

export interface TrendReading {
  regime: Regime;
  price: number;
  sma50: number;
  sma200: number;
  rsi: number;
}

/** Simple moving average of the last `period` values. Returns NaN if too short. */
export function sma(values: number[], period: number): number {
  if (period <= 0) throw new Error('sma: period must be > 0');
  if (values.length < period) return Number.NaN;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i]!;
  }
  return sum / period;
}

/**
 * Wilder-smoothed RSI-14. Returns NaN if fewer than `period + 1` values.
 * Standard formulation: initial avg from first `period` changes, then EMA-style
 * smoothing with alpha = 1/period.
 */
export function rsi14(values: number[], period = 14): number {
  if (values.length < period + 1) return Number.NaN;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Classify daily trend regime.
 *
 * Uptrend:   price > sma50 > sma200 AND rsi > 50
 * Downtrend: price < sma50 < sma200 AND rsi < 50
 * Otherwise: neutral
 *
 * `closes` must be in chronological order (oldest first). Needs >= 201 closes
 * for both SMAs and RSI to be defined; otherwise returns regime 'neutral' with
 * whatever values can be computed.
 */
export function classifyTrend(closes: number[]): TrendReading {
  const price = closes[closes.length - 1] ?? Number.NaN;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r = rsi14(closes, 14);

  let regime: Regime = 'neutral';
  if (
    Number.isFinite(s50) &&
    Number.isFinite(s200) &&
    Number.isFinite(r) &&
    Number.isFinite(price)
  ) {
    if (price > s50 && s50 > s200 && r > 50) regime = 'uptrend';
    else if (price < s50 && s50 < s200 && r < 50) regime = 'downtrend';
  }

  return { regime, price, sma50: s50, sma200: s200, rsi: r };
}
