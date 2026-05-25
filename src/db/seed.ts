import { getDb, closeDb } from './client.js';
import { watchlist } from './schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  const db = getDb();
  await db
    .insert(watchlist)
    .values([
      { symbol: 'BTC/USD', basePct: '0.6000' },
      { symbol: 'ETH/USD', basePct: '0.4000' },
    ])
    .onConflictDoUpdate({
      target: watchlist.symbol,
      set: { basePct: sql`excluded.base_pct`, enabled: true },
    });
  console.log('watchlist seeded: BTC/USD 60%, ETH/USD 40%');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
