import { and, desc, eq, gte } from 'drizzle-orm';
import { request } from 'undici';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { approvals, orders } from '../db/schema.js';
import type { Intent } from '../engine/strategy.js';

export interface GateResult {
  approved: boolean;
  status: 'submitted' | 'pending_approval' | 'rejected' | 'expired' | 'skipped';
  reason: string;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Gate every order in live mode.
 *
 * Steps (live only):
 *   1. Verify ALPACA_LIVE_KEY/SECRET are set (broker construction catches the
 *      hard case; here we double-check upstream config exists).
 *   2. Check today's submitted live spend vs DAILY_LIVE_CAP_USD. Skip if cap
 *      would be exceeded by this intent.
 *   3. Insert an `approvals` row (status=pending) with an expiry.
 *   4. POST to SLACK_WEBHOOK_URL with intent details + the approve URL
 *      (PUBLIC_APPROVE_BASE_URL/approve?id=<approvalId>) and a reject URL.
 *   5. Poll the approvals row until approved | rejected | expired |
 *      APPROVAL_TIMEOUT_MIN reached.
 *
 * In paper mode this is a no-op pass-through.
 */
export async function gateLiveOrder(input: {
  runId: string;
  intent: Intent;
  mode: 'paper' | 'live';
}): Promise<GateResult> {
  if (input.mode === 'paper') {
    return { approved: true, status: 'submitted', reason: 'paper mode' };
  }

  const cfg = loadConfig();
  if (!cfg.ALPACA_LIVE_KEY || !cfg.ALPACA_LIVE_SECRET) {
    return { approved: false, status: 'rejected', reason: 'LIVE_TRADING=true but ALPACA_LIVE_KEY/SECRET unset' };
  }

  // Daily live spend cap
  const cap = await checkDailyCap(input.intent, cfg.DAILY_LIVE_CAP_USD);
  if (!cap.ok) {
    return { approved: false, status: 'skipped', reason: cap.reason };
  }

  const db = getDb();
  const expiresAt = new Date(Date.now() + cfg.APPROVAL_TIMEOUT_MIN * 60_000);
  const [row] = await db
    .insert(approvals)
    .values({
      runId: input.runId,
      intent: input.intent as unknown as Record<string, unknown>,
      status: 'pending',
      expiresAt,
    })
    .returning({ id: approvals.id });
  if (!row) {
    return { approved: false, status: 'rejected', reason: 'failed to create approval row' };
  }
  const approvalId = row.id;

  // Fire Slack webhook (best-effort)
  if (cfg.SLACK_WEBHOOK_URL) {
    await postSlack(cfg.SLACK_WEBHOOK_URL, input.intent, approvalId, cfg.PUBLIC_APPROVE_BASE_URL);
  }

  // Poll
  const deadline = Date.now() + cfg.APPROVAL_TIMEOUT_MIN * 60_000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const [current] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!current) break;
    if (current.status === 'approved') {
      return { approved: true, status: 'submitted', reason: `approved (id=${approvalId})` };
    }
    if (current.status === 'rejected') {
      return { approved: false, status: 'rejected', reason: `rejected (id=${approvalId})` };
    }
  }

  // Timed out
  await db
    .update(approvals)
    .set({ status: 'expired', decidedAt: new Date() })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')));
  return { approved: false, status: 'expired', reason: `no decision within ${cfg.APPROVAL_TIMEOUT_MIN}m` };
}

async function checkDailyCap(intent: Intent, capUsd: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (intent.side !== 'buy' || intent.notional === undefined) return { ok: true };
  const db = getDb();
  const since = startOfUtcDay();
  const rows = await db
    .select({ notional: orders.notional, side: orders.side, status: orders.status, createdAt: orders.createdAt })
    .from(orders)
    .where(gte(orders.createdAt, since))
    .orderBy(desc(orders.createdAt));

  const livelike = new Set(['accepted', 'filled', 'partially_filled', 'new', 'pending_new']);
  const usedToday = rows
    .filter((r) => r.side === 'buy' && r.notional && livelike.has(r.status))
    .reduce((acc, r) => acc + Number(r.notional ?? 0), 0);

  if (usedToday + intent.notional > capUsd) {
    return {
      ok: false,
      reason: `daily live cap: used=${usedToday.toFixed(2)} + this=${intent.notional.toFixed(2)} > cap=${capUsd}`,
    };
  }
  return { ok: true };
}

async function postSlack(webhook: string, intent: Intent, approvalId: string, approveBase?: string): Promise<void> {
  const sizeStr = intent.notional !== undefined ? `$${intent.notional.toFixed(2)}` : `${intent.qty} units`;
  const approveUrl = approveBase ? `${approveBase.replace(/\/$/, '')}/approve?id=${approvalId}` : '(set PUBLIC_APPROVE_BASE_URL)';
  const rejectUrl = approveBase ? `${approveBase.replace(/\/$/, '')}/reject?id=${approvalId}` : '(set PUBLIC_APPROVE_BASE_URL)';
  const body = {
    text:
      `:warning: *LIVE* order needs approval\n` +
      `*${intent.side.toUpperCase()} ${intent.symbol}* ${sizeStr}\n` +
      `reason: ${intent.reason}\n` +
      `approve: ${approveUrl}\nreject: ${rejectUrl}\n` +
      `or run: \`npm run approve ${approvalId}\``,
  };
  try {
    await request(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[liveGate] slack post failed:', err);
  }
}

function startOfUtcDay(d = new Date()): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
