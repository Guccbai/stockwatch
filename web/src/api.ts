export type StockStatus = 'available' | 'low' | 'unavailable' | 'unknown'

export interface Target {
  provider: string
  region: string
}

export interface Region {
  id: string
  name: string
  currency: string
}

export interface ProviderInfo {
  id: string
  name: string
  regions: Region[]
}

export interface PollStatus {
  target: Target
  lastPoll: string
  lastSuccess: string
  lastError: string
  durationMs: number
  slots: number
  inStock: number
  failures: number
  nextPoll: string
  catalogUpdated: string
  catalogError: string
}

export interface Product {
  provider: string
  region: string
  code: string
  name: string
  family: string
  specs: Record<string, string> | null
  price: number
  setupFee: number
  currency: string
  locations: string[] | null
  orderUrl: string
}

export interface LocationSummary {
  status: StockStatus
  raw: string
  inStock: number
  total: number
}

export interface ProductSummary {
  code: string
  name: string
  family: string
  price: number // default configuration
  setupFee: number // one-time, without commitment
  inStockPrice?: number // cheapest in-stock configuration
  currency: string
  specs: Record<string, string> | null
  orderUrl: string
  inCatalog: boolean
  inStock: number
  total: number
  lastChange: string
  locations: Record<string, LocationSummary>
}

export interface StockResponse {
  target: Target
  poll: PollStatus | null
  locations: string[]
  products: ProductSummary[]
}

export interface SlotState {
  status: StockStatus
  raw: string
  changedAt: string
}

export interface ConfigPrice {
  price: number
  setupFee: number
}

export interface ConfigDetail {
  config: string
  extra: Record<string, string> | null
  price: ConfigPrice | null // null when the configuration couldn't be priced
  locations: Record<string, SlotState>
}

export interface StockDetail {
  target: Target
  product: Product | null
  code: string
  locations: string[]
  configs: ConfigDetail[]
}

export interface Subscription {
  id: number
  provider: string
  region: string
  productCode: string
  locations: string[]
  configs: string[] // exact configuration ids; empty = any
  configFilter: string
  notifyOn: 'restock' | 'all'
  enabled: boolean
  note: string
  createdAt: string
}

export type SubscriptionInput = Omit<Subscription, 'id' | 'createdAt'>

export interface StockEvent {
  id: number
  key: string
  provider: string
  region: string
  productCode: string
  config: string
  location: string
  from: StockStatus
  to: StockStatus
  rawState: string
  at: string
}

export interface NotificationRecord {
  id: number
  eventId: number
  subscriptionId: number
  channel: string
  ok: boolean
  error: string
  at: string
}

export interface WatchedSubscription extends Subscription {
  name: string
  inStock: number
  locations: string[]
}

export interface Overview {
  polls: PollStatus[]
  subscriptions: number
  enabledSubscriptions: number
  watched: WatchedSubscription[]
  recentRestocks: StockEvent[]
  restocks24h: number
  paused: boolean
  telegramConfigured: boolean
  notifyConfigured: boolean
  interval: number
}

export interface Settings {
  telegramTokenSet: boolean
  telegramTokenHint: string
  telegramChatId: string
  telegramCommands: boolean
  resendKeySet: boolean
  resendKeyHint: string
  resendFrom: string
  resendTo: string
  interval: number
  cooldown: number
  targets: Target[]
  paused: boolean
  retentionDays: number
  envOverrides: { telegramToken: boolean; telegramChatId: boolean; resendApiKey: boolean; resendFrom: boolean; resendTo: boolean }
}

export type SettingsUpdate = Partial<Omit<Settings, 'telegramTokenSet' | 'telegramTokenHint' | 'resendKeySet' | 'resendKeyHint' | 'envOverrides'>> & {
  telegramToken?: string
  resendApiKey?: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized()
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = (await res.json()).error ?? msg
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v === true ? 1 : v))
  const s = p.toString()
  return s ? '?' + s : ''
}

export const api = {
  me: () => request<{ authenticated: boolean; version: string }>('GET', '/auth/me'),
  login: (password: string) => request<{ ok: boolean }>('POST', '/auth/login', { password }),
  logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
  changePassword: (current: string, next: string) => request('PUT', '/auth/password', { current, new: next }),

  providers: () => request<ProviderInfo[]>('GET', '/providers'),
  overview: () => request<Overview>('GET', '/overview'),
  stock: (t: Target) => request<StockResponse>('GET', '/stock' + qs({ ...t })),
  stockDetail: (t: Target, product: string) => request<StockDetail>('GET', '/stock/detail' + qs({ ...t, product })),
  /** Link that redirects to the provider's pre-filled order page: the given config at location, else the
   * cheapest one in stock there (or anywhere without location); the storefront when nothing can be pre-filled. */
  orderUrl: (t: Target, product: string, location?: string, config?: string) => '/api/order' + qs({ ...t, product, location, config }),

  subscriptions: () => request<Subscription[]>('GET', '/subscriptions'),
  createSubscription: (s: SubscriptionInput) => request<Subscription>('POST', '/subscriptions', s),
  updateSubscription: (id: number, s: SubscriptionInput) => request<Subscription>('PUT', `/subscriptions/${id}`, s),
  deleteSubscription: (id: number) => request<void>('DELETE', `/subscriptions/${id}`),

  events: (f: { provider?: string; region?: string; product?: string; restock?: boolean; limit?: number; before?: number; key?: string }) =>
    request<StockEvent[]>('GET', '/events' + qs(f)),
  notifications: (limit = 50) => request<NotificationRecord[]>('GET', '/notifications' + qs({ limit })),

  settings: () => request<Settings>('GET', '/settings'),
  updateSettings: (s: SettingsUpdate) => request<Settings>('PUT', '/settings', s),
  testNotify: (channel: 'telegram' | 'resend') => request<{ ok: boolean }>('POST', `/notify/test?channel=${channel}`),
  pollNow: () => request<{ ok: boolean }>('POST', '/poll'),
}
