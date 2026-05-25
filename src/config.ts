import { z } from 'zod';

const schema = z.object({
  ALPACA_API_KEY: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_PAPER_BASE_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_BASE_URL: z.string().url().default('https://data.alpaca.markets'),

  ALPACA_LIVE_KEY: z.string().optional(),
  ALPACA_LIVE_SECRET: z.string().optional(),
  ALPACA_LIVE_BASE_URL: z.string().url().default('https://api.alpaca.markets'),

  DATABASE_URL: z.string().min(1),

  BASE_DAILY_USD: z.coerce.number().positive().default(50),
  EXTRA_DAILY_USD: z.coerce.number().nonnegative().default(25),
  DAILY_CAP_USD: z.coerce.number().positive().default(100),
  TP_PCT: z.coerce.number().positive().default(0.2),
  SELL_FRACTION: z.coerce.number().positive().max(1).default(0.25),
  STOP_LOSS_PCT: z.coerce.number().positive().max(1).default(0.15),

  DAILY_CRON: z.string().default('0 13 * * *'),
  TZ: z.string().default('UTC'),

  LIVE_TRADING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DAILY_LIVE_CAP_USD: z.coerce.number().positive().default(100),
  APPROVAL_TIMEOUT_MIN: z.coerce.number().positive().default(30),
  APPROVAL_SECRET: z.string().min(16).optional(),
  NIA_WEBHOOK_URL: z.string().url().optional(),
  PUBLIC_APPROVE_BASE_URL: z.string().url().optional(),

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
