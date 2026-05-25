# DCATradeBot

Daily crypto DCA bot with a momentum/trend overlay. Buys BTC + ETH every day on
Alpaca; sizes the discretionary add against a 50/200 SMA + RSI-14 trend signal;
sells a slice on confirmed downtrend take-profits. Paper trading by default.

## Strategy
- **Base buy (always)**: `BASE_DAILY_USD` split 60% BTC / 40% ETH.
- **Extra add (scaled)**: `EXTRA_DAILY_USD * mult`, capped by `DAILY_CAP_USD`.
  - downtrend &rarr; 0.5&times;
  - neutral &rarr; 1.0&times;
  - uptrend &rarr; 1.5&times;
- **Sell**: when `avg_cost` gain &ge; `TP_PCT` AND regime is `downtrend`, sell
  `SELL_FRACTION` of position.

## Stack
TypeScript &middot; Alpaca REST &middot; Drizzle ORM (Postgres) &middot;
node-cron &middot; vitest.

## Setup
```bash
cp .env.example .env       # fill in Alpaca paper keys + DATABASE_URL
npm install
npm run db:migrate
npm run db:seed            # seeds watchlist: BTC/USD 60%, ETH/USD 40%
npm run run:once           # one manual run (paper)
```

## Live trading
`LIVE_TRADING` is **off** by default. When enabled, three locks apply before
any order reaches the broker (see `src/safety/liveGate.ts`):

1. **Key split**: live orders require `ALPACA_LIVE_KEY` + `ALPACA_LIVE_SECRET`
   (paper keys are never used in live mode).
2. **Daily cap**: today's submitted live buy notional + this intent must
   stay &le; `DAILY_LIVE_CAP_USD`, else the intent is `skipped`.
3. **Slack approval**: the bot inserts an `approvals` row, posts to
   `SLACK_WEBHOOK_URL` with approve/reject links, then polls until decision
   or `APPROVAL_TIMEOUT_MIN` (default 30m). Decide via:
   - Clicking the link served at `PUBLIC_APPROVE_BASE_URL/approve?id=...`
     (you'll need to run a tiny endpoint for these &mdash; not included in v1)
   - Or the CLI: `npm run approve &lt;approval-id&gt; [approve|reject]`
