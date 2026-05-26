import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { loadConfig } from '../config.js';

let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  const cfg = loadConfig();
  if (!cfg.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for this command but is not set');
  }
  // Railway's public Postgres URL requires SSL; the internal URL accepts it
  // either way. Local Postgres (Docker, localhost) does not use SSL.
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.DATABASE_URL);
  pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: 5,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  dbInstance = drizzle(pool, { schema });
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}
