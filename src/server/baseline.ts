import { asc, eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { orders, runLogs, watchlist } from '../db/schema.js';

/**
 * Shadow baseline — answers "does the momentum overlay earn its complexity?"
 *
 * Replays the bot's own run history as plain DCA: on each day the bot ran,
 * the baseline buys exactly basePct × BASE_DAILY_USD of each watchlist symbol
 * at that run's recorded price — no regime multipliers, no extra, no sells.
 * The overlay side is reconstructed from actual filled orders. Both sides are
 * valued at the latest run's price, so the comparison isolates strategy from
 * market timing.
 *
 * Derived entirely at read time from run_logs + orders: retroactive to the
 * first run, no schema change, and it can never touch the trading loop.
 *
 * Honest-comparison caveats (also surfaced in the response `notes`):
 * - Days the bot didn't run are invisible to both sides (same opportunity set).
 * - Multiple runs on one day (manual re-runs) count once for the baseline but
 *   every fill counts for the overlay — the overlay genuinely bought.
 */

interface TrendLike {
  price?: number;
}

interface RunSummaryLike {
  trends?: Record<string, TrendLike>;
}

interface SideStats {
  invested: number;
  qty: number;
  realized: number; // proceeds from sells (overlay only; baseline never sells)
  avgCost: number | null;
  value: number;
  roiPct: number | null;
}

function finalize(s: { invested: number; qty: number; realized: number }, lastPrice: number | null): SideStats {
  const value = lastPrice != null ? s.qty * lastPrice : 0;
  return {
    invested: round2(s.invested),
    qty: s.qty,
    realized: round2(s.realized),
    avgCost: s.qty > 1e-12 && s.invested > 0 ? round2((s.invested - s.realized) / s.qty) : null,
    value: round2(value),
    roiPct: s.invested > 0 ? round2(((value + s.realized - s.invested) / s.invested) * 100) : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function computeBaseline(): Promise<unknown> {
  const cfg = loadConfig();
  const db = getDb();

  const wl = await db.select().from(watchlist).where(eq(watchlist.enabled, true));
  const runs = await db.select().from(runLogs).orderBy(asc(runLogs.ranAt));
  const fills = await db.select().from(orders).where(eq(orders.status, 'filled'));

  // One baseline buy per symbol per UTC day the bot ran (first run of the day).
  const firstRunOfDay = new Map<string, RunSummaryLike>();
  for (const r of runs) {
    const day = r.ranAt.toISOString().slice(0, 10);
    if (!firstRunOfDay.has(day)) firstRunOfDay.set(day, r.summary as RunSummaryLike);
  }

  // Latest known price per symbol (newest run that has one).
  const lastPrice = new Map<string, number>();
  for (const r of runs) {
    const trends = (r.summary as RunSummaryLike).trends ?? {};
    for (const [sym, t] of Object.entries(trends)) {
      if (typeof t?.price === 'number') lastPrice.set(sym, t.price);
    }
  }

  const symbols: Record<string, unknown> = {};
  const totals = {
    overlay: { invested: 0, qty: 0, realized: 0, valueAcc: 0 },
    baseline: { invested: 0, qty: 0, realized: 0, valueAcc: 0 },
  };

  for (const entry of wl) {
    const sym = entry.symbol;
    const dailyNotional = Number(entry.basePct) * cfg.BASE_DAILY_USD;

    const base = { invested: 0, qty: 0, realized: 0 };
    for (const summary of firstRunOfDay.values()) {
      const price = summary.trends?.[sym]?.price;
      if (typeof price !== 'number' || price <= 0) continue;
      base.invested += dailyNotional;
      base.qty += dailyNotional / price;
    }

    const over = { invested: 0, qty: 0, realized: 0 };
    for (const o of fills) {
      if (o.symbol !== sym) continue;
      const price = o.filledAvgPrice != null ? Number(o.filledAvgPrice) : null;
      if (price == null || price <= 0) continue;
      const notional = o.notional != null ? Number(o.notional) : null;
      const qty = o.qty != null ? Number(o.qty) : notional != null ? notional / price : null;
      if (qty == null) continue;
      if (o.side === 'buy') {
        over.invested += notional ?? qty * price;
        over.qty += qty;
      } else {
        over.realized += qty * price;
        over.qty -= qty;
      }
    }

    const price = lastPrice.get(sym) ?? null;
    const overlayStats = finalize(over, price);
    const baselineStats = finalize(base, price);
    symbols[sym] = { lastPrice: price, overlay: overlayStats, baseline: baselineStats };

    totals.overlay.invested += over.invested;
    totals.overlay.realized += over.realized;
    totals.overlay.valueAcc += overlayStats.value;
    totals.baseline.invested += base.invested;
    totals.baseline.valueAcc += baselineStats.value;
  }

  const roi = (t: { invested: number; realized: number; valueAcc: number }) =>
    t.invested > 0 ? round2(((t.valueAcc + t.realized - t.invested) / t.invested) * 100) : null;
  const overlayRoi = roi(totals.overlay);
  const baselineRoi = roi(totals.baseline);

  return {
    asOf: new Date().toISOString(),
    baseDailyUsd: cfg.BASE_DAILY_USD,
    runDays: firstRunOfDay.size,
    firstRun: runs[0]?.ranAt ?? null,
    lastRun: runs[runs.length - 1]?.ranAt ?? null,
    symbols,
    totals: {
      overlay: { invested: round2(totals.overlay.invested), value: round2(totals.overlay.valueAcc), realized: round2(totals.overlay.realized), roiPct: overlayRoi },
      baseline: { invested: round2(totals.baseline.invested), value: round2(totals.baseline.valueAcc), roiPct: baselineRoi },
      overlayEdgePct: overlayRoi != null && baselineRoi != null ? round2(overlayRoi - baselineRoi) : null,
    },
    notes: [
      'Baseline = basePct × BASE_DAILY_USD bought at each run day\'s recorded price; no multipliers, no extra, no sells.',
      'Both sides valued at the latest run price. Days the bot did not run are invisible to both sides.',
      'overlayEdgePct is the overlay\'s ROI minus baseline ROI, in percentage points. Judge only after 60+ run days.',
    ],
  };
}
