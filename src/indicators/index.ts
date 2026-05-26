export type Regime = 'uptrend' | 'neutral' | 'downtrend';

export interface TrendReading {
  regime: Regime;
  price: number;
  sma50: number;
  sma200: number;
  rsi: number;
  // Yesterday's SMA values, when known. Lets strategy.decide() detect the
  // textbook death-cross (sma50 was >= sma200, today is <) without becoming
  // stateful. Optional so callers without history can omit them.
  prevSma50?: number;
  prevSma200?: number;
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
// SMA periods. Field names in TrendReading are still sma50/sma200 (legacy
// names) but the values come from these periods. Faster periods catch
// regime changes earlier (good for cross signals) at the cost of more
// whipsaws. Empirical sweep over BTC/ETH 2022-2026 found 30/90 dominant on
// every metric: highest return, lowest drawdown, best return/DD ratio.
// 8/21 was too noisy (78 sells in 4 years); 50/200 too lagging.
// Overridable via env for re-tuning on different data.
export const SMA_FAST_PERIOD = Number(process.env.SMA_FAST_PERIOD ?? 30);
export const SMA_SLOW_PERIOD = Number(process.env.SMA_SLOW_PERIOD ?? 90);

export function classifyTrend(closes: number[]): TrendReading {
  const price = closes[closes.length - 1] ?? Number.NaN;
  const s50 = sma(closes, SMA_FAST_PERIOD);
  const s200 = sma(closes, SMA_SLOW_PERIOD);
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
