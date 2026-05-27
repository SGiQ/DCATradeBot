import { loadConfig } from '../config.js';

export interface DcaSnapshot {
  portfolio?: number;
  cash?: number;
  buying_power?: number;
  open_trades?: number;
  today_pnl?: number;
  last_run_at?: string;
  mode?: 'paper' | 'live';
}

/**
 * Fire-and-forget POST of a status snapshot to NIA's /agent-message/status.
 * Never throws — if NIA is down or vars are unset, the bot's run is unaffected.
 * NIA renders the snapshot in its DCA pill on the dashboard.
 */
export async function pushSnapshotToNia(snapshot: DcaSnapshot): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.NIA_STATUS_URL || !cfg.NIA_WEBHOOK_SECRET) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(cfg.NIA_STATUS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': cfg.NIA_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ source: 'dca', data: snapshot }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[niaPush] non-2xx from NIA: ${res.status} ${text.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[niaPush] push failed: ${msg}`);
  }
}
