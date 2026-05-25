import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import { request } from 'undici';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { approvals, orders } from '../db/schema.js';
import type { Intent } from '../engine/strategy.js';
import type { AlpacaCryptoClient } from '../broker/alpacaCrypto.js';

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
 *   2. Check today's submitted live spend vs DAILY_LIVE_CAP_USD —
 *      cross-checked against BOTH local DB and broker account cash.
 *   3. Insert an `approvals` row (status=pending) with an expiry.
 *   4. Build HMAC-signed approve/reject URLs so link interception
 *      can't be replayed without knowing APPROVAL_SECRET.
 *   5. Optionally POST to NIA_WEBHOOK_URL; poll until decision or timeout.
 *
 * Paper mode is a no-op pass-through.
 */
export async function gateLiveOrder(input: {
  runId: string;
  intent: Intent;
  mode: 'paper' | 'live';
  alpaca: AlpacaCryptoClient;
}): Promise<GateResult> {
  if (input.mode === 'paper') {
    return { approved: true, status: 'submitted', reason: 'paper mode' };
  }

  const cfg = loadConfig();
  if (!cfg.ALPACA_LIVE_KEY || !cfg.ALPACA_LIVE_SECRET) {
    return { approved: false, status: 'rejected', reason: 'LIVE_TRADING=true but ALPACA_LIVE_KEY/SECRET unset' };
  }

  // Daily cap: check local DB first (fast), then cross-check broker cash
  const cap = await checkDailyCap(input.intent, cfg.DAILY_LIVE_CAP_USD, input.alpaca);
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

  // Build HMAC-signed URLs (falls back to unsigned if APPROVAL_SECRET not set,
  // but logs a warning so the operator knows)
  const approveUrl = cfg.PUBLIC_APPROVE_BASE_URL
    ? buildSignedUrl(`${cfg.PUBLIC_APPROVE_BASE_URL.replace(/\/$/, '')}/approve`, approvalId, cfg.APPROVAL_SECRET)
    : null;
  const rejectUrl = cfg.PUBLIC_APPROVE_BASE_URL
    ? buildSignedUrl(`${cfg.PUBLIC_APPROVE_BASE_URL.replace(/\/$/, '')}/reject`, approvalId, cfg.APPROVAL_SECRET)
    : null;

  if (cfg.PUBLIC_APPROVE_BASE_URL && !cfg.APPROVAL_SECRET) {
    console.warn('[liveGate] WARNING: APPROVAL_SECRET is not set. Approval URLs are unauthenticated — set a 32-char random secret.');
  }

  // Optional push to NIA (fire-and-forget)
  if (cfg.NIA_WEBHOOK_URL) {
    notifyNia(cfg.NIA_WEBHOOK_URL, {
      type: 'dca.approval.pending',
      approvalId,
      runId: input.runId,
      intent: input.intent,
      expiresAt: expiresAt.toISOString(),
      approveUrl,
      rejectUrl,
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

// ---------------------------------------------------------------------------
// HMAC URL helpers
// ---------------------------------------------------------------------------

/**
 * Build a URL with an HMAC-SHA256 signature appended as ?sig=...
 * If no secret is configured, returns the unsigned URL (with a warning logged
 * by the caller).
 */
export function buildSignedUrl(base: string, id: string, secret?: string): string {
  if (!secret) return `${base}?id=${id}`;
  const sig = createHmac('sha256', secret).update(id).digest('hex').slice(0, 24);
  return `${base}?id=${id}&sig=${sig}`;
}

/**
 * Verify a signature from a click URL.
 * Returns true if APPROVAL_SECRET is not configured (backwards-compatible).
 */
export function verifyApprovalSig(id: string, sig: string | null | undefined, secret?: string): boolean {
  if (!secret) return true; // no secret configured → skip verification
  if (!sig) return false;
  const expected = createHmac('sha256', secret).update(id).digest('hex').slice(0, 24);
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daily cap check (DB + broker cross-check)
// ---------------------------------------------------------------------------

async function checkDailyCap(
  intent: Intent,
  capUsd: number,
  alpaca: AlpacaCryptoClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (intent.side !== 'buy' || intent.notional === undefined) return { ok: true };

  const db = getDb();
  const since = startOfUtcDay();
  const rows = await db
    .select({ notional: orders.notional, side: orders.side, status: orders.status })
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
      reason: `daily live cap (DB): used=${usedToday.toFixed(2)} + this=${intent.notional.toFixed(2)} > cap=${capUsd}`,
    };
  }

  // Cross-check: verify broker account has enough cash to cover this order.
  // This catches cases where the local DB is stale (reset, re-seeded, etc.)
  try {
    const account = await alpaca.getAccount();
    const availableCash = Number(account.cash);
    if (Number.isFinite(availableCash) && intent.notional > availableCash) {
      return {
        ok: false,
        reason: `broker cash check: available=${availableCash.toFixed(2)} < order=${intent.notional.toFixed(2)}`,
      };
    }
    // Secondary cap check: if broker cash implies more was spent than our DB thinks,
    // be conservative and block.
    const impliedSpend = capUsd - availableCash;
    if (impliedSpend > 0 && impliedSpend + intent.notional > capUsd) {
      return {
        ok: false,
        reason: `daily live cap (broker): implied_used=${impliedSpend.toFixed(2)} + this=${intent.notional.toFixed(2)} > cap=${capUsd}`,
      };
    }
  } catch (err) {
    // Broker check failure is non-fatal but logged — we already passed the DB check
    console.warn('[liveGate] broker cash cross-check failed (proceeding on DB check):', err);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function notifyNia(webhook: string, payload: Record<string, unknown>): Promise<void> {
  const res = await request(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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
