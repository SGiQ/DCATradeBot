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
 *   1. Verify ALPACA_LIVE_KEY/SECRET are set.
 *   2. Check today's submitted live spend vs DAILY_LIVE_CAP_USD.
 *   3. Insert an `approvals` row (status=pending) with an expiry.
 *   4. If NIA_WEBHOOK_URL is set, POST the intent so NIA can notify the user
 *      (SMS/voice/chat); regardless, NIA can also poll via the dca_*
 *      tools any time and decide via the dashboard / CLI / NIA chat.
 *   5. Poll the approvals row until approved | rejected | expired.
 *
 * Paper mode is a no-op pass-through.
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

  // Optional push to NIA (fire-and-forget; failure here must not block trading)
  if (cfg.NIA_WEBHOOK_URL) {
    notifyNia(cfg.NIA_WEBHOOK_URL, {
      type: 'dca.approval.pending',
      approvalId,
      runId: input.runId,
      intent: input.intent,
      expiresAt: expiresAt.toISOString(),
      approveUrl: cfg.PUBLIC_APPROVE_BASE_URL
        ? `${cfg.PUBLIC_APPROVE_BASE_URL.replace(/\/$/, '')}/approve?id=${approvalId}`
        : null,
      rejectUrl: cfg.PUBLIC_APPROVE_BASE_URL
        ? `${cfg.PUBLIC_APPROVE_BASE_URL.replace(/\/$/, '')}/reject?id=${approvalId}`
        : null,
    }).catch((err) => console.error('[liveGate] NIA webhook failed:', err));
  }

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

async function notifyNia(webhook: string, payload: Record<string, unknown>): Promise<void> {
  const res = await request(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Drain body so the socket can be released
  await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`NIA webhook ${webhook} -> ${res.statusCode}`);
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
