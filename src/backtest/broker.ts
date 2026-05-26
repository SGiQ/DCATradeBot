import type { CryptoBar } from '../broker/alpacaCrypto.js';

/**
 * In-memory broker for DCATradeBot backtests.
 *
 * Differs from a typical broker simulator in two ways:
 * - Single-account / single-strategy: positions are tracked per-symbol
 *   only (DCA bot doesn't multiplex strategies the way AlphaStack does)
 * - Daily deposit support: each tick (day) can add a fixed amount of cash
 *   to model the user's $50/day external deposits — matches how the live
 *   bot is actually used over months
 *
 * No look-ahead bias: orders generated using bar T's close fill at bar
 * T+1's open. Stop-loss and take-profit are NOT modeled as intra-bar
 * triggers — the live DCA bot only re-evaluates once per day at the close,
 * so this backtest mirrors that: SL/TP exits fire next day at open.
 */

export interface SimPosition {
  symbol: string;
  qty: number;
  avgCost: number;
  totalCostBasis: number; // for weighted-average updates on subsequent buys
  openedAt: string;
}

export interface SimOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  notional?: number;
  qty?: number;
  reason: string;
  decidedAt: string;
}

export interface SimFill {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  notional: number;
  filledAt: string;
  reason: string;
}

export interface ClosedTrade {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  exitPrice: number;
  entryAt: string;
  exitAt: string;
  realizedPnl: number;
  feesPaid: number;
}

export interface EquitySample {
  timestamp: string;
  equity: number;            // cash + market value of positions
  cash: number;
  marketValue: number;
  totalDeposited: number;    // running sum of external deposits
  drawdownPct: number;
}

export interface SimBrokerConfig {
  startingCash: number;
  dailyDeposit: number;      // 0 to disable; e.g. 50 for $50/day DCA inflow
  feeRate: number;           // 0.0015 = 15 bps per fill
}

export class SimBroker {
  cash: number;
  feeRate: number;
  dailyDeposit: number;
  totalDeposited: number;
  positions: SimPosition[] = [];
  pendingOrders: SimOrder[] = [];
  fills: SimFill[] = [];
  closedTrades: ClosedTrade[] = [];
  equityCurve: EquitySample[] = [];

  private peakEquity: number;
  private nextId = 0;

  constructor(cfg: SimBrokerConfig) {
    this.cash = cfg.startingCash;
    this.totalDeposited = cfg.startingCash;
    this.feeRate = cfg.feeRate;
    this.dailyDeposit = cfg.dailyDeposit;
    this.peakEquity = cfg.startingCash;
  }

  private id(prefix: string): string {
    this.nextId++;
    return `${prefix}-${this.nextId}`;
  }

  /** Daily external deposit (e.g. $50/day from external payroll). */
  depositDailyCash(): void {
    if (this.dailyDeposit > 0) {
      this.cash += this.dailyDeposit;
      this.totalDeposited += this.dailyDeposit;
    }
  }

  enqueueOrder(order: Omit<SimOrder, 'id'>): SimOrder {
    const full: SimOrder = { ...order, id: this.id('o') };
    this.pendingOrders.push(full);
    return full;
  }

  positionFor(symbol: string): SimPosition | undefined {
    return this.positions.find((p) => p.symbol === symbol);
  }

  /** Drain pending orders for `symbol` at the open of `bar`. */
  fillPendingAtOpen(symbol: string, bar: CryptoBar): void {
    const remaining: SimOrder[] = [];
    for (const order of this.pendingOrders) {
      if (order.symbol !== symbol) { remaining.push(order); continue; }
      const fillPrice = bar.o;
      if (order.side === 'buy') {
        this.executeBuy(order, fillPrice, bar.t);
      } else {
        this.executeSell(order, fillPrice, bar.t);
      }
    }
    this.pendingOrders = remaining;
  }

  private executeBuy(order: SimOrder, price: number, when: string): void {
    if (price <= 0) return;
    const notional = order.notional ?? (order.qty ? order.qty * price : 0);
    if (notional <= 0) return;

    const fee = notional * this.feeRate;
    if (this.cash < notional + fee) return; // insufficient cash → silently skip

    const qty = notional / price;
    this.cash -= notional + fee;

    // Weighted-average cost update (DCA pattern: position grows over time)
    const existing = this.positionFor(order.symbol);
    if (existing) {
      const newCostBasis = existing.totalCostBasis + notional;
      const newQty = existing.qty + qty;
      existing.qty = newQty;
      existing.totalCostBasis = newCostBasis;
      existing.avgCost = newCostBasis / newQty;
    } else {
      this.positions.push({
        symbol: order.symbol,
        qty,
        avgCost: price,
        totalCostBasis: notional,
        openedAt: when,
      });
    }

    this.fills.push({
      orderId: order.id,
      symbol: order.symbol,
      side: 'buy',
      qty, price, fee, notional,
      filledAt: when,
      reason: order.reason,
    });
  }

  private executeSell(order: SimOrder, price: number, when: string): void {
    if (price <= 0) return;
    const pos = this.positionFor(order.symbol);
    if (!pos) return;
    const qty = Math.min(order.qty ?? pos.qty, pos.qty);
    if (qty <= 0) return;

    const proceeds = qty * price;
    const fee = proceeds * this.feeRate;
    this.cash += proceeds - fee;

    const costBasisOfSoldQty = pos.avgCost * qty;
    const realizedPnl = proceeds - costBasisOfSoldQty - fee;

    this.fills.push({
      orderId: order.id,
      symbol: order.symbol,
      side: 'sell',
      qty, price, fee, notional: proceeds,
      filledAt: when,
      reason: order.reason,
    });

    this.closedTrades.push({
      symbol: order.symbol,
      qty,
      avgEntryPrice: pos.avgCost,
      exitPrice: price,
      entryAt: pos.openedAt,
      exitAt: when,
      realizedPnl,
      feesPaid: fee,
    });

    // Reduce qty + cost basis proportionally
    pos.qty -= qty;
    pos.totalCostBasis -= costBasisOfSoldQty;
    if (pos.qty <= 1e-12) {
      this.positions = this.positions.filter((p) => p.symbol !== order.symbol);
    }
  }

  /** Mark to market using bar-close prices per symbol. */
  recordEquity(timestamp: string, lastClose: Record<string, number>): void {
    let marketValue = 0;
    for (const pos of this.positions) {
      const p = lastClose[pos.symbol] ?? pos.avgCost;
      marketValue += pos.qty * p;
    }
    const equity = this.cash + marketValue;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity > 0 ? (equity - this.peakEquity) / this.peakEquity : 0;
    this.equityCurve.push({
      timestamp, equity, cash: this.cash, marketValue,
      totalDeposited: this.totalDeposited,
      drawdownPct: drawdown,
    });
  }

  equity(): number {
    const last = this.equityCurve[this.equityCurve.length - 1];
    return last ? last.equity : this.cash;
  }

  maxDrawdownPct(): number {
    let worst = 0;
    for (const s of this.equityCurve) if (s.drawdownPct < worst) worst = s.drawdownPct;
    return worst;
  }
}
