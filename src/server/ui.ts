import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { approvals, orders, positions, runLogs, watchlist } from '../db/schema.js';
import { verifyApprovalSig } from '../safety/liveGate.js';
import { computeBaseline } from './baseline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_HTML = readFileSync(resolve(__dirname, 'dashboard.html'), 'utf8');

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dca"' });
  res.end('unauthorized');
}

function checkBasicAuth(req: IncomingMessage, user: string, pass: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const suppliedUser = decoded.slice(0, idx);
  const suppliedPass = decoded.slice(idx + 1);
  // Use constant-time comparison to prevent timing side-channel attacks
  try {
    const userMatch = timingSafeEqual(Buffer.from(user, 'utf8'), Buffer.from(suppliedUser, 'utf8'));
    const passMatch = timingSafeEqual(Buffer.from(pass, 'utf8'), Buffer.from(suppliedPass, 'utf8'));
    return userMatch && passMatch;
  } catch {
    // Buffers of different lengths throw — means they don't match
    return false;
  }
}

async function handleApiRuns(): Promise<unknown> {
  const db = getDb();
  return db.select().from(runLogs).orderBy(desc(runLogs.ranAt)).limit(30);
}

async function handleApiOrders(): Promise<unknown> {
  const db = getDb();
  return db.select().from(orders).orderBy(desc(orders.createdAt)).limit(100);
}

async function handleApiPositions(): Promise<unknown> {
  const db = getDb();
  return db.select().from(positions);
}

async function handleApiWatchlist(): Promise<unknown> {
  const db = getDb();
  return db.select().from(watchlist);
}

async function handleApiApprovals(): Promise<unknown> {
  const db = getDb();
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.status, 'pending'))
    .orderBy(desc(approvals.createdAt));
}

async function decideApproval(id: string, decision: 'approved' | 'rejected'): Promise<boolean> {
  const db = getDb();
  const [current] = await db.select().from(approvals).where(eq(approvals.id, id));
  if (!current || current.status !== 'pending') return false;
  await db
    .update(approvals)
    .set({ status: decision, decidedAt: new Date() })
    .where(eq(approvals.id, id));
  return true;
}

export function startUi(): void {
  const cfg = loadConfig();
  if (!cfg.UI_USER || !cfg.UI_PASS) {
    throw new Error('UI requires UI_USER and UI_PASS env vars (refusing to start wide-open)');
  }
  const port = cfg.UI_PORT;
  const user = cfg.UI_USER;
  const pass = cfg.UI_PASS;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      // Slack click links: unauthenticated by URL path, but HMAC-verified by sig param.
      if (req.method === 'GET' && (path === '/approve' || path === '/reject')) {
        const id = url.searchParams.get('id');
        if (!id) return send(res, 400, { error: 'missing id' });
        const sig = url.searchParams.get('sig');
        if (!verifyApprovalSig(id, sig, cfg.APPROVAL_SECRET)) {
          return send(res, 403,
            '<!doctype html><meta charset=utf-8><title>Forbidden</title>' +
            '<body style="font-family:system-ui;padding:2rem"><h1>Invalid or missing signature</h1>' +
            '<p>This link may have expired or been tampered with.</p></body>',
            'text/html');
        }
        const decision = path === '/approve' ? 'approved' : 'rejected';
        const ok = await decideApproval(id, decision);
        return send(res, ok ? 200 : 409,
          `<!doctype html><meta charset=utf-8><title>${decision}</title>` +
          `<body style="font-family:system-ui;padding:2rem">` +
          `<h1>${ok ? decision : 'not pending'}</h1>` +
          `<p>approval id: <code>${id}</code></p></body>`,
          'text/html');
      }

      // Everything else requires basic auth
      if (!checkBasicAuth(req, user, pass)) return unauthorized(res);

      if (req.method === 'GET' && path === '/') {
        return send(res, 200, DASHBOARD_HTML, 'text/html');
      }
      if (req.method === 'GET' && path === '/api/runs') return send(res, 200, await handleApiRuns());
      if (req.method === 'GET' && path === '/api/orders') return send(res, 200, await handleApiOrders());
      if (req.method === 'GET' && path === '/api/positions') return send(res, 200, await handleApiPositions());
      if (req.method === 'GET' && path === '/api/watchlist') return send(res, 200, await handleApiWatchlist());
      if (req.method === 'GET' && path === '/api/baseline') return send(res, 200, await computeBaseline());
      if (req.method === 'GET' && path === '/api/approvals') return send(res, 200, await handleApiApprovals());

      if (req.method === 'POST' && path.startsWith('/api/approvals/')) {
        const id = path.split('/').pop()!;
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
        if (!decision) return send(res, 400, { error: "decision must be 'approve' or 'reject'" });
        const ok = await decideApproval(id, decision);
        return send(res, ok ? 200 : 409, { ok });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[ui] error', err);
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, () => {
    console.log(`[ui] dashboard at http://localhost:${port}/  (basic auth)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startUi();
}
