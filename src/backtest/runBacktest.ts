import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runBacktest, type BacktestConfig } from './replay.js';
import { printResultsTable, writeEquityCsv, writeTradesCsv } from './results.js';
import { loadConfig } from '../config.js';

/**
 * CLI:
 *   npm run backtest -- --from 2022-01-01 --to 2026-01-01
 *                       [--cash 1000] [--deposit 50]
 *                       [--symbols BTC/USD,ETH/USD] [--basePcts 0.6,0.4]
 *
 * Cash + deposit are independent knobs:
 *   - --cash $X      : starting paper balance (default 1000)
 *   - --deposit $Y   : daily external inflow (default 50, matches BASE_DAILY_USD)
 *
 * For a "what would happen with my current $5K and no further deposits" run:
 *   npm run backtest -- --from 2024-01-01 --to 2026-01-01 --cash 5000 --deposit 0
 */
function parseArg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const cfg = loadConfig();
  const from = parseArg('--from') ?? oneYearAgo();
  const to = parseArg('--to') ?? new Date().toISOString().slice(0, 10);
  const cash = Number(parseArg('--cash') ?? '1000');
  const deposit = Number(parseArg('--deposit') ?? String(cfg.BASE_DAILY_USD));
  const symbolsArg = parseArg('--symbols') ?? 'BTC/USD,ETH/USD';
  const symbols = symbolsArg.split(',').map((s) => s.trim());
  const basePctsArg = parseArg('--basePcts') ?? '0.6,0.4';
  const basePctValues = basePctsArg.split(',').map((s) => Number(s));
  const basePcts: Record<string, number> = {};
  symbols.forEach((s, i) => { basePcts[s] = basePctValues[i] ?? 0; });

  console.log(`Running backtest: ${from} -> ${to}`);
  console.log(`Cash=${cash}  Daily deposit=${deposit}  Symbols=${symbols.join(', ')}  basePcts=${JSON.stringify(basePcts)}`);

  const backtestCfg: BacktestConfig = {
    symbols,
    basePcts,
    start: from,
    end: to,
    startingCash: cash,
    dailyDeposit: deposit,
    feeRate: 0.0015,
    strategy: {
      baseDailyUsd: cfg.BASE_DAILY_USD,
      extraDailyUsd: cfg.EXTRA_DAILY_USD,
      dailyCapUsd: cfg.DAILY_CAP_USD,
      tpPct: cfg.TP_PCT,
      sellFraction: cfg.SELL_FRACTION,
      stopLossPct: cfg.STOP_LOSS_PCT,
      deathCrossSellFraction: cfg.DEATH_CROSS_SELL_FRACTION,
      goldenCrossBuyFraction: cfg.GOLDEN_CROSS_BUY_FRACTION,
    },
  };

  const result = await runBacktest(backtestCfg);
  printResultsTable(result);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(process.cwd(), 'backtest-data');
  await mkdir(outDir, { recursive: true });
  await writeEquityCsv(result, resolve(outDir, `equity-${ts}.csv`));
  await writeTradesCsv(result, resolve(outDir, `trades-${ts}.csv`));
}

function oneYearAgo(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => { console.error(err); process.exit(1); });
