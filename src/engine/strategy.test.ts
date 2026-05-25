import { describe, it, expect } from 'vitest';
import { decide, type StrategyConfig } from './strategy.js';
import type { TrendReading } from '../indicators/index.js';

const cfg: StrategyConfig = {
  baseDailyUsd: 50,
  extraDailyUsd: 25,
  dailyCapUsd: 100,
  tpPct: 0.2,
  sellFraction: 0.25,
};

const watchlist = [
  { symbol: 'BTC/USD', basePct: 0.6 },
  { symbol: 'ETH/USD', basePct: 0.4 },
];

function trend(regime: TrendReading['regime'], price = 50000, rsi = 55): TrendReading {
  return { regime, price, sma50: 0, sma200: 0, rsi };
}

describe('decide / sizing', () => {
  it('neutral regime: base + 1x extra, no cap binding', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('neutral'), 'ETH/USD': trend('neutral') },
      positions: {},
      cfg,
    });
    const btc = intents.find((i) => i.symbol === 'BTC/USD')!;
    const eth = intents.find((i) => i.symbol === 'ETH/USD')!;
    // BTC: 0.6 * (50 + 25*1) = 45 ; ETH: 0.4 * 75 = 30
    expect(btc.notional).toBe(45);
    expect(eth.notional).toBe(30);
  });

  it('downtrend halves the extra add', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {},
      cfg,
    });
    const btc = intents.find((i) => i.symbol === 'BTC/USD')!;
    // 0.6 * (50 + 25*0.5) = 0.6 * 62.5 = 37.50
    expect(btc.notional).toBe(37.5);
  });

  it('uptrend uses 1.5x and may bind the daily cap', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('uptrend'), 'ETH/USD': trend('uptrend') },
      positions: {},
      cfg,
    });
    // pre-cap: 0.6*(50+37.5) + 0.4*(50+37.5) = 87.5 -> under 100, no cap
    const sum = intents.reduce((a, i) => a + (i.notional ?? 0), 0);
    expect(sum).toBeCloseTo(87.5, 1);

    // Now force a cap by raising extra
    const big = decide({
      watchlist,
      trends: { 'BTC/USD': trend('uptrend'), 'ETH/USD': trend('uptrend') },
      positions: {},
      cfg: { ...cfg, extraDailyUsd: 100 },
    });
    const capped = big.reduce((a, i) => a + (i.notional ?? 0), 0);
    expect(capped).toBeLessThanOrEqual(cfg.dailyCapUsd + 0.01);
  });
});

describe('decide / sell rule', () => {
  it('does NOT sell at profit while regime is neutral', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('neutral'), 'ETH/USD': trend('neutral') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.01, avgCost: 30000, lastPrice: 50000 },
      },
      cfg,
    });
    expect(intents.find((i) => i.side === 'sell')).toBeUndefined();
  });

  it('sells 25% of qty when avg-cost gain >= 20% AND regime is downtrend', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.02, avgCost: 30000, lastPrice: 40000 }, // +33%
      },
      cfg,
    });
    const sell = intents.find((i) => i.side === 'sell' && i.symbol === 'BTC/USD');
    expect(sell).toBeDefined();
    expect(sell!.qty).toBeCloseTo(0.005, 6);
  });

  it('does not sell when gain is below TP threshold', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.02, avgCost: 30000, lastPrice: 33000 }, // +10%
      },
      cfg,
    });
    expect(intents.find((i) => i.side === 'sell')).toBeUndefined();
  });
});
