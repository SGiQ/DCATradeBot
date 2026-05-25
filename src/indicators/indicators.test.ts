import { describe, it, expect } from 'vitest';
import { sma, rsi14, classifyTrend } from './index.js';

describe('sma', () => {
  it('averages the last N values', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it('returns NaN when input is too short', () => {
    expect(Number.isNaN(sma([1, 2], 5))).toBe(true);
  });
});

describe('rsi14', () => {
  it('returns 100 when there are no losses', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi14(rising)).toBe(100);
  });
  it('falls below 50 on a sustained downtrend', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 200 - i);
    expect(rsi14(falling)).toBeLessThan(50);
  });
  it('matches the canonical Wilder example within tolerance', () => {
    // First 15 closes from Wilder's "New Concepts" RSI example: 14 changes,
    // no smoothing iterations -> documented value is ~70.53.
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
    ];
    const r = rsi14(closes);
    expect(r).toBeGreaterThan(70);
    expect(r).toBeLessThan(71);
  });
});

describe('classifyTrend', () => {
  it('returns uptrend when price > sma50 > sma200 and rsi > 50', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5);
    const t = classifyTrend(closes);
    expect(t.regime).toBe('uptrend');
    expect(t.sma50).toBeGreaterThan(t.sma200);
  });
  it('returns downtrend on a clean monotonic decline', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 500 - i * 0.5);
    expect(classifyTrend(closes).regime).toBe('downtrend');
  });
  it('returns neutral when there is not enough data', () => {
    const closes = Array.from({ length: 50 }, () => 100);
    expect(classifyTrend(closes).regime).toBe('neutral');
  });
});
