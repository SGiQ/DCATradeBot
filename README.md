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

## Dashboard
`npm start` boots both the cron loop **and** a small dashboard on `UI_PORT`
(default 8080). The dashboard surfaces:

- Pending live approvals (with Approve / Reject buttons)
- Local positions snapshot
- Last 5 daily runs, with the trend regime + RSI per symbol
- Last 50 orders (status, fill price, reason)

Read APIs are behind HTTP basic auth (`UI_USER`/`UI_PASS` &mdash; the server
refuses to start without them). The Slack click links (`/approve?id=...`,
`/reject?id=...`) are unauthenticated; the approval UUID is the secret.

For development: `npm run ui:dev` runs only the UI (no cron). Set
`UI_ENABLED=false` to run the cron headless.

## Live trading
`LIVE_TRADING` is **off** by default. When enabled, three locks apply before
any order reaches the broker (see `src/safety/liveGate.ts`):

1. **Key split**: live orders require `ALPACA_LIVE_KEY` + `ALPACA_LIVE_SECRET`
   (paper keys are never used in live mode).
2. **Daily cap**: today's submitted live buy notional + this intent must
   stay &le; `DAILY_LIVE_CAP_USD`, else the intent is `skipped`.
3. **Approval**: the bot inserts an `approvals` row, optionally POSTs to
   `NIA_WEBHOOK_URL` so [NIA](https://github.com/SGiQ/nia-assistant) can
   notify you (SMS / voice / chat) and call back with the decision, then
   polls the row until decision or `APPROVAL_TIMEOUT_MIN` (default 30m).

Decision can come from any of:
- **NIA**: ask in chat or voice ("anything pending on the bot?" &rarr;
  "approve the BTC buy"). NIA hits the same `/api/approvals` endpoint
  the dashboard uses, with `DCA_UI_USER`/`DCA_UI_PASS`.
- **Dashboard**: Approve / Reject buttons at `/`.
- **Slack-style click URL**: `PUBLIC_APPROVE_BASE_URL/approve?id=&lt;uuid&gt;`
  (works in any chat client that auto-opens links).
- **CLI**: `npm run approve &lt;approval-id&gt; [approve|reject]`.
