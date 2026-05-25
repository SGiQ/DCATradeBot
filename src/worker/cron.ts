import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { runOnce } from './dailyRun.js';
import { startUi } from '../server/ui.js';

const cfg = loadConfig();

if (cfg.UI_ENABLED) startUi();

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
