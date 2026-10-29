// Stock views for the WebUI (port of internal/api/stock.go): the product × location matrix, one
// product's configurations, and the in-stock configuration an order link should pre-fill.
import { inStock, type ConfigPrice, type Product, type Provider, type StockRow, type StockStatus } from "./types";

const statusRank: Record<StockStatus, number> = { available: 3, low: 2, unavailable: 1, unknown: 0 };

export const iso = (ms: number) => new Date(ms || -62135596800000).toISOString(); // 0 → Go's zero time

// Orders OVH raw states such as "1H-high" < "24H" < "72H".
function deliveryHours(raw: string): number {
  const s = raw.split("-")[0].replace(/H$/, "");
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : 1 << 30;
}

const better = (a: StockRow, b: StockRow) =>
  statusRank[a.status] !== statusRank[b.status] ? statusRank[a.status] > statusRank[b.status] : deliveryHours(a.rawState) < deliveryHours(b.rawState);

const priceOf = (pv: Provider | undefined, prod: Product | undefined, config: string): ConfigPrice | null =>
  (prod && pv?.configPrice?.(prod, config)) || null;

interface LocationSummary {
  status: StockStatus;
  raw: string; // fastest delivery among the best-status slots
  inStock: number;
  total: number;
}

interface ProductSummary {
  code: string;
  name: string;
  family: string;
  price: number;
  setupFee: number;
  inStockPrice?: number; // cheapest configuration currently in stock
  currency: string;
  specs: Record<string, string> | null;
  orderUrl: string;
  inCatalog: boolean;
  inStock: number;
  total: number;
  lastChange: number;
  locations: Record<string, LocationSummary>;
}

export function summarize(rows: StockRow[], products: Product[], pv?: Provider) {
  const byCode = new Map<string, ProductSummary>();
  const catalog = new Map(products.map((p) => [p.code, p]));
  for (const p of products) {
    byCode.set(p.code, {
      code: p.code, name: p.name, family: p.family, price: p.price, setupFee: p.setupFee, currency: p.currency,
      specs: p.specs, orderUrl: p.orderUrl, inCatalog: true, inStock: 0, total: 0, lastChange: 0, locations: {},
    });
  }
  const priced = new Map<string, number>(); // config → monthly price, computed once per config
  const best = new Map<string, StockRow>(); // code|location → best row
  const locSet = new Set<string>();
  for (const r of rows) {
    let ps = byCode.get(r.productCode);
    if (!ps) {
      ps = { code: r.productCode, name: r.productCode, family: "", price: 0, setupFee: 0, currency: "", specs: null, orderUrl: "", inCatalog: false, inStock: 0, total: 0, lastChange: 0, locations: {} };
      byCode.set(r.productCode, ps);
    }
    locSet.add(r.location);
    const ls = (ps.locations[r.location] ??= { status: r.status, raw: r.rawState, inStock: 0, total: 0 });
    ls.total++;
    ps.total++;
    if (inStock(r.status)) {
      ls.inStock++;
      ps.inStock++;
      let v = priced.get(r.config);
      if (v === undefined) {
        v = priceOf(pv, catalog.get(r.productCode), r.config)?.price ?? 0;
        priced.set(r.config, v);
      }
      if (v > 0 && (!ps.inStockPrice || v < ps.inStockPrice)) ps.inStockPrice = v;
    }
    const k = r.productCode + "|" + r.location;
    const b = best.get(k);
    if (!b || better(r, b)) {
      best.set(k, r);
      ls.status = r.status;
      ls.raw = r.rawState;
    }
    if (r.changedAt > ps.lastChange) ps.lastChange = r.changedAt;
  }
  const out = [...byCode.values()].filter((p) => p.total > 0 || p.inCatalog);
  out.sort((a, b) =>
    a.inCatalog !== b.inCatalog ? (a.inCatalog ? -1 : 1)
      : a.family !== b.family ? (a.family < b.family ? -1 : 1)
        : a.price !== b.price ? a.price - b.price
          : a.code < b.code ? -1 : 1);
  return {
    products: out.map((p) => ({ ...p, lastChange: iso(p.lastChange) })),
    locations: [...locSet].sort(),
  };
}

// The configurations of one product with their per-location state.
export function detail(rows: StockRow[], code: string, prod: Product | undefined, pv?: Provider) {
  const byCfg = new Map<string, { config: string; extra: Record<string, string> | null; price: ConfigPrice | null; locations: Record<string, { status: StockStatus; raw: string; changedAt: string }> }>();
  const locSet = new Set<string>();
  for (const r of rows) {
    if (r.productCode !== code) continue;
    let c = byCfg.get(r.config);
    if (!c) {
      c = { config: r.config, extra: r.extra ?? null, price: priceOf(pv, prod, r.config), locations: {} };
      byCfg.set(r.config, c);
    }
    c.locations[r.location] = { status: r.status, raw: r.rawState, changedAt: iso(r.changedAt) };
    locSet.add(r.location);
  }
  return {
    configs: [...byCfg.values()].sort((a, b) => (a.config < b.config ? -1 : 1)),
    locations: [...locSet].sort(),
  };
}

// The in-stock slot of a product to order: the cheapest priced configuration, else the first in stock.
// location "" means any location. Empty config when nothing is in stock.
export function cheapestInStock(rows: StockRow[], prod: Product, location: string, pv?: Provider): { config: string; location: string } {
  let config = "", loc = "", bestPrice = 0;
  for (const r of rows) {
    if (r.productCode !== prod.code || (location && r.location !== location) || !inStock(r.status)) continue;
    const cp = priceOf(pv, prod, r.config);
    if (!config || (cp && (bestPrice === 0 || cp.price < bestPrice))) [config, loc, bestPrice] = [r.config, r.location, cp?.price ?? 0];
  }
  return { config, location: loc };
}
