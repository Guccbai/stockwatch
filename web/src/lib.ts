import type { StockStatus, Target } from './api'

export const statusLabel: Record<StockStatus, string> = {
  available: '有货',
  low: '少量',
  unavailable: '无货',
  unknown: '未知',
}

export const isInStock = (s: StockStatus) => s === 'available' || s === 'low'

export interface LocationInfo {
  code: string
  city: string // short Chinese name, e.g. 鲁贝 / 巴黎 A 区
  country: string
  flag: string
  order: number // sort key: Europe, then North America, then Asia-Pacific
}

// OVH datacenter codes. Order matters: it is the column order on the stock page.
const datacenters: [code: string, city: string, country: string, flag: string][] = [
  ['rbx', '鲁贝', '法国', '🇫🇷'],
  ['gra', '格拉沃利讷', '法国', '🇫🇷'],
  ['sbg', '斯特拉斯堡', '法国', '🇫🇷'],
  ['par', '巴黎', '法国', '🇫🇷'],
  ['fra', '法兰克福', '德国', '🇩🇪'],
  ['lim', '林堡', '德国', '🇩🇪'],
  ['lon', '伦敦', '英国', '🇬🇧'],
  ['eri', '伦敦', '英国', '🇬🇧'],
  ['waw', '华沙', '波兰', '🇵🇱'],
  ['mil', '米兰', '意大利', '🇮🇹'],
  ['bhs', '博阿努瓦', '加拿大', '🇨🇦'],
  ['tor', '多伦多', '加拿大', '🇨🇦'],
  ['vin', '弗吉尼亚', '美国东部', '🇺🇸'],
  ['hil', '俄勒冈', '美国西部', '🇺🇸'],
  ['sgp', '新加坡', '新加坡', '🇸🇬'],
  ['syd', '悉尼', '澳大利亚', '🇦🇺'],
  ['ynm', '孟买', '印度', '🇮🇳'],
  ['mum', '孟买', '印度', '🇮🇳'],
]
const dcIndex = new Map(datacenters.map((d, i) => [d[0], i]))

/** Resolves an OVH location code ("rbx", "eu-west-par-a", …) to display info; unknown codes fall back to the code itself. */
export function locationInfo(code: string): LocationInfo {
  // Multi-AZ regions look like "eu-west-par-a": city code + availability zone letter.
  const m = /^[a-z]{2}-[a-z]+-([a-z]{3})-([a-z])$/.exec(code)
  const key = m ? m[1] : code
  const i = dcIndex.get(key)
  if (i === undefined) return { code, city: code.toUpperCase(), country: '', flag: '', order: 1000 }
  const [, city, country, flag] = datacenters[i]
  return { code, city: m ? `${city} ${m[2].toUpperCase()} 区` : city, country, flag, order: i * 10 + (m ? m[2].charCodeAt(0) - 96 : 0) }
}

/** Full name used in tooltips and notifications, e.g. "鲁贝 · 法国 (RBX)". */
export function locationName(code: string) {
  const l = locationInfo(code)
  return l.country ? `${l.city} · ${l.country} (${code.toUpperCase()})` : code.toUpperCase()
}

/** Compact label for chips and lists, e.g. "🇫🇷 鲁贝". */
export function locationShort(code: string) {
  const l = locationInfo(code)
  return l.flag ? `${l.flag} ${l.city}` : l.city
}

export const sortLocations = (codes: string[]) => [...codes].sort((a, b) => locationInfo(a).order - locationInfo(b).order || a.localeCompare(b))

// --- OVH hardware option codes → readable specs ---

const diskKind: Record<string, string> = { nvme: 'NVMe', ssd: 'SSD', sa: 'HDD', sas: 'SAS', hdd: 'HDD' }
const raidKind: Record<string, string> = { softraid: '软 RAID', hybridsoftraid: '混合软 RAID', hardraid: '硬 RAID', noraid: '' }

function formatSize(gb: number) {
  if (gb < 1000) return `${gb}GB`
  const tb = gb / 1000
  return `${Number.isInteger(tb) ? tb : tb.toFixed(2).replace(/0+$/, '')}TB`
}

/** "ram-64g-ddr5-on-die-ecc-3600-25rises01-v2" → "64GB DDR5 ECC 3600MHz". */
export function parseMemory(code: string | undefined): string {
  if (!code) return ''
  const m = /^ram-(\d+)g(.*)$/.exec(code)
  if (!m) return code
  const rest = m[2]
  const parts = [`${m[1]}GB`]
  const ddr = /-ddr(\d)/.exec(rest)
  if (ddr) parts.push(`DDR${ddr[1]}`)
  if (/-noecc/.test(rest)) parts.push('非 ECC')
  else if (/-ecc/.test(rest)) parts.push('ECC')
  const speed = /-(?:no)?ecc-(\d{4})/.exec(rest)
  if (speed) parts.push(`${speed[1]}MHz`)
  return parts.join(' ')
}

/** "hybridsoftraid-2x960nvme-pcie-gen4-2x3840nvme-pcie-gen4" → "2×960GB NVMe + 2×3.84TB NVMe · 混合软 RAID". */
export function parseStorage(code: string | undefined): string {
  if (!code) return ''
  const raid = /^([a-z]+raid)-/.exec(code)
  const groups = [...code.matchAll(/(\d+)x(\d+)(nvme|ssd|sas|sa|hdd)(?![a-z])/g)]
  if (groups.length === 0) return /0disk|noraid-0(?:-|$)/.test(code) ? '无硬盘 (需另购)' : code
  const text = groups.map(([, n, size, kind]) => `${n}×${formatSize(+size)} ${diskKind[kind]}`).join(' + ')
  const diskCount = groups.reduce((sum, g) => sum + +g[1], 0)
  const r = raid ? raidKind[raid[1]] : ''
  return r && diskCount > 1 ? `${text} · ${r}` : text
}

/** "bandwidth-1000-upto-2000-24sys3p" → "1Gbps (最高 2Gbps)"; "traffic-10tb-300-apac" → "300Mbps · 10TB 流量". */
export function parseBandwidth(code: string | undefined): string {
  if (!code) return ''
  const speed = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000}Gbps` : `${mbps}Mbps`)
  let m = /^bandwidth-(\d+)(?:-upto-(\d+))?/.exec(code)
  if (m) return speed(+m[1]) + (m[2] ? ` (最高 ${speed(+m[2])})` : '') + (code.includes('unguaranteed') ? ' 共享' : '')
  m = /^traffic-(\d+)tb-(\d+)/.exec(code)
  if (m) return `${speed(+m[2])} · ${m[1]}TB 流量`
  return code
}

/** Splits an OVH fqn ("plan.ram-….softraid-…") into readable memory/storage; non-OVH configs come back as-is. */
export function configSpecs(config: string, productCode: string): { memory: string; storage: string; raw: string } {
  const raw = configLabel(config, productCode)
  const parts = config.startsWith(productCode + '.') ? config.slice(productCode.length + 1).split('.') : config.split('.')
  const mem = parts.find((p) => p.startsWith('ram-'))
  const sto = parts.find((p) => /raid|disk/.test(p))
  return { memory: parseMemory(mem), storage: parseStorage(sto), raw }
}

/** One-line readable config, e.g. "内存 64GB DDR5 ECC · 硬盘 2×960GB NVMe". */
export function configText(config: string, productCode: string) {
  const s = configSpecs(config, productCode)
  if (!s.memory && !s.storage) return s.raw
  return [s.memory && `内存 ${s.memory}`, s.storage && `硬盘 ${s.storage}`].filter(Boolean).join(' · ')
}

// --- remembered target ---

const TARGET_KEY = 'sw-target'

export function loadTarget(): Target | null {
  try {
    const v = localStorage.getItem(TARGET_KEY)
    return v && v.includes(':') ? parseTarget(v) : null
  } catch {
    return null
  }
}

export function saveTarget(t: Target) {
  try {
    localStorage.setItem(TARGET_KEY, targetKey(t))
  } catch {
    // storage unavailable (private mode); selection just won't persist
  }
}

export function deliveryLabel(raw: string): string {
  if (raw === '1H-high') return '1 小时'
  if (raw === '1H-low') return '1 小时 · 紧张'
  if (/^\d+H$/.test(raw)) return raw.replace('H', ' 小时')
  if (raw === 'comingSoon') return '即将上架'
  return statusLabelRaw(raw)
}

function statusLabelRaw(raw: string) {
  if (raw === 'unavailable') return '无货'
  if (raw === 'unknown' || raw === '') return '未知'
  return raw
}

export function configLabel(config: string, productCode: string) {
  return config.startsWith(productCode + '.') ? config.slice(productCode.length + 1).split('.').join(' / ') : config
}

export function formatPrice(price: number, currency: string) {
  if (!price) return '—'
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(price)
  } catch {
    return `${price.toFixed(2)} ${currency}`
  }
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!t || t < 86400000) return '—'
  const diff = (t - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return diff < 0 ? '刚刚' : '即将'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  return rtf.format(Math.round(diff / 86400), 'day')
}

export function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export const targetKey = (t: Target) => `${t.provider}:${t.region}`
export const parseTarget = (s: string): Target => {
  const [provider, region] = s.split(':')
  return { provider, region }
}
