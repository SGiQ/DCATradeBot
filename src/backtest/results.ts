import { writeFile } from 'node:fs/promises';
import type { BacktestResult } from './replay.js';

const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';
const fmtPctSigned = (n: number) => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';

export function printResultsTable(r: BacktestResult): void {
  const col = (s: string) => s.padStart(14);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`Backtest: ${r.config.symbols.join(', ')}`);
  console.log(`Range:        ${r.config.start.slice(0, 10)} -> ${r.config.end.slice(0, 10)}`);
  console.log(`Starting:     ${fmtUsd(r.config.startingCash)}   Daily deposit: ${fmtUsd(r.config.dailyDeposit)}`);
  console.log(`Total deposited (capital invested): ${fmtUsd(r.totalDeposited)}`);
  console.log('');
  console.log('         ' + ['DCA Bot', 'Naive DCA', 'Lump 60/40', 'BTC HODL', 'ETH HODL'].map(col).join('  '));
  console.log('Final:   ' +
    [r.finalEquity, r.benchmarks.naiveDca.finalValue, r.benchmarks.lumpSum6040.finalValue,
     r.benchmarks.btcHodl.finalValue, r.benchmarks.ethHodl.finalValue]
      .map((v) => col(fmtUsd(v))).join('  '));
  console.log('Net ret: ' +
    [r.netReturnPct, r.benchmarks.naiveDca.netReturnPct, r.benchmarks.lumpSum6040.netReturnPct,
     r.benchmarks.btcHodl.netReturnPct, r.benchmarks.ethHodl.netReturnPct]
      .map((v) => col(fmtPctSigned(v))).join('  '));
  console.log('Max DD:  ' +
    [r.maxDrawdownPct, r.benchmarks.naiveDca.maxDdPct, r.benchmarks.lumpSum6040.maxDdPct,
     r.benchmarks.btcHodl.maxDdPct, r.benchmarks.ethHodl.maxDdPct]
      .map((v) => col(fmtPct(v))).join('  '));
  console.log('');
  console.log(`Buys queued: ${r.totalBuys}   Sells queued: ${r.totalSells}   Closed (round-trip) trades: ${r.closedTradeCount}`);
  console.log(`Realized P&L from sells: ${fmtUsd(r.totalRealizedPnl)}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');

  // Verdict
  const beatNaive = r.netReturnPct > r.benchmarks.naiveDca.netReturnPct;
  const beatLump = r.netReturnPct > r.benchmarks.lumpSum6040.netReturnPct;
  const gapNaive = ((r.netReturnPct - r.benchmarks.naiveDca.netReturnPct) * 100).toFixed(2);
  const gapLump = ((r.netReturnPct - r.benchmarks.lumpSum6040.netReturnPct) * 100).toFixed(2);

  if (beatNaive && beatLump) {
    console.log(`Verdict: DCA bot beat naive DCA by ${gapNaive} pts and lump-sum by ${gapLump} pts. Overlay + sell logic earns its keep.`);
  } else if (beatNaive && !beatLump) {
    console.log(`Verdict: DCA bot beat naive DCA by ${gapNaive} pts but underperformed lump-sum by ${Math.abs(Number(gapLump))} pts.`);
    console.log(`         Lump-sum wins because of dollar-cost-averaging into a generally-rising market (sequencing penalty).`);
  } else if (!beatNaive && beatLump) {
    console.log(`Verdict: DCA bot UNDERPERFORMED naive DCA by ${Math.abs(Number(gapNaive))} pts. The overlay + sell logic is net-negative.`);
    console.log(`         (Beat lump-sum by ${gapLump} pts — DCA-style accumulation works, just not the overlay.)`);
  } else {
    console.log(`Verdict: DCA bot UNDERPERFORMED both naive DCA (by ${Math.abs(Number(gapNaive))} pts) and lump-sum (by ${Math.abs(Number(gapLump))} pts).`);
  }
  console.log('');
}

export async function writeEquityCsv(r: BacktestResult, path: string): Promise<void> {
  const lines = ['timestamp,equity,deposited,drawdown_pct,naive_dca,lump_sum_6040,btc_hodl,eth_hodl'];
  for (const sample of r.equityCurve) {
    lines.push([
      sample.t,
      sample.equity.toFixed(2),
      sample.deposited.toFixed(2),
      (sample.drawdown * 100).toFixed(4),
      sample.naiveDca.toFixed(2),
      sample.lumpSum6040.toFixed(2),
      sample.btcHodl.toFixed(2),
      sample.ethHodl.toFixed(2),
    ].join(','));
  }
  await writeFile(path, lines.join('\n'));
  console.log(`equity curve -> ${path} (${r.equityCurve.length} samples)`);
}

export async function writeTradesCsv(r: BacktestResult, path: string): Promise<void> {
  const lines = ['symbol,entry_at,exit_at,avg_entry,exit_price,qty,realized_pnl'];
  for (const t of r.trades) {
    lines.push([
      t.symbol, t.entryAt, t.exitAt,
      t.avgEntryPrice.toFixed(4), t.exitPrice.toFixed(4),
      t.qty.toFixed(8), t.realizedPnl.toFixed(2),
    ].join(','));
  }
  await writeFile(path, lines.join('\n'));
  console.log(`trades -> ${path} (${r.trades.length} round-trips)`);
}
