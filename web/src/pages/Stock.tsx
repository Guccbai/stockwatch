import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { BellPlus, ChevronDown, ChevronRight, ExternalLink, Search, ServerCrash } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type ProductSummary, type SubscriptionInput, type Target } from '../api'
import { emptySubscription, SubscriptionForm } from '../components/SubscriptionForm'
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Spinner, StatusBadge, StatusDot, Toggle } from '../components/ui'
import { useProviders, useSettings, useTick } from '../hooks'
import { configLabel, deliveryLabel, formatPrice, locationName, parseTarget, statusLabel, targetKey, timeAgo } from '../lib'

function Cell({ s }: { s?: ProductSummary['locations'][string] }) {
  if (!s) return <span className="text-zinc-300 dark:text-zinc-700">·</span>
  const label = `${statusLabel[s.status]} · ${s.inStock}/${s.total} 个配置有货${s.inStock ? ' · 最快 ' + deliveryLabel(s.raw) : ''}`
  return (
    <span title={label} className="inline-flex items-center gap-1">
      <StatusDot status={s.status} />
      {s.inStock > 0 && <span className="text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">{s.inStock}</span>}
    </span>
  )
}

function Detail({ target, code }: { target: Target; code: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['stock-detail', target, code], queryFn: () => api.stockDetail(target, code) })
  if (isLoading || !data) return <Spinner className="mx-auto my-6" />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-zinc-500 dark:text-zinc-400">
            <th className="px-3 py-2 text-left font-medium">配置</th>
            {data.locations.map((l) => (
              <th key={l} className="px-2 py-2 text-left font-mono font-medium" title={locationName(l)}>
                {l.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {data.configs.map((c) => (
            <tr key={c.config}>
              <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap text-zinc-600 dark:text-zinc-300">{configLabel(c.config, code)}</td>
              {data.locations.map((l) => {
                const s = c.locations[l]
                return (
                  <td key={l} className="px-2 py-2 whitespace-nowrap">
                    {s ? (
                      <span title={`更新于 ${timeAgo(s.changedAt)}`}>
                        <StatusBadge status={s.status}>{s.status === 'available' || s.status === 'low' ? deliveryLabel(s.raw) : statusLabel[s.status]}</StatusBadge>
                      </span>
                    ) : (
                      <span className="text-zinc-300 dark:text-zinc-700">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Stock() {
  useTick()
  const [params, setParams] = useSearchParams()
  const providers = useProviders()
  const settings = useSettings()
  const target = parseTarget(params.get('t') ?? 'ovh:eu')
  const [q, setQ] = useState('')
  const [family, setFamily] = useState('')
  const [onlyInStock, setOnlyInStock] = useState(false)
  const [onlyCatalog, setOnlyCatalog] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [subInit, setSubInit] = useState<SubscriptionInput | null>(null)

  const { data, isLoading, error } = useQuery({ queryKey: ['stock', target], queryFn: () => api.stock(target) })

  const families = useMemo(() => [...new Set((data?.products ?? []).map((p) => p.family).filter(Boolean))].sort(), [data])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.products ?? []).filter((p) => {
      if (onlyCatalog && !p.inCatalog) return false
      if (onlyInStock && p.inStock === 0) return false
      if (family && p.family !== family) return false
      if (needle && ![p.code, p.name, p.specs?.cpu ?? ''].some((s) => s.toLowerCase().includes(needle))) return false
      return true
    })
  }, [data, q, family, onlyInStock, onlyCatalog])

  // Only show location columns that the filtered rows actually have.
  const cols = useMemo(() => (data?.locations ?? []).filter((l) => rows.some((p) => p.locations[l])), [data, rows])

  const monitored = settings.data?.targets.some((t) => targetKey(t) === targetKey(target)) || !!data?.poll

  return (
    <>
      <PageHeader
        title="库存浏览"
        description={data?.poll ? `${data.products.length} 个机型 · 更新于 ${timeAgo(data.poll.lastSuccess)}` : '按机型和机房查看实时库存'}
        actions={
          <Select value={targetKey(target)} onChange={(e) => setParams({ t: e.target.value })} className="w-56">
            {providers.data?.flatMap((p) =>
              p.regions.map((r) => (
                <option key={`${p.id}:${r.id}`} value={`${p.id}:${r.id}`}>
                  {p.name} · {r.name}
                </option>
              )),
            )}
          </Select>
        }
      />

      {!monitored && !isLoading && (
        <div className="mb-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          该区域尚未加入监控。在 <Link to="/settings" className="font-medium text-emerald-600 underline dark:text-emerald-400">设置</Link> 中勾选它，或直接为其中的机型创建订阅。
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索机型、代码、CPU" className="pl-9" />
          </div>
          <Select value={family} onChange={(e) => setFamily(e.target.value)} className="w-40">
            <option value="">全部系列</option>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
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
          <Empty title={data?.products.length ? '没有符合条件的机型' : '暂无数据'}>{data?.products.length ? '尝试调整筛选条件。' : '监控开始后首次轮询完成即可看到库存。'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50/80 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
                <tr>
                  <th className="sticky-col bg-zinc-50 px-4 py-2.5 text-left font-medium dark:bg-zinc-900">机型</th>
                  <th className="px-3 py-2.5 text-left font-medium">CPU</th>
                  <th className="px-3 py-2.5 text-right font-medium">月付</th>
                  {cols.map((l) => (
                    <th key={l} className="px-2 py-2.5 text-left font-mono font-medium" title={locationName(l)}>
                      {l.length > 4 ? l.split('-').slice(-2).join('-').toUpperCase() : l.toUpperCase()}
                    </th>
                  ))}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((p) => {
                  const open = expanded === p.code
                  return (
                    <Fragment key={p.code}>
                      <tr className={clsx('group cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40', open && 'bg-zinc-50 dark:bg-zinc-800/40')} onClick={() => setExpanded(open ? null : p.code)}>
                        <td className="sticky-col bg-white px-4 py-2.5 group-hover:bg-zinc-50 dark:bg-zinc-900 dark:group-hover:bg-zinc-800">
                          <div className="flex items-center gap-2">
                            {open ? <ChevronDown className="size-3.5 text-zinc-400" /> : <ChevronRight className="size-3.5 text-zinc-400" />}
                            <div>
                              <div className="flex items-center gap-1.5 font-medium whitespace-nowrap">
                                {p.name}
                                {p.inStock > 0 && <StatusDot status="available" pulse />}
                              </div>
                              <div className="flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-zinc-500">
                                {p.code}
                                {p.family && <Badge className="font-sans">{p.family}</Badge>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                          {p.specs?.cpu ?? '—'}
                          {p.specs?.cores && <span className="ml-1 text-zinc-400">{p.specs.cores}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{formatPrice(p.price, p.currency)}</td>
                        {cols.map((l) => (
                          <td key={l} className="px-2 py-2.5">
                            <Cell s={p.locations[l]} />
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1 opacity-70 group-hover:opacity-100">
                            {p.orderUrl && (
                              <a href={p.orderUrl} target="_blank" rel="noreferrer" title="前往官网" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700">
                                <ExternalLink className="size-4" />
                              </a>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setSubInit({ ...emptySubscription(target.provider, target.region), productCode: p.code })}>
                              <BellPlus className="size-4" /> 订阅
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={cols.length + 4} className="bg-zinc-50/60 px-4 py-3 dark:bg-zinc-950/40">
                            <Detail target={target} code={p.code} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        {(['available', 'low', 'unavailable', 'unknown'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <StatusDot status={s} /> {statusLabel[s]}
          </span>
        ))}
        <span>数字 = 该机房有货的配置数</span>
      </div>

      <SubscriptionForm open={!!subInit} onClose={() => setSubInit(null)} initial={subInit ?? emptySubscription()} />
    </>
  )
}
