// One Poller Durable Object per (provider, region), named "<provider>/<region>". It owns that
// target's stock state, events and catalog, polls from its own alarm, and reports every poll (and
// any transitions) to the Hub, which matches subscriptions, notifies and pushes live updates.
import { DurableObject } from "cloudflare:workers";
import { diff, type PrevSlot } from "./diff";
import { provider } from "./providers";
import { cheapestInStock, detail, iso, summarize } from "./stock";
import { inStock, matches, targetKey, type Product, type StockEvent, type StockRow, type StockStatus, type Subscription, type Target } from "./types";

const catalogRefresh = 6 * 3600_000;
const maxBackoff = 10 * 60_000;
const fetchTimeout = 45_000;

const schema = [
  `CREATE TABLE IF NOT EXISTS stock_state (
    key TEXT PRIMARY KEY, product_code TEXT NOT NULL, config TEXT NOT NULL, location TEXT NOT NULL,
    status TEXT NOT NULL, raw_state TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', changed_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS stock_state_product ON stock_state(product_code)`,
  // ids are "ms × 1000 + n", unique across Pollers and ordered by time, so the Hub can merge
  // pages from several Pollers and the WebUI can paginate with ?before=<id>.
  `CREATE TABLE IF NOT EXISTS stock_events (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL, product_code TEXT NOT NULL, config TEXT NOT NULL,
    location TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, raw_state TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS stock_events_at ON stock_events(at)`,
  `CREATE INDEX IF NOT EXISTS stock_events_key ON stock_events(key, id)`,
  `CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  // Single row (id = 1): which target this object is, its settings, schedule and last poll result.
  `CREATE TABLE IF NOT EXISTS poller (
    id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL, region TEXT NOT NULL, enabled INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL DEFAULT 60000, retention_days INTEGER NOT NULL DEFAULT 30,
    next_poll INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 0,
    last_poll INTEGER NOT NULL DEFAULT 0, last_success INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0, slots INTEGER NOT NULL DEFAULT 0, in_stock INTEGER NOT NULL DEFAULT 0,
    catalog_at INTEGER NOT NULL DEFAULT 0, catalog_error TEXT NOT NULL DEFAULT '', last_prune INTEGER NOT NULL DEFAULT 0)`,
];

type PollerRow = {
  provider: string;
  region: string;
  enabled: number;
  interval_ms: number;
  retention_days: number;
  next_poll: number;
  failures: number;
  step: number;
  last_poll: number;
  last_success: number;
  last_error: string;
  duration_ms: number;
  slots: number;
  in_stock: number;
  catalog_at: number;
  catalog_error: string;
  last_prune: number;
};

type EventRow = {
  id: number;
  key: string;
  product_code: string;
  config: string;
  location: string;
  from_status: string;
  to_status: string;
  raw_state: string;
  at: number;
};

// What the WebUI's PollStatus expects (same JSON as the Go version).
export interface PollStatus {
  target: Target;
  lastPoll: string;
  lastSuccess: string;
  lastError: string;
  durationMs: number;
  slots: number;
  inStock: number;
  failures: number;
  nextPoll: string;
  catalogUpdated: string;
  catalogError: string;
}

export interface PollerConfig {
  intervalMs: number;
  retentionDays: number;
}

export interface EventFilter {
  productCode?: string;
  key?: string;
  onlyRestock?: boolean;
  since?: number;
  beforeId?: number;
  limit: number;
}

export class Poller extends DurableObject<Env> {
  private sql: SqlStorage;
  // Previous state for diffing, loaded lazily. Only status/raw/changedAt are kept: several Pollers can
  // share one isolate's 128 MB, and a region has ~40k slots.
  private prev?: Map<string, PrevSlot>;
  private lastEventId = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const s of schema) this.sql.exec(s);
    });
  }

  private row(): PollerRow | undefined {
    return this.sql.exec<PollerRow>(`SELECT * FROM poller WHERE id = 1`).toArray()[0];
  }

  private target(): Target | undefined {
    const r = this.row();
    return r && { provider: r.provider, region: r.region };
  }

  // Called by the Hub: start polling t with the given settings, or stop (t = null). Idempotent; stock
  // data is kept when stopped.
  async configure(t: Target | null, cfg?: PollerConfig) {
    const row = this.row();
    if (!t || !cfg) {
      if (row?.enabled) this.sql.exec(`UPDATE poller SET enabled = 0 WHERE id = 1`);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Stagger first polls so several targets don't hit APIs at the same instant.
    const first = Date.now() + Math.floor(Math.random() * 2000);
    if (!row) {
      this.sql.exec(`INSERT INTO poller (id, provider, region, enabled, interval_ms, retention_days, next_poll) VALUES (1, ?, ?, 1, ?, ?, ?)`,
        t.provider, t.region, cfg.intervalMs, cfg.retentionDays, first);
    } else {
      this.sql.exec(`UPDATE poller SET interval_ms = ?, retention_days = ? WHERE id = 1`, cfg.intervalMs, cfg.retentionDays);
      if (!row.enabled) this.sql.exec(`UPDATE poller SET enabled = 1, next_poll = ? WHERE id = 1`, first);
    }
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(this.row()!.next_poll);
  }

  async pollNow() {
    if (!this.row()?.enabled) return;
    this.sql.exec(`UPDATE poller SET next_poll = ? WHERE id = 1`, Date.now());
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const row = this.row();
    if (!row?.enabled) return;
    const t: Target = { provider: row.provider, region: row.region };
    if (!provider(this.env, t.provider)) return;

    let failures = row.failures;
    let events: StockEvent[] = [];
    try {
      events = await this.pollOnce(t, row.step);
      failures = 0;
    } catch (e) {
      failures++;
      console.warn("poll failed", targetKey(t), failures, String(e));
    }
    let wait = failures > 0 ? Math.min(row.interval_ms * 2 ** Math.min(failures, 6), maxBackoff) : row.interval_ms;
    wait += Math.floor(Math.random() * (wait / 10 + 1)); // +10% jitter
    this.sql.exec(`UPDATE poller SET next_poll = ?, failures = ?, step = step + 1 WHERE id = 1`, Date.now() + wait, failures);

    // Report before the catalog refresh so alerts and live updates aren't held up by it.
    const hub = this.env.HUB.get(this.env.HUB.idFromName("default"));
    try {
      await hub.onPoll(t, this.pollStatus()!, events, this.products(events.map((e) => e.productCode)));
    } catch (e) {
      console.warn("report to hub failed", targetKey(t), String(e));
    }

    // After the poll, so a slow 10+ MB catalog download never delays stock checks. The first poll only
    // records a baseline, so alerts never go out before the catalog exists.
    if (Date.now() - row.catalog_at > catalogRefresh) await this.refreshCatalog(t);

    if (Date.now() - row.last_prune > 24 * 3600_000) {
      this.sql.exec(`DELETE FROM stock_events WHERE at < ?`, Date.now() - row.retention_days * 24 * 3600_000);
      this.sql.exec(`UPDATE poller SET last_prune = ? WHERE id = 1`, Date.now());
    }
    await this.ctx.storage.setAlarm(Math.max(this.row()!.next_poll, Date.now() + 1000));
  }

  private async refreshCatalog(t: Target) {
    try {
      const products = await provider(this.env, t.provider)!.fetchCatalog(t.region, AbortSignal.timeout(fetchTimeout));
      const at = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM products`);
        for (const pr of products) this.sql.exec(`INSERT INTO products (code, data, updated_at) VALUES (?, ?, ?)`, pr.code, JSON.stringify(pr), at);
        this.sql.exec(`UPDATE poller SET catalog_at = ?, catalog_error = '' WHERE id = 1`, at);
      });
    } catch (e) {
      // Retry in 5 minutes.
      this.sql.exec(`UPDATE poller SET catalog_at = ?, catalog_error = ? WHERE id = 1`, Date.now() - catalogRefresh + 5 * 60_000, String(e));
    }
  }

  private loadPrev(): Map<string, PrevSlot> {
    if (this.prev) return this.prev;
    const m = new Map<string, PrevSlot>();
    for (const r of this.sql.exec<{ key: string; status: string; raw_state: string; changed_at: number }>(
      `SELECT key, status, raw_state, changed_at FROM stock_state`)) {
      m.set(r.key, { status: r.status as StockStatus, rawState: r.raw_state, changedAt: r.changed_at });
    }
    return (this.prev = m);
  }

  private nextEventId(at: number): number {
    if (!this.lastEventId) this.lastEventId = this.sql.exec<{ id: number | null }>(`SELECT MAX(id) AS id FROM stock_events`).one().id ?? 0;
    this.lastEventId = Math.max(at * 1000 + Math.floor(Math.random() * 100), this.lastEventId + 1);
    return this.lastEventId;
  }

  // Fetches availability and persists transitions; returns them.
  private async pollOnce(t: Target, step: number): Promise<StockEvent[]> {
    const start = Date.now();
    let fresh;
    try {
      fresh = await provider(this.env, t.provider)!.fetchAvailability(t.region, AbortSignal.timeout(fetchTimeout), step);
    } catch (e) {
      this.sql.exec(`UPDATE poller SET last_poll = ?, last_error = ?, duration_ms = ? WHERE id = 1`, start, String(e), Date.now() - start);
      throw e;
    }
    const prev = this.loadPrev();
    if (fresh.length === 0 && prev.size > 0) {
      const err = `provider returned no availability data (previously ${prev.size} slots); ignoring`;
      this.sql.exec(`UPDATE poller SET last_poll = ?, last_error = ? WHERE id = 1`, start, err);
      throw new Error(err);
    }

    const now = Date.now();
    const d = diff(prev, fresh, now);
    fresh = undefined; // let the parsed payload be collected before the Hub round trip
    this.ctx.storage.transactionSync(() => {
      for (const r of d.upserts) {
        this.sql.exec(
          `INSERT INTO stock_state (key, product_code, config, location, status, raw_state, extra, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET status = excluded.status, raw_state = excluded.raw_state,
             extra = excluded.extra, changed_at = excluded.changed_at`,
          `${r.provider}|${r.region}|${r.config}|${r.location}`, r.productCode, r.config, r.location,
          r.status, r.rawState, JSON.stringify(r.extra ?? {}), r.changedAt,
        );
      }
      for (const k of d.deletes) this.sql.exec(`DELETE FROM stock_state WHERE key = ?`, k);
      for (const e of d.events) {
        e.id = this.nextEventId(e.at);
        this.sql.exec(
          `INSERT INTO stock_events (id, key, product_code, config, location, from_status, to_status, raw_state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          e.id, e.key, e.productCode, e.config, e.location, e.from, e.to, e.rawState, e.at,
        );
      }
    });
    for (const r of d.upserts) prev.set(`${r.provider}|${r.region}|${r.config}|${r.location}`, { status: r.status, rawState: r.rawState, changedAt: r.changedAt });
    for (const k of d.deletes) prev.delete(k);
    let stocked = 0;
    for (const r of prev.values()) if (inStock(r.status)) stocked++;
    this.sql.exec(`UPDATE poller SET last_poll = ?, last_success = ?, last_error = '', duration_ms = ?, slots = ?, in_stock = ? WHERE id = 1`,
      start, now, Date.now() - start, prev.size, stocked);
    return d.events;
  }

  // --- reads ---

  private products(codes?: string[]): Record<string, Product> {
    const out: Record<string, Product> = {};
    const rows = codes
      ? [...new Set(codes)].flatMap((c) => this.sql.exec<{ data: string }>(`SELECT data FROM products WHERE code = ?`, c).toArray())
      : this.sql.exec<{ data: string }>(`SELECT data FROM products`).toArray();
    for (const r of rows) {
      const p = JSON.parse(r.data) as Product;
      out[p.code] = p;
    }
    return out;
  }

  private rows(productCode?: string): StockRow[] {
    const t = this.target();
    if (!t) return [];
    const cur = productCode
      ? this.sql.exec<Record<string, string | number>>(`SELECT * FROM stock_state WHERE product_code = ?`, productCode)
      : this.sql.exec<Record<string, string | number>>(`SELECT * FROM stock_state`);
    return cur.toArray().map((r) => ({
      provider: t.provider, region: t.region, productCode: String(r.product_code), config: String(r.config),
      location: String(r.location), status: r.status as StockStatus, rawState: String(r.raw_state),
      // extra is only shown per product (stock detail); skipping it keeps the full matrix cheap.
      extra: productCode ? JSON.parse(String(r.extra)) : undefined, changedAt: Number(r.changed_at),
    }));
  }

  private pollStatus(): PollStatus | null {
    const r = this.row();
    if (!r) return null;
    return {
      target: { provider: r.provider, region: r.region }, lastPoll: iso(r.last_poll), lastSuccess: iso(r.last_success),
      lastError: r.last_error, durationMs: r.duration_ms, slots: r.slots, inStock: r.in_stock, failures: r.failures,
      nextPoll: iso(r.next_poll), catalogUpdated: iso(r.catalog_at), catalogError: r.catalog_error,
    };
  }

  async status() {
    return this.pollStatus();
  }

  async product(code: string): Promise<Product | null> {
    return this.products([code])[code] ?? null;
  }

  // GET /api/stock
  async stock() {
    const t = this.target();
    const products = Object.values(this.products());
    return summarize(this.rows(), products, t && provider(this.env, t.provider));
  }

  // GET /api/stock/detail
  async stockDetail(code: string) {
    const t = this.target();
    const prod = this.products([code])[code];
    return { product: prod ?? null, ...detail(this.rows(code), code, prod, t && provider(this.env, t.provider)) };
  }

  // GET /api/order: the pre-filled order page for a product (see api.go's order for the rules).
  async orderLink(code: string, location: string, config: string): Promise<string | null> {
    const t = this.target();
    if (!t) return null;
    const pv = provider(this.env, t.provider);
    const prod = this.products([code])[code];
    if (!prod) {
      // Slots for plans missing from the public catalog: nothing to pre-fill, send to the storefront.
      return Object.values(this.products()).find((p) => p.orderUrl)?.orderUrl ?? null;
    }
    if (!config) ({ config, location } = cheapestInStock(this.rows(code), prod, location, pv));
    if (config) {
      const u = pv?.orderUrl?.(prod, config, location);
      if (u) return u;
    }
    return prod.orderUrl || null;
  }

  async events(f: EventFilter): Promise<StockEvent[]> {
    const t = this.target();
    if (!t) return [];
    const where: string[] = [], args: (string | number)[] = [];
    if (f.productCode) where.push("product_code = ?"), args.push(f.productCode);
    if (f.key) where.push("key = ?"), args.push(f.key);
    if (f.onlyRestock) where.push("to_status IN ('available','low') AND from_status NOT IN ('available','low')");
    if (f.since) where.push("at >= ?"), args.push(f.since);
    if (f.beforeId) where.push("id < ?"), args.push(f.beforeId);
    const q = `SELECT * FROM stock_events${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.sql.exec<EventRow>(q, ...args, f.limit).toArray().map((e) => ({
      id: e.id, key: e.key, provider: t.provider, region: t.region, productCode: e.product_code, config: e.config,
      location: e.location, from: e.from_status as StockStatus, to: e.to_status as StockStatus, rawState: e.raw_state, at: e.at,
    }));
  }

  async restockCount(since: number): Promise<number> {
    return this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_events WHERE at >= ? AND to_status IN ('available','low') AND from_status NOT IN ('available','low')`, since).one().n;
  }

  // Per subscription: product name, how many matching slots are in stock and where (overview, bot /status).
  async inStockFor(subs: Subscription[]): Promise<{ id: number; name: string; count: number; locations: string[] }[]> {
    const t = this.target();
    return subs.map((s) => {
      const locs: string[] = [];
      let count = 0;
      for (const row of this.sql.exec<{ config: string; location: string }>(
        `SELECT config, location FROM stock_state WHERE product_code = ? AND status IN ('available', 'low') ORDER BY key`, s.productCode)) {
        if (t && matches(s, { ...t, productCode: s.productCode, ...row })) {
          count++;
          if (!locs.includes(row.location)) locs.push(row.location);
        }
      }
      const name = this.products([s.productCode])[s.productCode]?.name || s.productCode;
      return { id: s.id, name, count, locations: locs };
    });
  }
}
