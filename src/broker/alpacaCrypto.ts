import { request } from 'undici';
import { loadConfig } from '../config.js';

export interface CryptoBar {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  avg_entry_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_plpc: number;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  notional?: number; // USD notional for fractional orders
  qty?: number; // optional fixed qty (used for sells)
  client_order_id?: string;
}

export interface OrderResponse {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  notional: string | null;
  submitted_at: string;
}

export interface AlpacaClientOptions {
  mode: 'paper' | 'live';
}

export class AlpacaCryptoClient {
  private readonly tradingBase: string;
  private readonly dataBase: string;
  private readonly key: string;
  private readonly secret: string;

  constructor(opts: AlpacaClientOptions = { mode: 'paper' }) {
    const cfg = loadConfig();
    this.dataBase = cfg.ALPACA_DATA_BASE_URL;
    if (opts.mode === 'live') {
      if (!cfg.ALPACA_LIVE_KEY || !cfg.ALPACA_LIVE_SECRET) {
        throw new Error('Live mode requested but ALPACA_LIVE_KEY/SECRET are not set');
      }
      this.tradingBase = cfg.ALPACA_LIVE_BASE_URL;
      this.key = cfg.ALPACA_LIVE_KEY;
      this.secret = cfg.ALPACA_LIVE_SECRET;
    } else {
      this.tradingBase = cfg.ALPACA_PAPER_BASE_URL;
      this.key = cfg.ALPACA_API_KEY;
      this.secret = cfg.ALPACA_SECRET_KEY;
    }
  }

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.key,
      'APCA-API-SECRET-KEY': this.secret,
      'Content-Type': 'application/json',
    };
  }

  private async req<T>(base: string, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const url = new URL(path, base);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const res = await request(url.toString(), {
      method: init.method ?? 'GET',
      headers: this.headers(),
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Alpaca ${init.method ?? 'GET'} ${path} -> ${res.statusCode}: ${text}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  /** Daily bars for a crypto symbol. `symbol` like 'BTC/USD'. */
  async getDailyBars(symbol: string, limit = 250): Promise<CryptoBar[]> {
    const data = await this.req<{ bars: Record<string, CryptoBar[]> }>(
      this.dataBase,
      '/v1beta3/crypto/us/bars',
      { query: { symbols: symbol, timeframe: '1Day', limit } },
    );
    return data.bars?.[symbol] ?? [];
  }

  /** Latest trade price for a symbol. */
  async getLatestPrice(symbol: string): Promise<number> {
    const data = await this.req<{ trades: Record<string, { p: number }> }>(
      this.dataBase,
      '/v1beta3/crypto/us/latest/trades',
      { query: { symbols: symbol } },
    );
    const trade = data.trades?.[symbol];
    if (!trade) throw new Error(`No latest trade for ${symbol}`);
    return trade.p;
  }

  async getAccount(): Promise<{ cash: string; portfolio_value: string; status: string }> {
    return this.req(this.tradingBase, '/v2/account');
  }

  async listPositions(): Promise<AlpacaPosition[]> {
    const raw = await this.req<Array<Record<string, string>>>(this.tradingBase, '/v2/positions');
    return raw.map((p) => ({
      symbol: p.symbol!,
      qty: Number(p.qty),
      avg_entry_price: Number(p.avg_entry_price),
      market_value: Number(p.market_value),
      unrealized_pl: Number(p.unrealized_pl),
      unrealized_plpc: Number(p.unrealized_plpc),
    }));
  }

  async getPosition(symbol: string): Promise<AlpacaPosition | null> {
    try {
      const p = await this.req<Record<string, string>>(
        this.tradingBase,
        `/v2/positions/${encodeURIComponent(symbol)}`,
      );
      return {
        symbol: p.symbol!,
        qty: Number(p.qty),
        avg_entry_price: Number(p.avg_entry_price),
        market_value: Number(p.market_value),
        unrealized_pl: Number(p.unrealized_pl),
        unrealized_plpc: Number(p.unrealized_plpc),
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async submitOrder(req: OrderRequest): Promise<OrderResponse> {
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      side: req.side,
      type: 'market',
      time_in_force: 'gtc',
    };
    if (req.notional !== undefined) body.notional = req.notional.toFixed(2);
    if (req.qty !== undefined) body.qty = req.qty.toString();
    if (req.client_order_id) body.client_order_id = req.client_order_id;
    return this.req(this.tradingBase, '/v2/orders', { method: 'POST', body });
  }
}
