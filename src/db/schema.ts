import {
  pgTable,
  serial,
  text,
  timestamp,
  numeric,
  jsonb,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

export const sideEnum = pgEnum('order_side', ['buy', 'sell']);
export const runModeEnum = pgEnum('run_mode', ['paper', 'live']);
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

export const watchlist = pgTable(
  'watchlist',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(), // e.g. 'BTC/USD'
    basePct: numeric('base_pct', { precision: 5, scale: 4 }).notNull(), // 0.6000
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    symbolIdx: uniqueIndex('watchlist_symbol_idx').on(t.symbol),
  }),
);

export const runLogs = pgTable('run_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  mode: runModeEnum('mode').notNull(),
  summary: jsonb('summary').notNull(), // {symbol, regime, intents, errors}
});

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runLogs.id, { onDelete: 'cascade' }),
    brokerOrderId: text('broker_order_id'),
    clientOrderId: text('client_order_id').notNull(),
    symbol: text('symbol').notNull(),
    side: sideEnum('side').notNull(),
    notional: numeric('notional', { precision: 18, scale: 8 }),
    qty: numeric('qty', { precision: 24, scale: 12 }),
    filledAvgPrice: numeric('filled_avg_price', { precision: 18, scale: 8 }),
    status: text('status').notNull(), // accepted, filled, canceled, error, skipped, pending_approval, rejected
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runIdx: index('orders_run_idx').on(t.runId),
    clientIdx: uniqueIndex('orders_client_idx').on(t.clientOrderId),
  }),
);

export const positions = pgTable(
  'positions',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    qty: numeric('qty', { precision: 24, scale: 12 }).notNull(),
    avgCost: numeric('avg_cost', { precision: 18, scale: 8 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    symbolIdx: uniqueIndex('positions_symbol_idx').on(t.symbol),
  }),
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runLogs.id, { onDelete: 'cascade' }),
    intent: jsonb('intent').notNull(), // {symbol, side, notional, reason}
    status: approvalStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    runIdx: index('approvals_run_idx').on(t.runId),
    statusIdx: index('approvals_status_idx').on(t.status),
  }),
);

export type Watchlist = typeof watchlist.$inferSelect;
export type NewWatchlist = typeof watchlist.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
export type RunLog = typeof runLogs.$inferSelect;
export type NewRunLog = typeof runLogs.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
