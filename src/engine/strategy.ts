import type { Regime, TrendReading } from '../indicators/index.js';

export interface WatchlistEntry {
  symbol: string;
  basePct: number; // 0..1
}

export interface PositionSnapshot {
  symbol: string;
  qty: number;
  avgCost: number;
  lastPrice: number;
}

export interface StrategyConfig {
  baseDailyUsd: number;
  extraDailyUsd: number;
  dailyCapUsd: number;
  tpPct: number;       // 0.20 = 20% gain → take-profit trigger
  sellFraction: number; // 0..1 fraction of position to sell on TP
  stopLossPct: number; // 0.15 = exit full position at -15% loss
}

export interface Intent {
  symbol: string;
  side: 'buy' | 'sell';
  notional?: number;
  qty?: number;
  reason: string;
}

const TREND_MULT: Record<Regime, number> = {
  downtrend: 0.5,
  neutral: 1.0,
  uptrend: 1.5,
};

/**
 * Pure decide() — no IO. The caller fetches bars/positions/trend and passes
 * snapshots in; this returns the list of intents to execute.
 *
 * Sizing rules:
 *   buy_base  = basePct * BASE_DAILY_USD                 (always for each symbol)
 *   buy_extra = basePct * EXTRA_DAILY_USD * mult(regime) (scaled by trend)
 *   total per-symbol = base + extra
 *   sum of totals is capped by DAILY_CAP_USD (pro-rata reduction if exceeded)
 *
 * Sell rule:
 *   if position avg-cost gain >= TP_PCT AND regime == 'downtrend':
 *     sell SELL_FRACTION of qty (qty-based, lets broker compute notional)
 */
export function decide(input: {
  watchlist: WatchlistEntry[];
  trends: Record<string, TrendReading>;
  positions: Record<string, PositionSnapshot>;
  cfg: StrategyConfig;
}): Intent[] {
  const { watchlist, trends, positions, cfg } = input;
  const buys: Intent[] = [];

  for (const w of watchlist) {
    const trend = trends[w.symbol];
    if (!trend) continue;
    const mult = TREND_MULT[trend.regime];
    const base = w.basePct * cfg.baseDailyUsd;
    const extra = w.basePct * cfg.extraDailyUsd * mult;
    const total = base + extra;
    if (total <= 0) continue;
    buys.push({
      symbol: w.symbol,
      side: 'buy',
      notional: round2(total),
      reason:
        `dca base=${base.toFixed(2)} + extra=${extra.toFixed(2)} ` +
        `(regime=${trend.regime}, mult=${mult}x, rsi=${trend.rsi.toFixed(1)})`,
    });
  }

  // Pro-rata cap on total daily spend
  const sum = buys.reduce((a, i) => a + (i.notional ?? 0), 0);
  if (sum > cfg.dailyCapUsd && sum > 0) {
    const scale = cfg.dailyCapUsd / sum;
    for (const i of buys) {
      if (i.notional !== undefined) i.notional = round2(i.notional * scale);
      i.reason += ` [capped x${scale.toFixed(3)}]`;
    }
  }

  // Sell rules: stop-loss takes priority over take-profit
  const sells: Intent[] = [];
  const symbolsWithSell = new Set<string>();

  for (const w of watchlist) {
    const pos = positions[w.symbol];
    const trend = trends[w.symbol];
    if (!pos || !trend) continue;
    if (pos.qty <= 0 || pos.avgCost <= 0) continue;

    const pnlPct = (pos.lastPrice - pos.avgCost) / pos.avgCost;

    // Stop-loss: full exit, overrides everything else for this symbol
    if (pnlPct <= -cfg.stopLossPct) {
      const sellQty = round8(pos.qty);
      if (sellQty > 0) {
        sells.push({
          symbol: w.symbol,
          side: 'sell',
          qty: sellQty,
          reason:
            `stop-loss: loss=${(pnlPct * 100).toFixed(1)}% <= -${(cfg.stopLossPct * 100).toFixed(0)}%; ` +
            `full exit`,
        });
        symbolsWithSell.add(w.symbol);
      }
      continue; // skip TP evaluation for this symbol
    }

    // Take-profit: partial exit only in downtrend
    if (pnlPct >= cfg.tpPct && trend.regime === 'downtrend') {
      const sellQty = round8(pos.qty * cfg.sellFraction);
      if (sellQty > 0) {
        sells.push({
          symbol: w.symbol,
          side: 'sell',
          qty: sellQty,
          reason:
            `tp: gain=${(pnlPct * 100).toFixed(1)}% >= ${(cfg.tpPct * 100).toFixed(0)}% ` +
            `and regime=downtrend; sell ${(cfg.sellFraction * 100).toFixed(0)}% of qty`,
        });
        symbolsWithSell.add(w.symbol);
      }
    }
  }

  // Deduplicate: drop any buy intent for a symbol that already has a sell this run.
  // Buying and selling the same symbol in one run wastes fees and distorts cost basis.
  const filteredBuys = buys.filter((b) => !symbolsWithSell.has(b.symbol));

  return [...filteredBuys, ...sells];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
