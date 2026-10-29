// OVHcloud dedicated servers via OVH's public, unauthenticated API.
import type { Availability, ConfigPrice, Option, Product, Provider, StockStatus } from "./types";

interface RegionInfo {
  id: string;
  name: string;
  currency: string;
  apiBase: string;
  subsidiary: string;
  orderUrl: string;
  expressUrl: string; // OVH's "express order" app, which accepts a pre-filled cart (see orderUrl below)
}

const regions: RegionInfo[] = [
  { id: "eu", name: "欧洲", currency: "EUR", apiBase: "https://eu.api.ovh.com/1.0", subsidiary: "FR", orderUrl: "https://eco.ovhcloud.com/fr/", expressUrl: "https://order.eu.ovhcloud.com/fr/express/" },
  { id: "ca", name: "加拿大", currency: "CAD", apiBase: "https://ca.api.ovh.com/1.0", subsidiary: "CA", orderUrl: "https://eco.ovhcloud.com/en-ca/", expressUrl: "https://order.ca.ovhcloud.com/en/express/" },
  { id: "us", name: "美国", currency: "USD", apiBase: "https://api.us.ovhcloud.com/1.0", subsidiary: "US", orderUrl: "https://eco.us.ovhcloud.com/", expressUrl: "https://order.us.ovhcloud.com/en/express/" },
];

function lookupRegion(id: string): RegionInfo {
  const r = regions.find((r) => r.id === id);
  if (!r) throw new Error(`ovh: unknown region "${id}"`);
  return r;
}

async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const resp = await fetch(url, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "stockwatch/1.0 (+https://github.com/Guccbai/stockwatch)" },
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 512).trim();
    throw new Error(`ovh: GET ${url}: ${resp.status} ${resp.statusText}: ${body}`);
  }
  return resp.json<T>();
}

// --- availability ---

export interface AvailabilityEntry {
  fqn: string;
  planCode: string;
  server: string;
  memory: string;
  storage: string;
  systemStorage?: string;
  datacenters: { availability: string; datacenter: string }[];
}

// Converts OVH availability strings ("1H-high", "72H", "unavailable", …) to a normalized status.
export function mapStatus(raw: string): StockStatus {
  if (raw === "unavailable" || raw === "comingSoon") return "unavailable";
  if (raw === "" || raw === "unknown") return "unknown";
  if (raw.endsWith("-low")) return "low";
  if (raw.endsWith("H") || raw.endsWith("-high")) return "available";
  return "unknown";
}

export function convertAvailability(region: string, entries: AvailabilityEntry[]): Availability[] {
  const out: Availability[] = [];
  for (const e of entries) {
    const extra: Record<string, string> = { memory: e.memory, storage: e.storage };
    if (e.systemStorage) extra.systemStorage = e.systemStorage;
    for (const dc of e.datacenters ?? []) {
      out.push({
        provider: "ovh", region, productCode: e.planCode, config: e.fqn, location: dc.datacenter,
        status: mapStatus(dc.availability), rawState: dc.availability, extra,
      });
    }
  }
  return out;
}

// --- catalog ---

interface Pricing {
  capacities: string[];
  commitment: number;
  interval: number;
  intervalUnit: string;
  mode: string;
  price: number; // in 1e-8 of the currency unit
}

export interface Catalog {
  locale?: { currencyCode?: string };
  plans: {
    planCode: string;
    invoiceName: string;
    product: string;
    pricings: Pricing[];
    configurations?: { name: string; values: string[] }[];
    addonFamilies?: { name: string; default?: string; addons: string[] }[];
  }[];
  addons?: { planCode: string; pricings: Pricing[] }[];
  products: {
    name: string;
    description: string;
    blobs?: { technical?: { server?: { range?: string; cpu?: { brand?: string; model?: string; cores?: number; threads?: number; frequency?: number; number?: number } } } };
  }[];
}

// Monthly renewal and one-time installation price of the plain pay-monthly offer; -1 when absent.
function noCommitment(ps: Pricing[]): [number, number] {
  let monthly = -1, setup = -1;
  for (const p of ps ?? []) {
    if (p.mode !== "default" || p.commitment !== 0) continue;
    if (p.interval === 1 && p.intervalUnit === "month" && p.capacities.includes("renew") && (monthly < 0 || p.price < monthly)) monthly = p.price;
    if (p.capacities.includes("installation") && (setup < 0 || p.price < setup)) setup = p.price;
  }
  return [monthly, setup];
}

const money = (v: number) => Math.max(v, 0) / 1e8;

const familyByPrefix: [string, string][] = [
  ["KS-", "Kimsufi"], ["SYS-", "So you Start"], ["RISE-", "Rise"],
  ["ADVANCE-", "Advance"], ["SCALE-", "Scale"], ["HGR-", "High Grade"],
];

// The addon families that make up a server configuration.
const pricedFamilies = new Set(["memory", "storage", "system-storage", "bandwidth"]);

export function convertCatalog(regionId: string, c: Catalog): Product[] {
  const r = lookupRegion(regionId);
  const techs = new Map<string, { rng: string; cpu: string; cores: number; threads: number; freq: number }>();
  for (const pr of c.products ?? []) {
    const t = { rng: "", cpu: pr.description, cores: 0, threads: 0, freq: 0 };
    const s = pr.blobs?.technical?.server;
    if (s) {
      t.rng = s.range ?? "";
      if (s.cpu) {
        t.cpu = `${s.cpu.brand ?? ""} ${s.cpu.model ?? ""}`.trim();
        t.cores = s.cpu.cores ?? 0;
        t.threads = s.cpu.threads ?? 0;
        t.freq = s.cpu.frequency ?? 0;
        if ((s.cpu.number ?? 0) > 1) t.cpu = `${s.cpu.number}x ${t.cpu}`;
      }
    }
    techs.set(pr.name, t);
  }
  const addonPrice = new Map<string, [number, number]>();
  for (const a of c.addons ?? []) addonPrice.set(a.planCode, noCommitment(a.pricings));
  const currency = c.locale?.currencyCode || r.currency;
  return (c.plans ?? []).map((pl) => {
    let name = pl.invoiceName;
    const bar = name.indexOf("|");
    if (bar > 0) name = name.slice(0, bar).trim();
    const t = techs.get(pl.product);
    let family = t?.rng ? t.rng[0].toUpperCase() + t.rng.slice(1) : "";
    for (const [prefix, f] of familyByPrefix) {
      if (name.toUpperCase().startsWith(prefix)) {
        family = f;
        break;
      }
    }
    const specs: Record<string, string> = {};
    if (t?.cpu) specs.cpu = t.cpu;
    if (t && t.cores > 0) specs.cores = `${t.cores}c/${t.threads}t`;
    if (t && t.freq > 0) specs.frequency = `${t.freq.toFixed(1)} GHz`;
    const options: Option[] = [];
    for (const af of pl.addonFamilies ?? []) {
      if (!pricedFamilies.has(af.name)) continue;
      if (af.default) specs[af.name] = af.default;
      for (const code of af.addons) {
        const ap = addonPrice.get(code);
        if (ap) options.push({ family: af.name, code, price: money(ap[0]), setupFee: money(ap[1]) });
      }
    }
    const [price, setup] = noCommitment(pl.pricings);
    return {
      provider: "ovh", region: r.id, code: pl.planCode, name, family, specs,
      price: money(price), setupFee: money(setup), currency,
      locations: pl.configurations?.find((c) => c.name === "dedicated_datacenter")?.values ?? [],
      orderUrl: r.orderUrl, options,
    };
  });
}

// --- configuration pricing ---

// Prices an availability fqn ("24adv01-v3.ram-128g-on-die-ecc-3600.softraid-2x960nvme-pcie-gen4") as base
// plan + matching memory and storage options + the default bandwidth option.
//
// Availability codes are catalog option codes without the plan suffix ("ram-32g-ecc-2133" vs
// "ram-32g-ecc-2133-24sk10"), so options are matched by prefix, falling back to an unambiguous match on
// memory size or disk layout when the two feeds disagree on details (≈1% of slots).
export function configPrice(prod: Product, config: string): ConfigPrice | null {
  if (prod.price <= 0) return null;
  const opts = configOptions(prod, config);
  if (!opts) return null;
  let price = prod.price, setupFee = prod.setupFee;
  for (const o of opts) {
    price += o.price;
    setupFee += o.setupFee;
  }
  return { price: cents(price), setupFee: cents(setupFee) };
}

// The catalog options an fqn is made of, plus the default bandwidth.
function configOptions(prod: Product, config: string): Option[] | null {
  if (!prod.options?.length) return null;
  const out: Option[] = [];
  let seenStorage = false;
  const prefix = prod.code + ".";
  for (const part of (config.startsWith(prefix) ? config.slice(prefix.length) : config).split(".")) {
    let family: string;
    if (part.startsWith("ram-")) family = "memory";
    // STOR servers have separate OS disks: suffixed "-system" on Advance, the second disk group on Rise.
    else if (part.endsWith("-system") || (seenStorage && part.includes("raid"))) family = "system-storage";
    else if (part.includes("raid") || part.includes("disk")) {
      family = "storage";
      seenStorage = true;
    } else continue;
    const o = matchOption(prod.options, family, part);
    if (!o) return null;
    out.push(o);
  }
  if (!out.length) return null;
  // Bandwidth isn't part of the fqn; the default option is what an order gets unless upgraded.
  const bw = prod.specs.bandwidth;
  if (bw) for (const o of prod.options) if (o.family === "bandwidth" && o.code === bw) out.push(o);
  return out;
}

// Drops float noise from summing prices (36.989999… → 36.99).
const cents = (v: number) => Math.round(v * 100) / 100;

// A storage code's disks ("2x960nvme+2x1920nvme"), ignoring RAID mode and suffixes; diskless codes map to "none".
function diskLayout(code: string): string {
  const groups = [...code.matchAll(/(\d+)x(\d+)(nvme|ssd|sas|sa|hdd)(?:[^a-z]|$)/g)];
  return groups.length ? groups.map((g) => `${g[1]}x${g[2]}${g[3]}`).join("+") : "none";
}

export function matchOption(opts: Option[], family: string, code: string): Option | null {
  let key = "";
  if (family === "memory") key = /^ram-(\d+g)-/.exec(code)?.[1] ?? "";
  else key = diskLayout(code);
  const prefix: Option[] = [], fuzzy: Option[] = [];
  for (const o of opts) {
    if (o.family !== family) continue;
    if (o.code === code) return o;
    if (o.code.startsWith(code + "-")) prefix.push(o);
    if (key && (family === "memory" ? o.code.startsWith(`ram-${key}-`) : diskLayout(o.code) === key)) fuzzy.push(o);
  }
  // Several options can share a prefix ("…-24sk10" and "…-24sk10-v2"); the shortest is the plain one.
  if (prefix.length) return prefix.reduce((a, b) => (b.code.length < a.code.length ? b : a));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// --- pre-filled order links ---

// Links to OVH's express order review page with the cart pre-filled: the plan at one datacenter, the
// configuration's memory/storage options and the default bandwidth, pay monthly, no OS. The user still
// signs in and pays on OVH. The express app reads ?products= as a JSURL-encoded list.
export function orderUrl(prod: Product, config: string, location: string): string | null {
  const r = regions.find((r) => r.id === prod.region);
  if (!r?.expressUrl || !location) return null;
  const opts = configOptions(prod, config);
  if (!opts) return null;
  const item = (planCode: string): JsObj => [["planCode", planCode], ["duration", "P1M"], ["pricingMode", "default"], ["quantity", 1]];
  const plan: JsObj = [
    ["planCode", prod.code], ["productId", "eco"], ["pricingMode", "default"], ["quantity", 1], ["duration", "P1M"],
    ["configuration", { arr: [
      [["label", "dedicated_datacenter"], ["value", location]],
      [["label", "dedicated_os"], ["value", "none_64.en"]],
    ] }],
    ["option", { arr: opts.map((o) => item(o.code)) }],
  ];
  return r.expressUrl + "#/express/review?products=" + jsurl({ arr: [plan] });
}

// Minimal JSURL encoder (https://github.com/Sage/jsurl). Objects are ordered pairs so links are stable.
type JsVal = string | number | JsObj | { arr: JsVal[] };
type JsObj = [string, JsVal][];

function jsurl(v: JsVal): string {
  if (typeof v === "string") return "~'" + jsurlString(v);
  if (typeof v === "number") return "~" + v;
  if ("arr" in v) return "~(" + (v.arr.length ? v.arr.map(jsurl).join("") : "~") + ")";
  return "~(" + v.map(([k, x]) => jsurlString(k) + jsurl(x)).join("~") + ")";
}

// Keeps [A-Za-z0-9_.-] and escapes everything else the way JSURL does ($ → !, *XX, **XXXX).
export function jsurlString(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (/[A-Za-z0-9_.-]/.test(ch)) out += ch;
    else if (ch === "$") out += "!";
    else if (c < 0x100) out += "*" + c.toString(16).padStart(2, "0");
    else out += "**" + c.toString(16).padStart(4, "0");
  }
  return out;
}

export const ovh: Provider = {
  id: "ovh",
  name: "OVHcloud",
  regions: regions.map(({ id, name, currency }) => ({ id, name, currency })),
  async fetchAvailability(region, signal) {
    const r = lookupRegion(region);
    return convertAvailability(region, await getJSON<AvailabilityEntry[]>(`${r.apiBase}/dedicated/server/datacenter/availabilities`, signal));
  },
  async fetchCatalog(region, signal) {
    const r = lookupRegion(region);
    return convertCatalog(region, await getJSON<Catalog>(`${r.apiBase}/order/catalog/public/eco?ovhSubsidiary=${encodeURIComponent(r.subsidiary)}`, signal));
  },
  configPrice,
  orderUrl,
};

// Raw fetch used by /api/probe to check whether OVH answers requests from Cloudflare's egress.
export async function probe(region: string): Promise<{ region: string; status: number; ms: number; bytes: number; entries?: number; error?: string }> {
  const r = lookupRegion(region);
  const start = Date.now();
  try {
    const resp = await fetch(`${r.apiBase}/dedicated/server/datacenter/availabilities`, {
      headers: { Accept: "application/json", "User-Agent": "stockwatch/1.0 (+https://github.com/Guccbai/stockwatch)" },
      signal: AbortSignal.timeout(45_000),
    });
    const body = await resp.text();
    let entries: number | undefined;
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j)) entries = j.length;
    } catch {}
    return { region, status: resp.status, ms: Date.now() - start, bytes: body.length, entries, error: resp.ok ? undefined : body.slice(0, 200) };
  } catch (e) {
    return { region, status: 0, ms: Date.now() - start, bytes: 0, error: String(e) };
  }
}
