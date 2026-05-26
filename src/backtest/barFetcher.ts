import { request } from 'undici';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import type { CryptoBar } from '../broker/alpacaCrypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../../backtest-data');

// Alpaca's stated `limit` max is 10000, but in practice the crypto bars
// endpoint frequently returns ~40-200 per page regardless. Pagination is
// always via next_page_token. 300-page cap accommodates 4H over 2 years
// (which observed ~102 pages of ~43 bars each).
const PAGE_LIMIT = 10_000;
const MAX_PAGES = 300;
const INTER_PAGE_DELAY_MS = 250;       // polite delay between page requests
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]; // 429 backoff

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface BarsResponse {
  bars: Record<string, CryptoBar[]>;
  next_page_token?: string | null;
}

function toIso(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00Z`;
  return date;
}

/**
 * Fetch all daily bars for one (symbol, [start, end]) range. DCATradeBot
 * only needs the daily timeframe (its decide() runs once a day on daily
 * closes). 1D pages are small (~one page per request even over years),
 * but we keep the retry + pagination machinery for consistency.
 */
export async function fetchDailyBars(
  symbol: string,
  start: string,
  end: string,
): Promise<CryptoBar[]> {
  const cfg = loadConfig();
  const startIso = toIso(start);
  const endIso = toIso(end);
  const all: CryptoBar[] = [];
  let pageToken: string | null = null;
  let prevPageToken: string | null = null;
  let page = 0;

  do {
    const url = new URL('/v1beta3/crypto/us/bars', cfg.ALPACA_DATA_BASE_URL);
    url.searchParams.set('symbols', symbol);
    url.searchParams.set('timeframe', '1Day');
    url.searchParams.set('start', startIso);
    url.searchParams.set('end', endIso);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (pageToken) url.searchParams.set('page_token', pageToken);

    // Fetch with 429 retry
    let data: BarsResponse | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const res = await request(url.toString(), {
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': cfg.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': cfg.ALPACA_SECRET_KEY,
        },
      });
      const text = await res.body.text();
      if (res.statusCode === 429 && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt]!;
        process.stdout.write(`\r[barFetcher] ${symbol} rate-limited, sleeping ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})...     `);
        await sleep(delay);
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.log('');
        throw new Error(`Alpaca bars ${symbol} -> ${res.statusCode}: ${text}`);
      }
      data = JSON.parse(text) as BarsResponse;
      break;
    }
    if (!data) {
      console.log('');
      throw new Error(`Alpaca bars ${symbol} failed after ${RETRY_DELAYS_MS.length} 429 retries`);
    }

    const batch = data.bars?.[symbol] ?? [];
    all.push(...batch);
    page++;
    process.stdout.write(`\r[barFetcher] ${symbol} 1Day page ${page}: +${batch.length} bars (total ${all.length})            `);

    if (data.next_page_token && data.next_page_token === prevPageToken) {
      console.log('');
      throw new Error(`Pagination loop: same next_page_token returned twice for ${symbol}`);
    }
    prevPageToken = pageToken;
    pageToken = data.next_page_token ?? null;

    if (page > MAX_PAGES) {
      console.log('');
      throw new Error(`Pagination exceeded ${MAX_PAGES} pages for ${symbol} (got ${all.length} bars so far)`);
    }

    if (pageToken) await sleep(INTER_PAGE_DELAY_MS);
  } while (pageToken);

  console.log('');
  all.sort((a, b) => a.t.localeCompare(b.t));
  return all;
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function cacheKey(symbol: string, start: string, end: string): string {
  const safe = symbol.replace('/', '-');
  return `${safe}_1Day_${start.slice(0, 10)}_${end.slice(0, 10)}.json`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function getDailyBarsCached(
  symbol: string,
  start: string,
  end: string,
): Promise<CryptoBar[]> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = resolve(CACHE_DIR, cacheKey(symbol, start, end));
  if (await exists(path)) {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as CryptoBar[];
  }
  console.log(`[barFetcher] fetching ${symbol} 1Day ${start.slice(0, 10)}..${end.slice(0, 10)}`);
  const bars = await fetchDailyBars(symbol, start, end);
  await writeFile(path, JSON.stringify(bars));
  console.log(`[barFetcher] cached ${bars.length} bars -> ${path}`);
  return bars;
}
