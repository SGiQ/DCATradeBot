import { SimBroker, type SimBrokerConfig } from './broker.js';
import { getDailyBarsCached } from './barFetcher.js';
import { classifyTrend, type TrendReading } from '../indicators/index.js';
import {
  decide,
  type Intent,
  type PositionSnapshot,
  type StrategyConfig,
  type WatchlistEntry,
} from '../engine/strategy.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

export interface BacktestConfig {
  symbols: string[];          // e.g. ['BTC/USD', 'ETH/USD']
  basePcts: Record<string, number>; // {'BTC/USD': 0.6, 'ETH/USD': 0.4}
  start: string;              // ISO 8601
  end: string;
  startingCash: number;       // user's initial paper balance
  dailyDeposit: number;       // 0 = pure starting capital; 50 = $50/day inflow
  feeRate: number;            // 0.0015 default
  strategy: StrategyConfig;   // base/extra/cap, TP, sell fraction, stop-loss
}

export interface BacktestResult {
  config: BacktestConfig;
  startEquity: number;
  finalEquity: number;
  totalDeposited: number;
  netReturnPct: number;              // (finalEquity - totalDeposited) / totalDeposited
  rawReturnPct: number;              // (finalEquity - startingCash) / startingCash (ignores deposits)
  maxDrawdownPct: number;
  totalBuys: number;
  totalSells: number;
  closedTradeCount: number;
  totalRealizedPnl: number;
  benchmarks: {
    naiveDca: { finalValue: number; netReturnPct: number; maxDdPct: number };
    lumpSum6040: { finalValue: number; netReturnPct: number; maxDdPct: number };
    btcHodl: { finalValue: number; netReturnPct: number; maxDdPct: number };
    ethHodl: { finalValue: number; netReturnPct: number; maxDdPct: number };
  };
  equityCurve: Array<{
    t: string;
    equity: number;
    deposited: number;
    drawdown: number;
    naiveDca: number;
    lumpSum6040: number;
    btcHodl: number;
    ethHodl: number;
  }>;
  trades: Array<{
    symbol: string; entryAt: string; exitAt: string;
    avgEntryPrice: number; exitPrice: number; qty: number;
    realizedPnl: number;
  }>;
}

function barsUpTo(bars: CryptoBar[], asOf: string): CryptoBar[] {
  // Binary search for last bar with t <= asOf
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.t <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

function maxDdOfSeries(values: number[]): number {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Replay DCATradeBot's strategy day-by-day over historical bars.
 *
 * Per tick:
 *   1. Daily deposit added to cash (models $50/day inflow if configured)
 *   2. Fill any orders queued previous tick at THIS bar's open
 *   3. Slice bars up to today, classifyTrend per symbol
 *   4. Build PositionSnapshot for each symbol (last price = today's close)
 *   5. Call live decide() — same function the production cron uses
 *   6. Queue accepted intents to fill at next tick's open
 *   7. Mark to market with today's close for the equity curve
 *
 * Benchmarks computed in parallel:
 *   - naiveDca: $X/day fixed split 60/40, no overlay, no sells
 *   - lumpSum6040: same total deposits, but ALL invested at first bar
 *   - btcHodl / ethHodl: 100% allocation in each
 */
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  // 1. Pre-fetch bars for each symbol
  const bars: Record<string, CryptoBar[]> = {};
  for (const symbol of cfg.symbols) {
    bars[symbol] = await getDailyBarsCached(symbol, cfg.start, cfg.end);
  }

  // 2. Build unified tick timeline (union of daily bar timestamps)
  const tickSet = new Set<string>();
  for (const symbol of cfg.symbols) {
    for (const b of bars[symbol] ?? []) tickSet.add(b.t);
  }
  const ticks = Array.from(tickSet).sort();

  // 3. First-bar prices for benchmark setup
  const firstClose: Record<string, number> = {};
  for (const symbol of cfg.symbols) {
    const firstBar = bars[symbol]?.[0];
    if (firstBar) firstClose[symbol] = firstBar.c;
  }
  const btcStart = firstClose['BTC/USD'] ?? 1;
  const ethStart = firstClose['ETH/USD'] ?? 1;

  // ---- The strategy broker ----
  const brokerCfg: SimBrokerConfig = {
    startingCash: cfg.startingCash,
    dailyDeposit: cfg.dailyDeposit,
    feeRate: cfg.feeRate,
  };
  const broker = new SimBroker(brokerCfg);

  // ---- Naive-DCA benchmark broker (no overlay, no sells, no extras) ----
  const naiveBroker = new SimBroker(brokerCfg);

  // ---- Lump-sum: invests TOTAL deposits at start at 60/40 split ----
  // Total deposits = startingCash + dailyDeposit × ticks (predictable)
  const totalDeposits = cfg.startingCash + cfg.dailyDeposit * ticks.length;
  const lumpBtcUnits = (totalDeposits * (cfg.basePcts['BTC/USD'] ?? 0.6)) / btcStart;
  const lumpEthUnits = (totalDeposits * (cfg.basePcts['ETH/USD'] ?? 0.4)) / ethStart;

  // 100%-HODL benchmarks: same total deposits, all in one symbol
  const btcHodlUnits = totalDeposits / btcStart;
  const ethHodlUnits = totalDeposits / ethStart;

  // For computing max-DD on each benchmark we need a running series
  const naiveDcaSeries: number[] = [];
  const lumpSum6040Series: number[] = [];
  const btcHodlSeries: number[] = [];
  const ethHodlSeries: number[] = [];

  let totalBuys = 0;
  let totalSells = 0;

  for (const tickT of ticks) {
    // 1. Deposit + 2. Fill pending orders at today's open
    broker.depositDailyCash();
    naiveBroker.depositDailyCash();
    for (const symbol of cfg.symbols) {
      const dailyBars = bars[symbol] ?? [];
      const todayBar = dailyBars.find((b) => b.t === tickT);
      if (!todayBar) continue;
      broker.fillPendingAtOpen(symbol, todayBar);
      naiveBroker.fillPendingAtOpen(symbol, todayBar);
    }

    // 3. Build per-symbol trends + position snapshots
    const trends: Record<string, TrendReading> = {};
    const positionSnaps: Record<string, PositionSnapshot> = {};
    const currentPrices: Record<string, number> = {};
    for (const symbol of cfg.symbols) {
      const sliced = barsUpTo(bars[symbol] ?? [], tickT);
      const closes = sliced.map((b) => b.c);
      const today = classifyTrend(closes);
      // prevSma50/200: re-classify bars up to yesterday so decide() can detect
      // the textbook death-cross (sma50 was >= sma200, today is <)
      const prev = closes.length > 1 ? classifyTrend(closes.slice(0, -1)) : undefined;
      trends[symbol] = { ...today, prevSma50: prev?.sma50, prevSma200: prev?.sma200 };

      const todayBar = sliced[sliced.length - 1];
      if (!todayBar) continue;
      currentPrices[symbol] = todayBar.c;

      const pos = broker.positionFor(symbol);
      if (pos) {
        positionSnaps[symbol] = {
          symbol, qty: pos.qty, avgCost: pos.avgCost, lastPrice: todayBar.c,
        };
      }
    }

    // 4. Watchlist mirrors live config
    const watchlist: WatchlistEntry[] = cfg.symbols.map((s) => ({
      symbol: s,
      basePct: cfg.basePcts[s] ?? 0,
    }));

    // 5. Call the LIVE decide() — identical to production behavior
    const intents: Intent[] = decide({
      watchlist,
      trends,
      positions: positionSnaps,
      cfg: cfg.strategy,
      availableCash: broker.cash, // for golden-cross lump redeploy
    });

    // 6. Queue strategy orders
    for (const intent of intents) {
      broker.enqueueOrder({
        symbol: intent.symbol,
        side: intent.side,
        notional: intent.notional,
        qty: intent.qty,
        reason: intent.reason,
        decidedAt: tickT,
      });
      if (intent.side === 'buy') totalBuys++;
      else totalSells++;
    }

    // 6b. Naive DCA: ALWAYS fixed $X/day at 60/40, no overlay, no sells
    if (cfg.dailyDeposit > 0) {
      for (const w of watchlist) {
        const notional = w.basePct * cfg.dailyDeposit;
        if (notional > 0) {
          naiveBroker.enqueueOrder({
            symbol: w.symbol,
            side: 'buy',
            notional,
            reason: 'naive-dca',
            decidedAt: tickT,
          });
        }
      }
    }

    // 7. Mark to market
    broker.recordEquity(tickT, currentPrices);
    naiveBroker.recordEquity(tickT, currentPrices);

    // Track benchmark equity series for max-DD
    const btcPx = currentPrices['BTC/USD'] ?? btcStart;
    const ethPx = currentPrices['ETH/USD'] ?? ethStart;
    naiveDcaSeries.push(naiveBroker.equity());
    lumpSum6040Series.push((lumpBtcUnits * btcPx) + (lumpEthUnits * ethPx));
    btcHodlSeries.push(btcHodlUnits * btcPx);
    ethHodlSeries.push(ethHodlUnits * ethPx);
  }

  // ---- Build result ----
  const finalEquity = broker.equity();
  const totalDeposited = broker.totalDeposited;
  const totalRealizedPnl = broker.closedTrades.reduce((a, t) => a + t.realizedPnl, 0);

  const naiveFinal = naiveDcaSeries[naiveDcaSeries.length - 1] ?? cfg.startingCash;
  const lumpFinal = lumpSum6040Series[lumpSum6040Series.length - 1] ?? cfg.startingCash;
  const btcFinal = btcHodlSeries[btcHodlSeries.length - 1] ?? cfg.startingCash;
  const ethFinal = ethHodlSeries[ethHodlSeries.length - 1] ?? cfg.startingCash;

  const equityCurve = broker.equityCurve.map((e, i) => ({
    t: e.timestamp,
    equity: e.equity,
    deposited: e.totalDeposited,
    drawdown: e.drawdownPct,
    naiveDca: naiveDcaSeries[i] ?? cfg.startingCash,
    lumpSum6040: lumpSum6040Series[i] ?? cfg.startingCash,
    btcHodl: btcHodlSeries[i] ?? cfg.startingCash,
    ethHodl: ethHodlSeries[i] ?? cfg.startingCash,
  }));

  return {
    config: cfg,
    startEquity: cfg.startingCash,
    finalEquity,
    totalDeposited,
    netReturnPct: (finalEquity - totalDeposited) / totalDeposited,
    rawReturnPct: (finalEquity - cfg.startingCash) / cfg.startingCash,
    maxDrawdownPct: broker.maxDrawdownPct(),
    totalBuys,
    totalSells,
    closedTradeCount: broker.closedTrades.length,
    totalRealizedPnl,
    benchmarks: {
      naiveDca: {
        finalValue: naiveFinal,
        netReturnPct: (naiveFinal - totalDeposited) / totalDeposited,
        maxDdPct: maxDdOfSeries(naiveDcaSeries),
      },
      lumpSum6040: {
        finalValue: lumpFinal,
        netReturnPct: (lumpFinal - totalDeposited) / totalDeposited,
        maxDdPct: maxDdOfSeries(lumpSum6040Series),
      },
      btcHodl: {
        finalValue: btcFinal,
        netReturnPct: (btcFinal - totalDeposited) / totalDeposited,
        maxDdPct: maxDdOfSeries(btcHodlSeries),
      },
      ethHodl: {
        finalValue: ethFinal,
        netReturnPct: (ethFinal - totalDeposited) / totalDeposited,
        maxDdPct: maxDdOfSeries(ethHodlSeries),
      },
    },
    equityCurve,
    trades: broker.closedTrades.map((t) => ({
      symbol: t.symbol, entryAt: t.entryAt, exitAt: t.exitAt,
      avgEntryPrice: t.avgEntryPrice, exitPrice: t.exitPrice, qty: t.qty,
      realizedPnl: t.realizedPnl,
    })),
  };
}
