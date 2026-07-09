import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { runOnce } from './dailyRun.js';
import { startUi } from '../server/ui.js';

const cfg = loadConfig();

// A UI failure (missing UI_USER/UI_PASS, port already in use, etc.) must NOT
// take down the trading worker — the dashboard is non-critical. Isolate it so
// the cron keeps running even if startUi() throws at boot.
if (cfg.UI_ENABLED) {
  try {
    startUi();
  } catch (err) {
    console.error('[cron] UI failed to start; trading continues without it:', err);
  }
}

console.log(`[cron] scheduled: "${cfg.DAILY_CRON}" tz=${cfg.TZ} live=${cfg.LIVE_TRADING}`);

cron.schedule(
  cfg.DAILY_CRON,
  async () => {
    const start = Date.now();
    console.log(`[cron] tick @ ${new Date().toISOString()}`);
    try {
      const result = await runOnce();
      console.log(`[cron] done runId=${result.runId} intents=${result.intents.length} (${Date.now() - start}ms)`);
    } catch (err) {
      console.error('[cron] run failed:', err);
    }
  },
  { timezone: cfg.TZ },
);

process.on('SIGINT', () => {
  console.log('[cron] shutting down');
  process.exit(0);
});
