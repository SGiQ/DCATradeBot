import { describe, it, expect } from 'vitest';
import { decide, type StrategyConfig } from './strategy.js';
import type { TrendReading } from '../indicators/index.js';

const cfg: StrategyConfig = {
  baseDailyUsd: 50,
  extraDailyUsd: 25,
  dailyCapUsd: 100,
  tpPct: 0.2,
  sellFraction: 0.25,
  stopLossPct: 0.15,
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
    const btc = intents.find((i) => i.symbol === 'BTC/USD' && i.side === 'buy')!;
    expect(btc.notional).toBe(37.5);
  });

  it('uptrend uses 1.5x and may bind the daily cap', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('uptrend'), 'ETH/USD': trend('uptrend') },
      positions: {},
      cfg,
    });
    const sum = intents.reduce((a, i) => a + (i.notional ?? 0), 0);
    expect(sum).toBeCloseTo(87.5, 1);

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

describe('decide / take-profit sell rule', () => {
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

  it('sells 25% of qty when gain >= 20% AND regime is downtrend', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.02, avgCost: 30000, lastPrice: 40000 },
      },
      cfg,
    });
    const sell = intents.find((i) => i.side === 'sell' && i.symbol === 'BTC/USD');
    expect(sell).toBeDefined();
    expect(sell!.qty).toBeCloseTo(0.005, 6);
    expect(sell!.reason).toContain('tp:');
  });

  it('does not sell when gain is below TP threshold', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.02, avgCost: 30000, lastPrice: 33000 },
      },
      cfg,
    });
    expect(intents.find((i) => i.side === 'sell')).toBeUndefined();
  });
});

describe('decide / stop-loss', () => {
  it('exits full position when loss exceeds STOP_LOSS_PCT', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('uptrend'), 'ETH/USD': trend('neutral') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.05, avgCost: 50000, lastPrice: 40000 }, // -20%
      },
      cfg,
    });
    const sell = intents.find((i) => i.side === 'sell' && i.symbol === 'BTC/USD');
    expect(sell).toBeDefined();
    expect(sell!.qty).toBeCloseTo(0.05, 6); // full exit
    expect(sell!.reason).toContain('stop-loss');
  });

  it('does NOT trigger stop-loss when loss is below threshold', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('neutral') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.05, avgCost: 50000, lastPrice: 45000 }, // -10%
      },
      cfg,
    });
    const stopSell = intents.find(
      (i) => i.side === 'sell' && i.symbol === 'BTC/USD' && i.reason?.includes('stop-loss'),
    );
    expect(stopSell).toBeUndefined();
  });

  it('stop-loss takes priority over take-profit when both conditions are met (edge case)', () => {
    // This shouldn't happen in practice (can't be up AND down 15%)
    // but tests that stop-loss is evaluated first and skips TP
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('neutral') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.05, avgCost: 50000, lastPrice: 40000 }, // -20% loss
      },
      cfg,
    });
    const sells = intents.filter((i) => i.side === 'sell' && i.symbol === 'BTC/USD');
    expect(sells).toHaveLength(1);
    expect(sells[0]!.reason).toContain('stop-loss');
  });
});

describe('decide / buy-sell deduplication', () => {
  it('drops the buy intent when a stop-loss sell is triggered for the same symbol', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('uptrend'), 'ETH/USD': trend('neutral') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.05, avgCost: 50000, lastPrice: 40000 }, // -20%
      },
      cfg,
    });
    // Should have a sell for BTC but NO buy for BTC
    expect(intents.find((i) => i.side === 'sell' && i.symbol === 'BTC/USD')).toBeDefined();
    expect(intents.find((i) => i.side === 'buy' && i.symbol === 'BTC/USD')).toBeUndefined();
    // ETH should still have a buy (no sell triggered for ETH)
    expect(intents.find((i) => i.side === 'buy' && i.symbol === 'ETH/USD')).toBeDefined();
  });

  it('drops the buy intent when a TP sell is triggered for the same symbol', () => {
    const intents = decide({
      watchlist,
      trends: { 'BTC/USD': trend('downtrend'), 'ETH/USD': trend('downtrend') },
      positions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 0.02, avgCost: 30000, lastPrice: 40000 }, // +33% → TP
      },
      cfg,
    });
    expect(intents.find((i) => i.side === 'sell' && i.symbol === 'BTC/USD')).toBeDefined();
    expect(intents.find((i) => i.side === 'buy' && i.symbol === 'BTC/USD')).toBeUndefined();
  });
});
