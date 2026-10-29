// Pure-logic tests against recorded OVH fixtures (test/testdata).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, diff } from "../src/diff";
import { fake } from "../src/fake";
import * as labels from "../src/labels";
import { configPrice, convertAvailability, convertCatalog, jsurlString, mapStatus, matchOption, orderUrl, ovh } from "../src/ovh";
import { plainText, subject } from "../src/resend";
import { cheapestInStock, summarize } from "../src/stock";
import { formatAlert } from "../src/telegram";
import { matches, slotKey, type Availability, type StockRow, type Subscription } from "../src/types";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8"));

describe("ovh", () => {
  it("maps statuses", () => {
    const cases: Record<string, string> = {
      unavailable: "unavailable", comingSoon: "unavailable", unknown: "unknown", "": "unknown",
      "1H-low": "low", "1H-high": "available", "72H": "available", "480H": "available", weird: "unknown",
    };
    for (const [raw, want] of Object.entries(cases)) expect(mapStatus(raw)).toBe(want);
  });

  it("converts availability", () => {
    const got = convertAvailability("eu", fixture("availabilities.json"));
    expect(got).toHaveLength(14);
    expect(got[0]).toMatchObject({
      provider: "ovh", region: "eu", productCode: "24sk602", location: "bhs", status: "low", rawState: "1H-low",
      config: "24sk602.ram-128g-ecc-2400.softraid-2x1000nvme", extra: { memory: "ram-128g-ecc-2400" },
    });
    const counts: Record<string, number> = {};
    for (const a of got) counts[a.status] = (counts[a.status] ?? 0) + 1;
    expect(counts).toEqual({ available: 1, low: 1, unavailable: 12 });
  });

  it("converts the catalog", () => {
    const byCode = new Map(convertCatalog("eu", fixture("catalog.json")).map((p) => [p.code, p]));
    const ks = byCode.get("24sk602")!;
    expect(ks).toMatchObject({ name: "KS-6", family: "Kimsufi", currency: "EUR", price: 38.99, setupFee: 38.99 });
    expect(ks.specs.cpu).toBeTruthy();
    expect(ks.locations.length).toBeGreaterThan(0);
    expect(byCode.get("24adv01-v3")).toMatchObject({ family: "Advance", specs: { cores: "6c/12t" } });
  });
});

describe("diff", () => {
  it("classifies transitions", () => {
    expect(classify("unavailable", "available")).toBe("restock");
    expect(classify("unknown", "low")).toBe("restock");
    expect(classify("available", "unavailable")).toBe("soldout");
    expect(classify("low", "unknown")).toBe("soldout");
    expect(classify("available", "low")).toBe("none");
    expect(classify("unavailable", "unknown")).toBe("none");
  });

  const slot = (config: string, location: string, status: Availability["status"], rawState: string): Availability =>
    ({ provider: "p", region: "r", productCode: "prod", config, location, status, rawState });

  it("records only transitions", () => {
    const a = slot("c1", "gra", "unavailable", "unavailable");
    const b = slot("c1", "rbx", "available", "72H");
    const gone = slot("c2", "gra", "unavailable", "unavailable");
    const prev = new Map<string, StockRow>([a, b, gone].map((s) => [slotKey(s), { ...s, changedAt: 1 }]));
    const fresh = slot("c3", "sbg", "available", "72H");
    const d = diff(prev, [slot("c1", "gra", "available", "1H-high"), slot("c1", "rbx", "available", "1H-high"), fresh, fresh], 1000);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ key: slotKey(a), from: "unavailable", to: "available" });
    expect(d.upserts).toHaveLength(3);
    expect(d.upserts.find((u) => slotKey(u) === slotKey(b))!.changedAt).toBe(1);
    expect(d.deletes).toEqual([slotKey(gone)]);
  });
});

describe("subscriptions", () => {
  const sub: Subscription = {
    id: 1, provider: "ovh", region: "eu", productCode: "ks-1", locations: ["gra"], configs: [],
    configFilter: "nvme", notifyOn: "restock", enabled: true, note: "", createdAt: 0,
  };
  const a = { provider: "ovh", region: "eu", productCode: "ks-1", config: "ks-1.ram-32g.nvme-1000", location: "gra" };
  it("matches location and filter", () => {
    expect(matches(sub, a)).toBe(true);
    expect(matches(sub, { ...a, location: "rbx" })).toBe(false);
    expect(matches(sub, { ...a, config: "ks-1.ram-32g.ssd-1000" })).toBe(false);
    expect(matches({ ...sub, configs: ["other"] }, a)).toBe(false);
  });
});

describe("fake provider", () => {
  it("flips exactly one slot per poll", async () => {
    const signal = new AbortController().signal;
    let prev = await fake.fetchAvailability("test", signal, -1);
    expect(prev.every((s) => s.status === "unavailable")).toBe(true);
    for (let step = 0; step < 20; step++) {
      const cur = await fake.fetchAvailability("test", signal, step);
      expect(cur.filter((s, i) => s.status !== prev[i].status)).toHaveLength(1);
      prev = cur;
    }
  });
});

describe("telegram", () => {
  it("formats an alert", () => {
    const text = formatAlert({
      subscription: { id: 1, provider: "ovh", region: "eu", productCode: "ks-1", locations: [], configs: [], configFilter: "", notifyOn: "all", enabled: true, note: "a<b", createdAt: 0 },
      regionLabel: "OVHcloud · 欧洲",
      product: { provider: "ovh", region: "eu", code: "ks-1", name: "KS-1", family: "Kimsufi", specs: { cpu: "Intel Atom" }, price: 4.99, setupFee: 0, currency: "EUR", locations: [], orderUrl: "https://eco.ovhcloud.com/fr/" },
      events: [
        { key: "k1", provider: "ovh", region: "eu", productCode: "ks-1", config: "ks-1.ram-4g", location: "gra", from: "unavailable", to: "available", rawState: "72H", at: 0 },
        { key: "k2", provider: "ovh", region: "eu", productCode: "ks-1", config: "ks-1.ram-8g", location: "rbx", from: "available", to: "unavailable", rawState: "unavailable", at: 0 },
      ],
    });
    expect(text).toContain("🟢 <b>补货</b> <b>KS-1</b> <code>ks-1</code> · OVHcloud · 欧洲");
    expect(text).toContain("• <b>🇫🇷 格拉沃利讷 (GRA)</b> 内存 4GB · 72 小时内交付");
    expect(text).toContain("<b>已售罄：</b>\n• <b>🇫🇷 鲁贝 (RBX)</b> 内存 8GB");
    expect(text).toContain("📝 a&lt;b");
    expect(text).toContain('<a href="https://eco.ovhcloud.com/fr/">前往下单 →</a>');
  });
});

describe("labels", () => {
  it("renders hardware codes", () => {
    const cases: [(s: string) => string, string, string][] = [
      [labels.memory, "ram-64g-ddr5-on-die-ecc-3600-25rises01-v2", "64GB DDR5 ECC 3600MHz"],
      [labels.memory, "ram-32g-noecc-2133-24skgame01", "32GB 非 ECC 2133MHz"],
      [labels.memory, "ram-16g-ecc-2133-24sk40-v1-us", "16GB ECC 2133MHz"],
      [labels.storage, "hybridsoftraid-2x960nvme-pcie-gen4-2x3840nvme-pcie-gen4", "2×960GB NVMe + 2×3.84TB NVMe · 混合软 RAID"],
      [labels.storage, "noraid-1x120ssd-25skb01", "1×120GB SSD"],
      [labels.storage, "softraid-2x22000sas-24advstor01-v3", "2×22TB SAS · 软 RAID"],
      [labels.storage, "hybridsoftraid-4x4000sa-1x500nvme-24skstor01-v1", "4×4TB HDD + 1×500GB NVMe · 混合软 RAID"],
      [labels.storage, "softraid-0disk-24rise", "无硬盘 (需另购)"],
      [labels.storage, "noraid-0-24rise07-v1", "无硬盘 (需另购)"],
      [labels.storage, "softraid-2x1920nvme-25risexl01-v1", "2×1.92TB NVMe · 软 RAID"],
      [labels.storage, "softraid-2x2000sa-24sk10-us", "2×2TB HDD · 软 RAID"],
      [labels.bandwidth, "bandwidth-1000-upto-2000-24sys3p-eu", "1Gbps (最高 2Gbps)"],
      [labels.bandwidth, "traffic-10tb-300-apac-ca", "300Mbps · 10TB 流量"],
      [labels.bandwidth, "bandwidth-1000-unguaranteed-rise-gen2", "1Gbps 共享"],
      [labels.location, "rbx", "🇫🇷 鲁贝 (RBX)"],
      [labels.location, "eu-west-par-b", "🇫🇷 巴黎 B 区 (EU-WEST-PAR-B)"],
      [labels.location, "xyz", "XYZ"],
    ];
    for (const [fn, input, want] of cases) expect(fn(input), input).toBe(want);
  });

  it("renders configurations", () => {
    expect(labels.config("24sk602.ram-128g-ecc-2400.softraid-2x1000nvme", "24sk602")).toBe("内存 128GB ECC 2400MHz · 硬盘 2×1TB NVMe · 软 RAID");
    for (const cfg of [
      "24advstor01-v3.ram-128g-on-die-ecc-3600.hardraid-2x22000sas.softraid-2x960nvme-pcie-gen4-system",
      "24risestor01-v1.ram-128g-ecc-2666.softraid-4x14000sas.softraid-2x480ssd",
    ]) {
      const got = labels.config(cfg, cfg.split(".")[0]);
      expect(got.includes("硬盘 2×22TB SAS") || got.includes("硬盘 4×14TB SAS"), got).toBe(true);
      expect(got).toContain("系统盘 2×");
    }
    expect(labels.config("fake-small.cfg-a.cfg-b", "fake-small")).toBe("cfg-a / cfg-b");
  });

  it("sorts locations geographically", () => {
    expect(labels.sortLocations(["sgp", "bhs", "eu-west-par-b", "rbx", "zzz", "eu-west-par-a"])).toEqual(["rbx", "eu-west-par-a", "eu-west-par-b", "bhs", "sgp", "zzz"]);
  });
});

describe("ovh pricing and order links", () => {
  const ks = convertCatalog("eu", fixture("catalog.json")).find((p) => p.code === "24sk602")!;

  it("parses options", () => expect(ks.options).toHaveLength(7));

  it("prices configurations", () => {
    for (const [config, want] of [
      ["24sk602.ram-128g-ecc-2400.softraid-2x4000sa", 38.99],
      ["24sk602.ram-128g-ecc-2400.softraid-2x1000nvme", 38.99 + 15],
      ["24sk602.ram-256g-ecc-2400.softraid-2x8000sa", 38.99 + 32 + 10],
    ] as const) {
      const got = configPrice(ks, config)!;
      expect(got.price).toBeCloseTo(want, 9);
      expect(got.setupFee).toBe(38.99);
    }
    expect(configPrice(ks, "24sk602.ram-512g-ecc-2400.softraid-2x4000sa")).toBeNull();
  });

  it("falls back to unambiguous option matches", () => {
    const opts = [
      { family: "memory", code: "ram-32g-ecc-2400-26sk10b-v1", price: 0, setupFee: 0 },
      { family: "memory", code: "ram-64g-ecc-2400-26sk10b-v1", price: 10, setupFee: 0 },
      { family: "storage", code: "softraid-0disk-24rise", price: 0, setupFee: 0 },
      { family: "storage", code: "hybridsoftraid-2x4000sa-2x512nvme-24sys", price: 20, setupFee: 0 },
    ];
    expect(matchOption(opts, "memory", "ram-32g-ecc-2133")?.code).toBe("ram-32g-ecc-2400-26sk10b-v1");
    expect(matchOption(opts, "storage", "noraid-0")?.code).toBe("softraid-0disk-24rise");
    expect(matchOption(opts, "storage", "hybridsoftraid-2x4000sa-2x512nvme")?.code).toBe("hybridsoftraid-2x4000sa-2x512nvme-24sys");
    expect(matchOption(opts, "storage", "hybridsoftraid-2x4000sa-2x500nvme")).toBeNull();
  });

  it("builds the express order link", () => {
    expect(orderUrl(ks, "24sk602.ram-256g-ecc-2400.softraid-2x8000sa", "gra")).toBe(
      "https://order.eu.ovhcloud.com/fr/express/#/express/review?products=" +
        "~(~(planCode~'24sk602~productId~'eco~pricingMode~'default~quantity~1~duration~'P1M" +
        "~configuration~(~(label~'dedicated_datacenter~value~'gra)~(label~'dedicated_os~value~'none_64.en))" +
        "~option~(~(planCode~'ram-256g-ecc-2400-24sk60~duration~'P1M~pricingMode~'default~quantity~1)" +
        "~(planCode~'softraid-2x8000sa-24sk60~duration~'P1M~pricingMode~'default~quantity~1)" +
        "~(planCode~'bandwidth-500-25sk~duration~'P1M~pricingMode~'default~quantity~1))))",
    );
    expect(orderUrl(ks, "24sk602.ram-512g-ecc-2400.softraid-2x4000sa", "gra")).toBeNull();
    expect(jsurlString("a b$é")).toBe("a*20b!*e9");
  });

  it("summarizes stock and picks the cheapest in-stock configuration", () => {
    const rows = convertAvailability("eu", fixture("availabilities.json")).map((a) => ({ ...a, changedAt: 1000 }));
    const { products, locations } = summarize(rows, [ks], ovh);
    const s = products.find((p) => p.code === "24sk602")!;
    expect(s.inCatalog).toBe(true);
    expect(s.total).toBe(rows.filter((r) => r.productCode === "24sk602").length);
    expect(s.inStock).toBe(2);
    expect(s.locations.bhs.status).toBe("low");
    expect(locations).toEqual([...new Set(rows.map((r) => r.location))].sort());
    const pick = cheapestInStock(rows, ks, "", ovh);
    expect(rows.some((r) => r.config === pick.config && r.location === pick.location && (r.status === "available" || r.status === "low"))).toBe(true);
  });
});

describe("resend", () => {
  it("builds subject and plain text", () => {
    const sub = { id: 1, provider: "ovh", region: "eu", productCode: "24sk602", locations: [], configs: [], configFilter: "", notifyOn: "restock" as const, enabled: true, note: "", createdAt: 0 };
    const ev = { key: "k", provider: "ovh", region: "eu", productCode: "24sk602", config: "c", location: "gra", from: "unavailable" as const, to: "available" as const, rawState: "72H", at: 0 };
    expect(subject({ subscription: sub, regionLabel: "OVHcloud · 欧洲", product: { name: "KS-6" } as never, events: [ev] })).toBe("🟢 补货 KS-6 (24sk602) · OVHcloud · 欧洲");
    expect(plainText('<b>a &amp; b</b>\n<a href="https://x.test/">下单</a>')).toBe("a & b\n下单 https://x.test/");
  });
});
