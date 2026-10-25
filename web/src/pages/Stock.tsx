import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { BellPlus, ChevronDown, ChevronRight, ExternalLink, Search, ServerCrash } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type ProductSummary, type SubscriptionInput, type Target } from '../api'
import { RegionPicker } from '../components/RegionPicker'
import { emptySubscription, SubscriptionForm } from '../components/SubscriptionForm'
import { Badge, Card, Empty, Input, PageHeader, Select, Spinner, StatusDot, Toggle } from '../components/ui'
import { useSettings, useTick } from '../hooks'
import {
  configSpecs,
  deliveryLabel,
  formatPrice,
  isInStock,
  loadTarget,
  locationName,
  locationShort,
  parseBandwidth,
  parseMemory,
  parseStorage,
  parseTarget,
  saveTarget,
  sortLocations,
  statusLabel,
  targetKey,
  timeAgo,
} from '../lib'

const chipColor = {
  available: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
  low: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20',
} as const

/** In-stock datacenter pill: "🇫🇷 鲁贝 ×3 1小时". Amber means low stock; the full wording is in the tooltip. */
function LocationChip({ code, status, raw, count, title }: { code: string; status: 'available' | 'low'; raw: string; count?: number; title?: string }) {
  return (
    <span
      title={title ?? locationName(code)}
      className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', chipColor[status])}
    >
      {locationShort(code)}
      {count !== undefined && <span className="tabular-nums opacity-70">×{count}</span>}
      <span className="font-normal opacity-70">{/^\d+H/.test(raw) ? `${parseInt(raw)}小时` : deliveryLabel(raw)}</span>
    </span>
  )
}

/** Summary of one product across datacenters: chips for in-stock locations, a muted count for the rest. */
function StockSummary({ p, focus }: { p: ProductSummary; focus: string }) {
  const codes = sortLocations(Object.keys(p.locations))
  const inStock = codes.filter((l) => isInStock(p.locations[l].status))
  const out = codes.length - inStock.length
  if (codes.length === 0) return <span className="text-xs text-zinc-400">暂无数据</span>
  return (
    <div className="flex flex-wrap items-center gap-1">
      {inStock.map((l) => {
        const s = p.locations[l]
        return (
          <span key={l} className={clsx(focus && focus !== l && 'opacity-40')}>
            <LocationChip
              code={l}
              status={s.status as 'available' | 'low'}
              raw={s.raw}
              count={s.inStock}
              title={`${locationName(l)} · ${s.inStock}/${s.total} 个配置有货 · 最快 ${deliveryLabel(s.raw)}`}
            />
          </span>
        )
      })}
      {out > 0 && (
        <span
          className="text-[11px] whitespace-nowrap text-zinc-400 dark:text-zinc-500"
          title={codes
            .filter((l) => !isInStock(p.locations[l].status))
            .map(locationName)
            .join('\n')}
        >
          {inStock.length ? `+${out} 个机房无货` : `${out} 个机房均无货`}
        </span>
      )}
    </div>
  )
}

/** Labeled hardware summary: CPU / 内存 / 硬盘 / 带宽. */
function SpecList({ specs }: { specs: ProductSummary['specs'] }) {
  if (!specs) return <span className="text-zinc-400">—</span>
  const cpu = [specs.cpu, specs.cores?.replace(/(\d+)c\/(\d+)t/, '$1核$2线程'), specs.frequency].filter(Boolean).join(' · ')
  const lines: [string, string][][] = [
    [['CPU', cpu]],
    [
      ['内存', parseMemory(specs.memory)],
      ['硬盘', parseStorage(specs.storage)],
      ['带宽', parseBandwidth(specs.bandwidth)],
    ],
  ]
  return (
    <div className="space-y-0.5 text-xs text-zinc-700 dark:text-zinc-300">
      {lines.map((line, i) => (
        <div key={i} className="flex flex-wrap gap-x-3">
          {line
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <span key={k}>
                <span className="mr-1 text-zinc-400 dark:text-zinc-500">{k}</span>
                {v}
              </span>
            ))}
        </div>
      ))}
    </div>
  )
}

function Detail({ target, code, focus }: { target: Target; code: string; focus: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['stock-detail', target, code],
    queryFn: () => api.stockDetail(target, code),
  })
  const configs = useMemo(() => {
    const rows = (data?.configs ?? []).map((c) => {
      const locs = sortLocations(Object.keys(c.locations))
      const inStock = locs.filter((l) => isInStock(c.locations[l].status))
      return { ...c, spec: configSpecs(c.config, code), locs, inStock }
    })
    // In-stock configurations first, then cheapest first; unpriced ones last within each group.
    const price = (c: (typeof rows)[number]) => c.price?.price ?? Infinity
    return rows.sort((a, b) => Number(b.inStock.length > 0) - Number(a.inStock.length > 0) || price(a) - price(b))
  }, [data, code])
  if (isLoading || !data) return <Spinner className="mx-auto my-6" />
  if (configs.length === 0) return <p className="py-4 text-center text-xs text-zinc-500">暂无配置数据</p>
  const available = configs.filter((c) => c.inStock.length).length
  const base = data.product?.price ?? 0
  const currency = data.product?.currency ?? ''
  const setupFee = data.product?.setupFee ?? 0
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        共 {configs.length} 种可选配置，{available} 种有货
        {setupFee > 0 && <> · 安装费 {formatPrice(setupFee, currency)}（按月付费时一次性收取，预付 12/24 个月免收）</>}
      </p>
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {configs.map((c) => (
          <li
            key={c.config}
            title={c.spec.raw}
            className={clsx(
              'grid gap-x-4 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[minmax(8rem,10.5rem)_minmax(10rem,17rem)_minmax(0,1fr)_5.5rem]',
              !c.inStock.length && 'text-zinc-400 dark:text-zinc-500',
            )}
          >
            <span>
              <span className="mr-1 text-zinc-400 dark:text-zinc-500">内存</span>
              {c.spec.memory || c.spec.raw}
            </span>
            <span>
              <span className="mr-1 text-zinc-400 dark:text-zinc-500">硬盘</span>
              {c.spec.storage || '—'}
              {c.spec.system && (
                <span className="block">
                  <span className="mr-1 text-zinc-400 dark:text-zinc-500">系统盘</span>
                  {c.spec.system}
                </span>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {c.inStock.map((l) => {
                const st = c.locations[l]
                return (
                  <span key={l} className={clsx(focus && focus !== l && 'opacity-40')}>
                    <LocationChip
                      code={l}
                      status={st.status as 'available' | 'low'}
                      raw={st.raw}
                      title={`${locationName(l)} · ${deliveryLabel(st.raw)} · 更新于 ${timeAgo(st.changedAt)}`}
                    />
                  </span>
                )
              })}
              {!c.inStock.length && <span title={c.locs.map(locationName).join('\n')}>{c.locs.length} 个机房均无货</span>}
            </span>
            <span
              className="tabular-nums sm:text-right"
              title={c.price ? `月付 ${formatPrice(c.price.price, currency)}，安装费 ${formatPrice(c.price.setupFee, currency)}` : '目录中找不到这个配置的价格'}
            >
              {c.price ? (
                <>
                  <span className={clsx('font-medium', c.inStock.length ? 'text-zinc-900 dark:text-zinc-100' : '')}>
                    {formatPrice(c.price.price, currency)}
                  </span>
                  <span className="text-zinc-400">/月</span>
                  {base > 0 && c.price.price - base > 0.005 && (
                    <span className="block text-[11px] text-zinc-400">+{formatPrice(c.price.price - base, currency)}</span>
                  )}
                </>
              ) : (
                <span className="text-zinc-400">—</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Price column: default-config monthly price, cheapest in-stock config, one-time setup fee. */
function PriceCell({ p }: { p: ProductSummary }) {
  if (!p.price) return <span className="text-zinc-400">—</span>
  return (
    <div className="text-right text-[11px] leading-5 whitespace-nowrap tabular-nums">
      <div title="默认配置月价（不含税）">
        <span className="text-sm text-zinc-900 dark:text-zinc-100">{formatPrice(p.price, p.currency)}</span>
        <span className="ml-0.5 text-zinc-400">起</span>
      </div>
      {!!p.inStockPrice && p.inStockPrice !== p.price && (
        <div className="text-emerald-600 dark:text-emerald-400" title="当前有货配置中的最低月价">
          有货 {formatPrice(p.inStockPrice, p.currency)}
        </div>
      )}
      {p.setupFee > 0 && (
        <div className="text-zinc-400" title="按月付费时一次性收取；预付 12 或 24 个月免安装费（以官网为准）">
          安装费 {formatPrice(p.setupFee, p.currency)}
        </div>
      )}
    </div>
  )
}

function RowActions({ p, onSubscribe }: { p: ProductSummary; onSubscribe: () => void }) {
  return (
    <div className="flex justify-end gap-0.5 opacity-70 group-hover:opacity-100">
      {p.orderUrl && (
        <a
          href={p.orderUrl}
          target="_blank"
          rel="noreferrer"
          title="前往官网"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
      <button
        type="button"
        title="订阅补货通知"
        onClick={onSubscribe}
        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-700"
      >
        <BellPlus className="size-4" />
      </button>
    </div>
  )
}

function ProductTitle({ p, open }: { p: ProductSummary; open: boolean }) {
  return (
    <div className="flex items-start gap-2">
      {open ? <ChevronDown className="mt-1 size-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="mt-1 size-3.5 shrink-0 text-zinc-400" />}
      <div>
        <div className="flex items-center gap-1.5 font-medium whitespace-nowrap">
          {p.name}
          {p.inStock > 0 && <StatusDot status="available" pulse />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          {p.code}
          {p.family && <Badge className="font-sans">{p.family}</Badge>}
        </div>
      </div>
    </div>
  )
}

export function Stock() {
  useTick()
  const [params, setParams] = useSearchParams()
  const settings = useSettings()
  const target = parseTarget(params.get('t') ?? targetKey(loadTarget() ?? settings.data?.targets[0] ?? { provider: 'ovh', region: 'eu' }))
  // Remember the last viewed region (also when arriving via a shared ?t= link).
  useEffect(() => {
    if (params.get('t')) saveTarget(target)
  }, [params, target.provider, target.region]) // eslint-disable-line react-hooks/exhaustive-deps
  const monitoredSet = useMemo(() => new Set(settings.data?.targets.map(targetKey)), [settings.data])
  const [q, setQ] = useState('')
  const [family, setFamily] = useState('')
  const [location, setLocation] = useState('')
  const [onlyInStock, setOnlyInStock] = useState(false)
  const [onlyCatalog, setOnlyCatalog] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [subInit, setSubInit] = useState<SubscriptionInput | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['stock', target],
    queryFn: () => api.stock(target),
  })

  const families = useMemo(() => [...new Set((data?.products ?? []).map((p) => p.family).filter(Boolean))].sort(), [data])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.products ?? []).filter((p) => {
      if (onlyCatalog && !p.inCatalog) return false
      if (onlyInStock && p.inStock === 0) return false
      if (family && p.family !== family) return false
      if (location) {
        const s = p.locations[location]
        if (!s || (onlyInStock && !isInStock(s.status))) return false
      }
      if (
        needle &&
        ![p.code, p.name, p.specs?.cpu ?? '', parseMemory(p.specs?.memory), parseStorage(p.specs?.storage)].some((s) => s.toLowerCase().includes(needle))
      )
        return false
      return true
    })
  }, [data, q, family, location, onlyInStock, onlyCatalog])

  const locations = useMemo(() => sortLocations(data?.locations ?? []), [data])
  const subscribe = (code: string) =>
    setSubInit({
      ...emptySubscription(target.provider, target.region),
      productCode: code,
    })

  const monitored = settings.data?.targets.some((t) => targetKey(t) === targetKey(target)) || !!data?.poll

  return (
    <>
      <PageHeader
        title="库存浏览"
        description={data?.poll ? `${data.products.length} 个机型 · 更新于 ${timeAgo(data.poll.lastSuccess)}` : '按机型和机房查看实时库存'}
        actions={
          <RegionPicker
            value={target}
            monitored={monitoredSet}
            onChange={(t) => {
              setExpanded(null)
              setFamily('')
              setLocation('')
              setParams({ t: targetKey(t) })
            }}
          />
        }
      />

      {!monitored && !isLoading && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          该区域尚未加入监控。在{' '}
          <Link to="/settings" className="font-medium text-emerald-600 underline dark:text-emerald-400">
            设置
          </Link>{' '}
          中勾选它，或直接为其中的机型创建订阅。
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索机型、代码、CPU、内存、硬盘" className="pl-9" />
          </div>
          <div className="w-40">
            <Select value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">全部系列</option>
              {families.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </div>
          <div className="w-44">
            <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="机房">
              <option value="">全部机房</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {locationShort(l)} ({l.toUpperCase()})
                </option>
              ))}
            </Select>
          </div>
          <Toggle checked={onlyInStock} onChange={setOnlyInStock} label="仅有货" />
          <Toggle checked={onlyCatalog} onChange={setOnlyCatalog} label="仅公开目录" />
          <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{rows.length} 个结果</span>
        </div>

        {isLoading ? (
          <Spinner className="mx-auto my-16" />
        ) : error ? (
          <Empty icon={<ServerCrash className="size-8" />} title="加载失败">
            {(error as Error).message}
          </Empty>
        ) : rows.length === 0 ? (
          <Empty title={data?.products.length ? '没有符合条件的机型' : '暂无数据'}>
            {data?.products.length ? '尝试调整筛选条件。' : '监控开始后首次轮询完成即可看到库存。'}
          </Empty>
        ) : (
          <>
            {/* Phones: one card per product. */}
            <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {rows.map((p) => {
                const open = expanded === p.code
                return (
                  <li key={p.code} className={clsx('group space-y-2 px-4 py-3', open && 'bg-zinc-50 dark:bg-zinc-800/40')}>
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" className="min-w-0 text-left" onClick={() => setExpanded(open ? null : p.code)}>
                        <ProductTitle p={p} open={open} />
                      </button>
                      <div className="flex items-center gap-1">
                        <PriceCell p={p} />
                        <RowActions p={p} onSubscribe={() => subscribe(p.code)} />
                      </div>
                    </div>
                    <SpecList specs={p.specs} />
                    <StockSummary p={p} focus={location} />
                    {open && <Detail target={target} code={p.code} focus={location} />}
                  </li>
                )
              })}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50/80 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">机型</th>
                    <th className="px-3 py-2.5 text-left font-medium">配置</th>
                    <th className="px-3 py-2.5 text-left font-medium">库存</th>
                    <th className="px-3 py-2.5 text-right font-medium">月付</th>
                    <th className="w-0 px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map((p) => {
                    const open = expanded === p.code
                    return (
                      <Fragment key={p.code}>
                        <tr
                          className={clsx(
                            'group cursor-pointer align-top transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                            open && 'bg-zinc-50 dark:bg-zinc-800/40',
                          )}
                          onClick={() => setExpanded(open ? null : p.code)}
                        >
                          <td className="px-4 py-2.5">
                            <ProductTitle p={p} open={open} />
                          </td>
                          <td className="min-w-44 px-2.5 py-2.5">
                            <SpecList specs={p.specs} />
                          </td>
                          <td className="min-w-40 px-2.5 py-2.5">
                            <StockSummary p={p} focus={location} />
                          </td>
                          <td className="px-3 py-2.5">
                            <PriceCell p={p} />
                          </td>
                          <td className="px-2 py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            <RowActions p={p} onSubscribe={() => subscribe(p.code)} />
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={5} className="bg-zinc-50/60 px-4 py-3 dark:bg-zinc-950/40">
                              <Detail target={target} code={p.code} focus={location} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        {(['available', 'low'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <StatusDot status={s} /> {statusLabel[s]}
          </span>
        ))}
        <span>×N = 该机房有货的配置数，后面是最快交付时间 · 价格不含税，「起」为默认配置月价，点击机型可查看每种配置的价格</span>
      </div>

      <SubscriptionForm open={!!subInit} onClose={() => setSubInit(null)} initial={subInit ?? emptySubscription()} />
    </>
  )
}
