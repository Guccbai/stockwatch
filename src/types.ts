// Shared shapes between the Worker, the Durable Objects and the WebUI.

export type StockStatus = "available" | "low" | "unavailable" | "unknown";

export const inStock = (s: StockStatus) => s === "available" || s === "low";

export interface Availability {
  provider: string;
  region: string;
  productCode: string;
  config: string; // vendor-specific configuration id (OVH: fqn)
  location: string;
  status: StockStatus;
  rawState: string;
  extra?: Record<string, string>;
}

export const slotKey = (a: Pick<Availability, "provider" | "region" | "config" | "location">) =>
  [a.provider, a.region, a.config, a.location].join("|");

export interface StockRow extends Availability {
  changedAt: number; // unix ms
}

export interface StockEvent {
  id?: number;
  key: string;
  provider: string;
  region: string;
  productCode: string;
  config: string;
  location: string;
  from: StockStatus;
  to: StockStatus;
  rawState: string;
  at: number;
}

export interface Product {
  provider: string;
  region: string;
  code: string;
  name: string;
  family: string;
  specs: Record<string, string>;
  price: number; // monthly, excluding tax
  setupFee: number;
  currency: string;
  locations: string[];
  orderUrl: string;
  options?: Option[];
}

// One orderable hardware choice (memory, storage, bandwidth…) priced on top of the base plan.
export interface Option {
  family: string;
  code: string;
  price: number; // monthly surcharge, excluding tax
  setupFee: number;
}

// What one concrete configuration costs (base plan plus its options).
export interface ConfigPrice {
  price: number;
  setupFee: number;
}

export interface Subscription {
  id: number;
  provider: string;
  region: string;
  productCode: string;
  locations: string[];
  configs: string[];
  configFilter: string;
  notifyOn: "restock" | "all";
  enabled: boolean;
  note: string;
  createdAt: number;
}

export function matches(s: Subscription, a: Pick<Availability, "provider" | "region" | "productCode" | "config" | "location">): boolean {
  if (s.provider !== a.provider || s.region !== a.region || s.productCode !== a.productCode) return false;
  if (s.locations.length > 0 && !s.locations.includes(a.location)) return false;
  if (s.configs.length > 0 && !s.configs.includes(a.config)) return false;
  if (s.configFilter !== "" && !a.config.includes(s.configFilter)) return false;
  return true;
}

export interface Target {
  provider: string;
  region: string;
}

export const targetKey = (t: Target) => `${t.provider}/${t.region}`;

export interface Provider {
  id: string;
  name: string;
  regions: { id: string; name: string; currency: string }[];
  fetchCatalog(region: string, signal: AbortSignal): Promise<Product[]>;
  // step is a persistent per-target poll counter; only the fake provider uses it.
  fetchAvailability(region: string, signal: AbortSignal, step: number): Promise<Availability[]>;
  // Optional: price of one configuration; null when it can't be matched to catalog options.
  configPrice?(p: Product, config: string): ConfigPrice | null;
  // Optional: deep link to an order pre-filled with one configuration at one location.
  orderUrl?(p: Product, config: string, location: string): string | null;
}
