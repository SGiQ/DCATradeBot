import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, closeDb } from './client.js';

async function main() {
  const db = getDb();
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('migrations applied');
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
