import type { StockStatus, Target } from './api'

export const statusLabel: Record<StockStatus, string> = {
  available: '有货',
  low: '少量',
  unavailable: '无货',
  unknown: '未知',
}

export const isInStock = (s: StockStatus) => s === 'available' || s === 'low'

export const locationNames: Record<string, string> = {
  bhs: '博阿尔努瓦 (加拿大)',
  gra: '格拉沃利讷 (法国)',
  rbx: '鲁贝 (法国)',
  sbg: '斯特拉斯堡 (法国)',
  fra: '法兰克福 (德国)',
  lon: '伦敦 (英国)',
  waw: '华沙 (波兰)',
  sgp: '新加坡',
  syd: '悉尼 (澳大利亚)',
  ynm: '孟买 (印度)',
  hil: '希尔斯伯勒 (美国西部)',
  vin: '维也纳 (美国东部)',
  'eu-west-par-a': '巴黎 A 区',
  'eu-west-par-b': '巴黎 B 区',
  'eu-west-par-c': '巴黎 C 区',
  'ca-east-tor-a': '多伦多 A 区',
}

export const locationName = (l: string) => locationNames[l] ?? l

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
