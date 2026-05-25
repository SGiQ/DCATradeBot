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
`LIVE_TRADING` is **off** by default. When enabled, each order is paused for
Slack-webhook approval before submission &mdash; see `src/safety/liveGate.ts`.
