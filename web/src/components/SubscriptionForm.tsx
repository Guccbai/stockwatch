import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api, type Subscription, type SubscriptionInput } from '../api'
import { useProviders } from '../hooks'
import { configText, formatPrice, loadTarget, locationInfo, locationName, parseMemory, parseStorage, sortLocations } from '../lib'
import { Button, Drawer, Field, Input, Select, StatusDot, Toggle, useToast } from './ui'

// Defaults to the region last viewed on the stock page.
export const emptySubscription = (provider = loadTarget()?.provider ?? 'ovh', region = loadTarget()?.region ?? 'eu'): SubscriptionInput => ({
  provider,
  region,
  productCode: '',
  locations: [],
  configs: [],
  configFilter: '',
  notifyOn: 'restock',
  enabled: true,
  note: '',
})

export function SubscriptionForm({
  open,
  onClose,
  initial,
  editing,
}: {
  open: boolean
  onClose: () => void
  initial: SubscriptionInput
  editing?: Subscription
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const providers = useProviders()
  const [form, setForm] = useState<SubscriptionInput>(initial)
  useEffect(() => {
    if (open) setForm(initial)
  }, [open, initial])

  const target = { provider: form.provider, region: form.region }
  const stock = useQuery({ queryKey: ['stock', target], queryFn: () => api.stock(target), enabled: open })
  const detail = useQuery({
    queryKey: ['stock-detail', target, form.productCode],
    queryFn: () => api.stockDetail(target, form.productCode),
    enabled: open && !!form.productCode,
  })

  const product = stock.data?.products.find((p) => p.code === form.productCode)
  const locations = useMemo(() => {
    const set = new Set<string>(detail.data?.locations ?? [])
    form.locations.forEach((l) => set.add(l))
    return sortLocations([...set])
  }, [detail.data, form.locations])

  // Subscribed configs that dropped out of the current stock data stay listed so they can be unticked.
  const configs = useMemo(() => {
    const rows = (detail.data?.configs ?? []).map((c) => ({
      config: c.config,
      price: c.price,
      inStock: Object.values(c.locations).some((s) => s.status === 'available' || s.status === 'low'),
    }))
    for (const c of form.configs) if (!rows.some((r) => r.config === c)) rows.push({ config: c, price: null, inStock: false })
    // Initially selected first (fixed while ticking, so rows don't jump), then in stock, then cheapest.
    const picked = (c: (typeof rows)[number]) => Number(initial.configs.includes(c.config))
    const price = (c: (typeof rows)[number]) => c.price?.price ?? Infinity
    return rows.sort((a, b) => picked(b) - picked(a) || Number(b.inStock) - Number(a.inStock) || price(a) - price(b))
  }, [detail.data, form.configs, initial.configs])

  const matched = useMemo(() => {
    if (!detail.data) return null
    let total = 0
    let inStock = 0
    for (const c of detail.data.configs) {
      if (form.configs.length && !form.configs.includes(c.config)) continue
      if (form.configFilter && !c.config.includes(form.configFilter)) continue
      for (const [loc, s] of Object.entries(c.locations)) {
        if (form.locations.length && !form.locations.includes(loc)) continue
        total++
        if (s.status === 'available' || s.status === 'low') inStock++
      }
    }
    return { total, inStock }
  }, [detail.data, form.configs, form.configFilter, form.locations])

  const save = useMutation({
    mutationFn: () => (editing ? api.updateSubscription(editing.id, form) : api.createSubscription(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
      toast('success', editing ? '订阅已更新' : '订阅已创建')
      onClose()
    },
    onError: (e) => toast('error', (e as Error).message),
  })

  const set = <K extends keyof SubscriptionInput>(k: K, v: SubscriptionInput[K]) => setForm((f) => ({ ...f, [k]: v }))
  const currentProvider = providers.data?.find((p) => p.id === form.provider)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? `编辑订阅 #${editing.id}` : '新建订阅'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!form.productCode}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="服务商">
            <Select
              value={form.provider}
              onChange={(e) => {
                const p = providers.data?.find((x) => x.id === e.target.value)
                setForm((f) => ({ ...f, provider: e.target.value, region: p?.regions[0]?.id ?? '', productCode: '', locations: [], configs: [], configFilter: '' }))
              }}
            >
              {providers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="区域">
            <Select value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value, productCode: '', locations: [], configs: [], configFilter: '' }))}>
              {currentProvider?.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="机型" hint={stock.isLoading ? '加载库存中…' : stock.data && !stock.data.poll ? '该区域尚未开始监控，保存订阅后会自动加入监控。' : undefined}>
          <Input
            list="sw-products"
            placeholder="输入机型代码或名称，例如 24sk602 / KS-6"
            value={form.productCode}
            onChange={(e) => {
              const v = e.target.value.trim()
              const hit = stock.data?.products.find((p) => p.code === v || p.name.toLowerCase() === v.toLowerCase())
              setForm((f) => ({ ...f, productCode: hit?.code ?? v, locations: [], configs: [], configFilter: '' }))
            }}
          />
          <datalist id="sw-products">
            {stock.data?.products.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} · {p.specs?.cpu ?? ''} {p.price ? '· ' + formatPrice(p.price, p.currency) : ''}
              </option>
            ))}
          </datalist>
        </Field>
        {product && (
          <div className="rounded-lg bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{product.name}</span>
            {product.specs?.cpu && <> · CPU {product.specs.cpu}</>}
            {product.specs?.memory && <> · 内存 {parseMemory(product.specs.memory)}</>}
            {product.specs?.storage && <> · 硬盘 {parseStorage(product.specs.storage)}</>}
            {product.price > 0 && <> · {formatPrice(product.price, product.currency)}/月起</>}
            {product.setupFee > 0 && <> · 安装费 {formatPrice(product.setupFee, product.currency)}</>}
          </div>
        )}

        <Field label="机房" hint="不选则监控全部机房">
          <div className="flex flex-wrap gap-1.5">
            {locations.length === 0 && <span className="text-xs text-zinc-400">{form.productCode ? '加载中或无数据' : '请先选择机型'}</span>}
            {locations.map((l) => {
              const on = form.locations.includes(l)
              const info = locationInfo(l)
              return (
                <button
                  key={l}
                  type="button"
                  title={locationName(l)}
                  onClick={() => set('locations', on ? form.locations.filter((x) => x !== l) : [...form.locations, l])}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors ring-inset',
                    on
                      ? 'bg-emerald-600 text-white ring-emerald-600'
                      : 'bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800',
                  )}
                >
                  {info.flag && <span className="mr-1" aria-hidden>{info.flag}</span>}
                  {info.city}
                  <span className={clsx('ml-1 font-mono text-[10px]', on ? 'text-emerald-100' : 'text-zinc-400')}>{l.toUpperCase()}</span>
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="配置" hint={form.configs.length ? `已选 ${form.configs.length} 个配置` : '不选则监控该机型的全部配置'}>
          <div className="max-h-60 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-700">
            {configs.length === 0 && <p className="px-3 py-2 text-xs text-zinc-400">{form.productCode ? '加载中或无数据' : '请先选择机型'}</p>}
            {configs.map((c) => {
              const on = form.configs.includes(c.config)
              return (
                <label key={c.config} title={c.config} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set('configs', on ? form.configs.filter((x) => x !== c.config) : [...form.configs, c.config])}
                    className="accent-emerald-600"
                  />
                  <StatusDot status={c.inStock ? 'available' : 'unavailable'} />
                  <span className="min-w-0 flex-1">{configText(c.config, form.productCode)}</span>
                  {c.price && <span className="text-zinc-500 tabular-nums">{formatPrice(c.price.price, detail.data?.product?.currency ?? '')}</span>}
                </label>
              )
            })}
          </div>
        </Field>

        <Field label="配置 ID 过滤" hint="高级：对配置 ID 做子串匹配，例如 ram-64g 或 nvme；留空表示不过滤">
          <Input list="sw-configs" value={form.configFilter} onChange={(e) => set('configFilter', e.target.value)} placeholder="可选" />
          <datalist id="sw-configs">
            {detail.data?.configs.map((c) => (
              <option key={c.config} value={c.config}>
                {configText(c.config, form.productCode)}
              </option>
            ))}
          </datalist>
        </Field>

        {matched && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            当前匹配 <span className="font-medium text-zinc-800 dark:text-zinc-200">{matched.total}</span> 个配置 × 机房，其中{' '}
            <span className="font-medium text-emerald-600 dark:text-emerald-400">{matched.inStock}</span> 个有货。
          </p>
        )}

        <Field label="通知条件">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['restock', '仅补货', '无货 → 有货时通知'],
                ['all', '补货 + 售罄', '状态双向变化都通知'],
              ] as const
            ).map(([v, title, desc]) => (
              <button
                key={v}
                type="button"
                onClick={() => set('notifyOn', v)}
                className={clsx(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  form.notifyOn === v ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800',
                )}
              >
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{desc}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="备注">
          <Input value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="会附在通知消息中" />
        </Field>

        <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="启用此订阅" />
      </div>
    </Drawer>
  )
}
