import { describe, it, expect } from 'vitest';
import { SimBroker } from './broker.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

const bar = (o: number, h: number, l: number, c: number, t = '2026-01-01T00:00:00Z'): CryptoBar =>
  ({ o, h, l, c, v: 1000, t });

const cfg = { startingCash: 5_000, dailyDeposit: 50, feeRate: 0.0015 };

describe('SimBroker / DCA fills', () => {
  it('buys at next bar open with weighted-average cost', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 30, reason: 'dca', decidedAt: '2026-01-01T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(100, 101, 99, 100, '2026-01-02T00:00:00Z'));
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0]!.qty).toBeCloseTo(0.3, 5);
    expect(b.positions[0]!.avgCost).toBe(100);

    // Second buy at higher price — avg cost should rise
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 60, reason: 'dca', decidedAt: '2026-01-02T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(200, 200, 200, 200, '2026-01-03T00:00:00Z'));
    expect(b.positions[0]!.qty).toBeCloseTo(0.6, 5);
    // avg = (30 + 60) / 0.6 = 90 / 0.6 = 150
    expect(b.positions[0]!.avgCost).toBeCloseTo(150, 2);
  });

  it('refuses a buy that exceeds available cash', () => {
    const b = new SimBroker({ ...cfg, startingCash: 10, dailyDeposit: 0 });
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 1000, reason: 'dca', decidedAt: '2026-01-01T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(100, 100, 100, 100));
    expect(b.positions).toHaveLength(0);
    expect(b.cash).toBe(10);
  });

  it('partial sells reduce qty but keep avgCost', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 100, reason: 'dca', decidedAt: '2026-01-01T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(100, 100, 100, 100, '2026-01-02T00:00:00Z'));
    expect(b.positions[0]!.qty).toBeCloseTo(1, 5);

    // Partial sell of 0.25
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'sell', qty: 0.25, reason: 'tp', decidedAt: '2026-01-02T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(150, 150, 150, 150, '2026-01-03T00:00:00Z'));
    expect(b.positions[0]!.qty).toBeCloseTo(0.75, 5);
    expect(b.positions[0]!.avgCost).toBe(100); // unchanged
    expect(b.closedTrades).toHaveLength(1);
    expect(b.closedTrades[0]!.realizedPnl).toBeGreaterThan(0);
  });

  it('full sell closes the position', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 100, reason: 'dca', decidedAt: '2026-01-01T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(100, 100, 100, 100, '2026-01-02T00:00:00Z'));
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'sell', qty: 1.0, reason: 'stop-loss', decidedAt: '2026-01-02T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(80, 80, 80, 80, '2026-01-03T00:00:00Z'));
    expect(b.positions).toHaveLength(0);
  });
});

describe('SimBroker / daily deposits', () => {
  it('depositDailyCash adds the configured amount to cash + totalDeposited', () => {
    const b = new SimBroker({ startingCash: 100, dailyDeposit: 50, feeRate: 0.0015 });
    expect(b.cash).toBe(100);
    expect(b.totalDeposited).toBe(100);
    b.depositDailyCash();
    expect(b.cash).toBe(150);
    expect(b.totalDeposited).toBe(150);
    b.depositDailyCash();
    expect(b.cash).toBe(200);
    expect(b.totalDeposited).toBe(200);
  });

  it('no deposit when dailyDeposit = 0', () => {
    const b = new SimBroker({ startingCash: 100, dailyDeposit: 0, feeRate: 0.0015 });
    b.depositDailyCash();
    expect(b.cash).toBe(100);
    expect(b.totalDeposited).toBe(100);
  });
});

describe('SimBroker / equity tracking', () => {
  it('marks to market with positions + drawdown', () => {
    const b = new SimBroker(cfg);
    b.enqueueOrder({ symbol: 'BTC/USD', side: 'buy', notional: 100, reason: 'dca', decidedAt: '2026-01-01T00:00:00Z' });
    b.fillPendingAtOpen('BTC/USD', bar(100, 101, 99, 100, '2026-01-02T00:00:00Z'));
    // Cash: 5000 - 100 - 0.15 = 4899.85; Position: 1 BTC @ 100 worth $110 at mark
    b.recordEquity('2026-01-02T00:00:00Z', { 'BTC/USD': 110 });
    expect(b.equity()).toBeCloseTo(4899.85 + 110, 2);
    // Mark at 80: drawdown shows
    b.recordEquity('2026-01-03T00:00:00Z', { 'BTC/USD': 80 });
    expect(b.maxDrawdownPct()).toBeLessThan(0);
  });
});
