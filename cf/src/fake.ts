// Demo provider whose stock flips one slot per poll (port of internal/provider/fake). The state is a
// pure function of the persisted poll counter, so it survives Durable Object eviction.
import type { Availability, Provider } from "./types";

const products = ["fake-small", "fake-large"];
const configs = ["ram-16g.ssd-500", "ram-64g.nvme-2000"];
const locations = ["aaa", "bbb"];

export const fake: Provider = {
  id: "fake",
  name: "Fake Cloud",
  regions: [{ id: "test", name: "测试区域", currency: "EUR" }],
  async fetchCatalog(region) {
    return [
      { provider: "fake", region, code: "fake-small", name: "FAKE-S", family: "Fake", specs: { cpu: "Fake CPU 4c" }, price: 4.99, setupFee: 0, currency: "EUR", locations, orderUrl: "https://example.com/order" },
      { provider: "fake", region, code: "fake-large", name: "FAKE-L", family: "Fake", specs: { cpu: "Fake CPU 16c" }, price: 39.99, setupFee: 0, currency: "EUR", locations, orderUrl: "https://example.com/order" },
    ];
  },
  async fetchAvailability(region, _signal, step) {
    const n = products.length * configs.length * locations.length;
    const out: Availability[] = [];
    let i = 0;
    for (const prod of products) {
      for (const cfg of configs) {
        for (const loc of locations) {
          // Slot i has been flipped once for every step s in [0, step] with s % n == i.
          const flips = step >= i ? Math.floor((step - i) / n) + 1 : 0;
          const up = flips % 2 === 1;
          out.push({
            provider: "fake", region, productCode: prod, config: `${prod}.${cfg}`, location: loc,
            status: up ? "available" : "unavailable", rawState: up ? "1H-high" : "unavailable",
          });
          i++;
        }
      }
    }
    return out;
  },
};
