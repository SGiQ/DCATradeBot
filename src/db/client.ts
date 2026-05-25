import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { loadConfig } from '../config.js';

let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  const cfg = loadConfig();
  pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 5 });
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
