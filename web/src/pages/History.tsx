import clsx from 'clsx'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, History as HistoryIcon, Search } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { Badge, Button, Card, Empty, Input, PageHeader, Spinner, StatusBadge } from '../components/ui'
import { useDebounced } from '../useDebounced'
import { configText, deliveryLabel, formatTime, isInStock, locationName, locationShort, timeAgo } from '../lib'
import { useTargetName } from '../components/RegionPicker'

const PAGE = 100

function Events() {
  const targetName = useTargetName()
  const [restock, setRestock] = useState(true)
  const [product, setProduct] = useState('')
  const debounced = useDebounced(product.trim(), 300)
  const q = useInfiniteQuery({
    queryKey: ['events', restock, debounced],
    queryFn: ({ pageParam }) => api.events({ restock, product: debounced, limit: PAGE, before: pageParam || undefined }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].id : undefined),
  })
  const events = q.data?.pages.flat() ?? []

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {[
            [true, '仅补货'],
            [false, '全部变化'],
          ].map(([v, label]) => (
            <button
              key={String(v)}
              onClick={() => setRestock(v as boolean)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                restock === v ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400',
              )}
            >
              {label as string}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
          <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="按机型代码精确过滤，如 24sk602" className="pl-9" />
        </div>
      </div>
      {q.isLoading ? (
        <Spinner className="mx-auto my-16" />
      ) : events.length === 0 ? (
        <Empty icon={<HistoryIcon className="size-8" />} title="暂无记录">首次轮询只记录基线，之后的状态变化会出现在这里。</Empty>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50/80 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">时间</th>
                  <th className="px-3 py-2.5 text-left font-medium">机型</th>
                  <th className="px-3 py-2.5 text-left font-medium">机房</th>
                  <th className="px-3 py-2.5 text-left font-medium">配置</th>
                  <th className="px-3 py-2.5 text-left font-medium">变化</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-zinc-500 tabular-nums dark:text-zinc-400" title={timeAgo(e.at)}>
                      {formatTime(e.at)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="font-mono text-xs font-medium">{e.productCode}</span>
                      <Badge className="ml-1.5">{targetName(e)}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" title={locationName(e.location)}>
                      {locationShort(e.location)}
                    </td>
                    <td className="max-w-96 truncate px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300" title={e.config}>
                      {configText(e.config, e.productCode)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusBadge status={e.from} />
                        <ArrowRight className="size-3 text-zinc-400" />
                        <StatusBadge status={e.to}>{isInStock(e.to) ? deliveryLabel(e.rawState) : undefined}</StatusBadge>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
              <Button size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                加载更多
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function Notifications() {
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications(100), refetchInterval: 30_000 })
  return (
    <Card>
      {q.isLoading ? (
        <Spinner className="mx-auto my-16" />
      ) : !q.data?.length ? (
        <Empty title="还没有发送过通知" />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {q.data.map((n) => (
            <li key={n.id} className="flex items-start gap-3 px-4 py-3 text-sm">
              <StatusBadge status={n.ok ? 'available' : 'unavailable'}>{n.ok ? '成功' : '失败'}</StatusBadge>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-zinc-600 dark:text-zinc-300">
                  <span className="font-medium">{n.channel}</span>
                  {n.subscriptionId ? ` · 订阅 #${n.subscriptionId}` : ' · 测试消息'}
                </div>
                {n.error && <div className="mt-0.5 text-xs break-all text-rose-600 dark:text-rose-400">{n.error}</div>}
              </div>
              <time className="shrink-0 text-xs text-zinc-400 tabular-nums">{formatTime(n.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function History() {
  const [tab, setTab] = useState<'events' | 'notifications'>('events')
  return (
    <>
      <PageHeader title="历史记录" description="库存状态变化与通知发送记录" />
      <div className="mb-4 flex gap-6 border-b border-zinc-200 dark:border-zinc-800">
        {(
          [
            ['events', '库存变化'],
            ['notifications', '通知记录'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={clsx(
              '-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors',
              tab === k ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'events' ? <Events /> : <Notifications />}
    </>
  )
}
