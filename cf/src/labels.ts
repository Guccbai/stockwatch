// Vendor codes (OVH datacenters, hardware option ids) → readable Chinese text for notifications.
// Port of internal/labels, which mirrors web/src/lib.ts; keep the three in sync.

// Order matters: it is the display order (Europe, North America, Asia-Pacific).
const datacenters: [code: string, city: string, flag: string][] = [
  ["rbx", "鲁贝", "🇫🇷"], ["gra", "格拉沃利讷", "🇫🇷"], ["sbg", "斯特拉斯堡", "🇫🇷"], ["par", "巴黎", "🇫🇷"],
  ["fra", "法兰克福", "🇩🇪"], ["lim", "林堡", "🇩🇪"], ["lon", "伦敦", "🇬🇧"], ["eri", "伦敦", "🇬🇧"],
  ["waw", "华沙", "🇵🇱"], ["mil", "米兰", "🇮🇹"], ["bhs", "博阿努瓦", "🇨🇦"], ["tor", "多伦多", "🇨🇦"],
  ["vin", "弗吉尼亚", "🇺🇸"], ["hil", "俄勒冈", "🇺🇸"], ["sgp", "新加坡", "🇸🇬"], ["syd", "悉尼", "🇦🇺"],
  ["ynm", "孟买", "🇮🇳"], ["mum", "孟买", "🇮🇳"],
];

// Multi-AZ locations look like "eu-west-par-a": city code + availability zone letter.
const azRe = /^[a-z]{2}-[a-z]+-([a-z]{3})-([a-z])$/;

function lookup(code: string): { dc?: (typeof datacenters)[number]; zone: string; order: number } {
  let key = code, zone = "";
  const m = azRe.exec(code);
  if (m) [key, zone] = [m[1], m[2]];
  const i = datacenters.findIndex((d) => d[0] === key);
  if (i < 0) return { zone: "", order: 1 << 20 };
  return { dc: datacenters[i], zone, order: i * 10 + (zone ? zone.charCodeAt(0) - 96 : 0) };
}

// "rbx" → "🇫🇷 鲁贝 (RBX)"; unknown codes come back upper-cased.
export function location(code: string): string {
  const { dc, zone } = lookup(code);
  if (!dc) return code.toUpperCase();
  return `${dc[2]} ${dc[1]}${zone ? ` ${zone.toUpperCase()} 区` : ""} (${code.toUpperCase()})`;
}

// Orders codes geographically (same order as the web UI's columns).
export function sortLocations(codes: string[]): string[] {
  return [...codes].sort((a, b) => lookup(a).order - lookup(b).order || (a < b ? -1 : a > b ? 1 : 0));
}

export const locations = (codes: string[]) => sortLocations(codes).map(location).join("、");

// --- OVH hardware option codes ---

const diskKind: Record<string, string> = { nvme: "NVMe", ssd: "SSD", sa: "HDD", sas: "SAS", hdd: "HDD" };
const raidKind: Record<string, string> = { softraid: "软 RAID", hybridsoftraid: "混合软 RAID", hardraid: "硬 RAID" };

const size = (gb: number) => (gb < 1000 ? `${gb}GB` : `${gb / 1000}TB`);

// "ram-64g-ddr5-on-die-ecc-3600-25rises01-v2" → "64GB DDR5 ECC 3600MHz".
export function memory(code: string): string {
  const m = /^ram-(\d+)g(.*)$/.exec(code);
  if (!m) return code;
  const rest = m[2];
  const parts = [m[1] + "GB"];
  const ddr = /-ddr(\d)/.exec(rest);
  if (ddr) parts.push("DDR" + ddr[1]);
  if (rest.includes("-noecc")) parts.push("非 ECC");
  else if (rest.includes("-ecc")) parts.push("ECC");
  const speed = /-(?:no)?ecc-(\d{4})/.exec(rest);
  if (speed) parts.push(speed[1] + "MHz");
  return parts.join(" ");
}

// "hybridsoftraid-2x960nvme-pcie-gen4-2x3840nvme-pcie-gen4" → "2×960GB NVMe + 2×3.84TB NVMe · 混合软 RAID".
export function storage(code: string): string {
  const groups = [...code.matchAll(/(\d+)x(\d+)(nvme|ssd|sas|sa|hdd)(?:[^a-z]|$)/g)];
  if (!groups.length) return /0disk|noraid-0(?:-|$)/.test(code) ? "无硬盘 (需另购)" : code;
  let count = 0;
  let text = groups.map((g) => {
    count += Number(g[1]);
    return `${g[1]}×${size(Number(g[2]))} ${diskKind[g[3]]}`;
  }).join(" + ");
  const r = /^([a-z]+raid)-/.exec(code);
  if (r && raidKind[r[1]] && count > 1) text += " · " + raidKind[r[1]];
  return text;
}

// "bandwidth-1000-upto-2000-24sys3p" → "1Gbps (最高 2Gbps)"; "traffic-10tb-300-apac" → "300Mbps · 10TB 流量".
export function bandwidth(code: string): string {
  const speed = (s: string) => (Number(s) >= 1000 ? `${Number(s) / 1000}Gbps` : `${s}Mbps`);
  const m = /^bandwidth-(\d+)(?:-upto-(\d+))?/.exec(code);
  if (m) {
    let s = speed(m[1]);
    if (m[2]) s += ` (最高 ${speed(m[2])})`;
    if (code.includes("unguaranteed")) s += " 共享";
    return s;
  }
  const t = /^traffic-(\d+)tb-(\d+)/.exec(code);
  if (t) return `${speed(t[2])} · ${t[1]}TB 流量`;
  return code;
}

// An OVH fqn ("plan.ram-….softraid-…") → "内存 128GB ECC 2400MHz · 硬盘 2×1TB NVMe · 软 RAID". STOR servers
// have a second disk group for the OS ("-system" suffix on Advance, plain on Rise), shown as 系统盘.
export function config(cfg: string, productCode: string): string {
  const c = cfg.startsWith(productCode + ".") ? cfg.slice(productCode.length + 1) : cfg;
  let mem = "";
  const disks: string[] = [];
  for (const p of c.split(".")) {
    if (p.startsWith("ram-")) mem = memory(p);
    else if (p.includes("raid") || p.includes("disk")) disks.push(p);
  }
  if (!mem && !disks.length) return c.replaceAll(".", " / ");
  let sys = disks.find((d) => d.endsWith("-system")) ?? "";
  if (!sys && disks.length > 1) sys = disks[1];
  const sto = disks.find((d) => d !== sys) ?? "";
  const parts: string[] = [];
  if (mem) parts.push("内存 " + mem);
  if (sto) parts.push("硬盘 " + storage(sto));
  if (sys) parts.push("系统盘 " + storage(sys));
  return parts.join(" · ");
}
