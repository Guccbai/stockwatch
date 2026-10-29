import { inStock, slotKey, type Availability, type StockEvent, type StockRow, type StockStatus } from "./types";

export type Kind = "none" | "restock" | "soldout";

export function classify(from: StockStatus, to: StockStatus): Kind {
  if (!inStock(from) && inStock(to)) return "restock";
  if (inStock(from) && !inStock(to)) return "soldout";
  return "none";
}

export interface DiffResult {
  upserts: StockRow[];
  deletes: string[];
  events: StockEvent[];
}

// Compares a fresh fetch for one target with its previous state. Slots seen for the first time
// are stored without an event so a fresh install doesn't flood alerts.
// What diff needs to know about a slot's previous state; kept small because a region has ~40k slots.
export type PrevSlot = Pick<StockRow, "status" | "rawState" | "changedAt">;

export function diff(prev: Map<string, PrevSlot>, fresh: Availability[], now: number): DiffResult {
  const r: DiffResult = { upserts: [], deletes: [], events: [] };
  const seen = new Set<string>();
  for (const a of fresh) {
    const k = slotKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    const old = prev.get(k);
    if (!old) {
      r.upserts.push({ ...a, changedAt: now });
    } else if (old.status !== a.status) {
      r.upserts.push({ ...a, changedAt: now });
      r.events.push({
        key: k, provider: a.provider, region: a.region, productCode: a.productCode,
        config: a.config, location: a.location, from: old.status, to: a.status, rawState: a.rawState, at: now,
      });
    } else if (old.rawState !== a.rawState) {
      // Same normalized status but different delivery estimate: keep the state fresh, no event.
      r.upserts.push({ ...a, changedAt: old.changedAt });
    }
  }
  for (const k of prev.keys()) if (!seen.has(k)) r.deletes.push(k);
  return r;
}
