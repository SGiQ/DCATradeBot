import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { AlpacaCryptoClient } from '../broker/alpacaCrypto.js';
import { classifyTrend, type TrendReading } from '../indicators/index.js';
import {
  decide,
  type Intent,
  type PositionSnapshot,
  type StrategyConfig,
  type WatchlistEntry,
} from '../engine/strategy.js';
import { getDb, closeDb } from '../db/client.js';
import { watchlist, runLogs, orders, positions } from '../db/schema.js';
import { gateLiveOrder } from '../safety/liveGate.js';
import { pushSnapshotToNia } from '../notifications/niaPush.js';

export interface RunResult {
  runId: string;
  mode: 'paper' | 'live';
  intents: Intent[];
  submitted: Array<{ intent: Intent; status: string; brokerOrderId?: string; error?: string }>;
}

export async function runOnce(): Promise<RunResult> {
  const cfg = loadConfig();
  const db = getDb();
  const runId = randomUUID();
  const mode: 'paper' | 'live' = cfg.LIVE_TRADING ? 'live' : 'paper';
  const alpaca = new AlpacaCryptoClient({ mode });

  // 1. Load watchlist
  const wl = await db
    .select()
    .from(watchlist)
    .where(eq(watchlist.enabled, true));
  const entries: WatchlistEntry[] = wl.map((w) => ({
    symbol: w.symbol,
    basePct: Number(w.basePct),
  }));

  // 2. Fetch bars + classify trend for each
  const trends: Record<string, TrendReading> = {};
  for (const e of entries) {
    const bars = await alpaca.getDailyBars(e.symbol, 250);
    const closes = bars.map((b) => b.c);
    const today = classifyTrend(closes);
    // prevSma50/200 lets decide() detect the textbook death-cross.
    const prev = closes.length > 1 ? classifyTrend(closes.slice(0, -1)) : undefined;
    trends[e.symbol] = { ...today, prevSma50: prev?.sma50, prevSma200: prev?.sma200 };
  }

  // 3. Read positions from broker, plus latest price for sell-rule math
  const brokerPositions = await alpaca.listPositions();
  const positionSnaps: Record<string, PositionSnapshot> = {};
  for (const e of entries) {
    const bp = brokerPositions.find((p) => p.symbol === e.symbol.replace('/', ''))
      ?? brokerPositions.find((p) => p.symbol === e.symbol);
    if (!bp) continue;
    const lastPrice = trends[e.symbol]?.price ?? (await alpaca.getLatestPrice(e.symbol));
    positionSnaps[e.symbol] = {
      symbol: e.symbol,
      qty: bp.qty,
      avgCost: bp.avg_entry_price,
      lastPrice,
    };
  }

  // 4. Decide
  const strategyCfg: StrategyConfig = {
    baseDailyUsd: cfg.BASE_DAILY_USD,
    extraDailyUsd: cfg.EXTRA_DAILY_USD,
    dailyCapUsd: cfg.DAILY_CAP_USD,
    tpPct: cfg.TP_PCT,
    sellFraction: cfg.SELL_FRACTION,
    stopLossPct: cfg.STOP_LOSS_PCT,
    deathCrossSellFraction: cfg.DEATH_CROSS_SELL_FRACTION,
    goldenCrossBuyFraction: cfg.GOLDEN_CROSS_BUY_FRACTION,
  };
  // Read available cash for golden-cross redeploy. Best-effort: if Alpaca
  // returns junk we fall back to undefined (skips the golden-cross branch).
  let availableCash: number | undefined;
  try {
    const account = await alpaca.getAccount();
    const parsed = Number(account.cash);
    if (Number.isFinite(parsed) && parsed >= 0) availableCash = parsed;
  } catch {
    /* leave undefined → golden-cross branch no-ops */
  }
  const intents = decide({
    watchlist: entries,
    trends,
    positions: positionSnaps,
    cfg: strategyCfg,
    availableCash,
  });

  // 5. Write run log
  await db.insert(runLogs).values({
    id: runId,
    mode,
    summary: {
      trends: Object.fromEntries(
        Object.entries(trends).map(([k, v]) => [
          k,
          { regime: v.regime, rsi: round(v.rsi, 2), price: round(v.price, 2), sma50: round(v.sma50, 2), sma200: round(v.sma200, 2) },
        ]),
      ),
      positions: positionSnaps,
      intents,
    },
  });

  // 6. Execute intents
  const submitted: RunResult['submitted'] = [];
  for (const intent of intents) {
    const clientOrderId = `dca-${runId.slice(0, 8)}-${intent.symbol.replace('/', '')}-${intent.side}`;

    // Live-mode gate (no-op in paper)
    const gate = await gateLiveOrder({ runId, intent, mode, alpaca });
    if (!gate.approved) {
      await db.insert(orders).values({
        runId,
        clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        notional: intent.notional != null ? String(intent.notional) : null,
        qty: intent.qty != null ? String(intent.qty) : null,
        status: gate.status, // 'pending_approval' | 'rejected' | 'skipped'
        reason: `${intent.reason} | ${gate.reason}`,
      });
      submitted.push({ intent, status: gate.status });
      continue;
    }

    try {
      const order = await alpaca.submitOrder({
        symbol: intent.symbol,
        side: intent.side,
        notional: intent.notional,
        qty: intent.qty,
        client_order_id: clientOrderId,
      });
      await db.insert(orders).values({
        runId,
        brokerOrderId: order.id,
        clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        notional: intent.notional != null ? String(intent.notional) : null,
        qty: intent.qty != null ? String(intent.qty) : null,
        filledAvgPrice: order.filled_avg_price ?? null,
        status: order.status,
        reason: intent.reason,
      });
      submitted.push({ intent, status: order.status, brokerOrderId: order.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.insert(orders).values({
        runId,
        clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        notional: intent.notional != null ? String(intent.notional) : null,
        qty: intent.qty != null ? String(intent.qty) : null,
        status: 'error',
        reason: `${intent.reason} | ${msg}`,
      });
      submitted.push({ intent, status: 'error', error: msg });
    }
  }

  // 7. Refresh local positions table from broker (best-effort)
  const fresh = await alpaca.listPositions();
  for (const p of fresh) {
    const canonical = p.symbol.includes('/') ? p.symbol : `${p.symbol.slice(0, -3)}/${p.symbol.slice(-3)}`;
    await db
      .insert(positions)
      .values({ symbol: canonical, qty: String(p.qty), avgCost: String(p.avg_entry_price) })
      .onConflictDoUpdate({
        target: positions.symbol,
        set: { qty: String(p.qty), avgCost: String(p.avg_entry_price), updatedAt: new Date() },
      });
  }

  // 8. Push fresh snapshot to NIA (fire-and-forget; no-op if vars unset)
  try {
    const account = await alpaca.getAccount();
    const portfolio = Number(account.portfolio_value);
    const cash = Number(account.cash);
    const equity = account.equity != null ? Number(account.equity) : undefined;
    const lastEquity = account.last_equity != null ? Number(account.last_equity) : undefined;
    const todayPnl = equity != null && lastEquity != null ? equity - lastEquity : undefined;
    await pushSnapshotToNia({
      portfolio: Number.isFinite(portfolio) ? portfolio : undefined,
      cash: Number.isFinite(cash) ? cash : undefined,
      buying_power: account.buying_power != null ? Number(account.buying_power) : undefined,
      open_trades: fresh.length,
      today_pnl: todayPnl != null && Number.isFinite(todayPnl) ? todayPnl : undefined,
      last_run_at: new Date().toISOString(),
      mode,
    });
  } catch {
    /* niaPush already swallows errors; this only catches account-fetch failures */
  }

  return { runId, mode, intents, submitted };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}

// Direct execution: `npm run run:once`. pathToFileURL normalizes backslashes
// + drive letters so this works on Windows as well as POSIX.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnce()
    .then(async (r) => {
      console.log(JSON.stringify(r, null, 2));
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
