import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-load .env if present (Node 20.12+ native, no dep). Idempotent.
// No-op on Railway where env vars are injected natively.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envPath); } catch { /* malformed or already loaded */ }
}

const schema = z.object({
  ALPACA_API_KEY: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_PAPER_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_BASE_URL: z.string().url().default('https://data.alpaca.markets'),

  ALPACA_LIVE_KEY: z.string().optional(),
  ALPACA_LIVE_SECRET: z.string().optional(),
  ALPACA_LIVE_BASE_URL: z.string().url().default('https://api.alpaca.markets'),

  // Optional: required by the cron worker + UI, but the backtester doesn't
  // touch the database. getDb() in db/client.ts throws if missing at use time.
  DATABASE_URL: z.string().optional(),

  BASE_DAILY_USD: z.coerce.number().positive().default(50),
  EXTRA_DAILY_USD: z.coerce.number().nonnegative().default(25),
  DAILY_CAP_USD: z.coerce.number().positive().default(100),
  // Wide by design: any sell-in-bull trims the long-run compounding. Backtests
  // show partial profit-taking in pullbacks consistently locks in gains that
  // would have grown bigger on the bounce. Set to 2.0 (+200%) so TP effectively
  // never fires under normal conditions; lower it only if you've added regime
  // detection that knows when "this pullback won't recover."
  TP_PCT: z.coerce.number().positive().default(2.0),
  // Death-cross sell: fraction of position to exit on sma50 crossing below
  // sma200 today. Fires only on the actual cross — typically 1-3x per cycle.
  DEATH_CROSS_SELL_FRACTION: z.coerce.number().positive().max(1).default(0.5),
  // Golden-cross redeploy: fraction of available cash to deploy across the
  // watchlist (by basePct) on the day sma50 crosses ABOVE sma200. The
  // symmetric buy partner to the death-cross sell — together they make the
  // bot a mechanical trader: out on death cross, in on golden cross.
  GOLDEN_CROSS_BUY_FRACTION: z.coerce.number().positive().max(1).default(0.5),
  SELL_FRACTION: z.coerce.number().positive().max(1).default(0.25),
  // Wide by design: tighter stops (e.g. 0.15) lock in losses on normal crypto
  // drawdowns that DCA would otherwise recover from. This is a catastrophic
  // stop only (exchange hack, chain fork, terminal decline), not a risk knob.
  STOP_LOSS_PCT: z.coerce.number().positive().max(1).default(0.70),

  DAILY_CRON: z.string().default('0 13 * * *'),
  TZ: z.string().default('UTC'),

  LIVE_TRADING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DAILY_LIVE_CAP_USD: z.coerce.number().positive().default(100),
  APPROVAL_TIMEOUT_MIN: z.coerce.number().positive().default(30),
  APPROVAL_SECRET: z.string().min(16).optional(),
  NIA_WEBHOOK_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  PUBLIC_APPROVE_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),

  UI_PORT: z.coerce.number().int().positive().default(8080),
  UI_USER: z.string().optional(),
  UI_PASS: z.string().optional(),
  UI_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
