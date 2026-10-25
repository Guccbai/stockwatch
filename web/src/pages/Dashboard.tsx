import clsx from 'clsx'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, Bell, CheckCircle2, PackageCheck, RefreshCw, Send, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, type PollStatus } from '../api'
import { Badge, Button, Card, CardHeader, Empty, PageHeader, Spinner, StatusDot, useToast } from '../components/ui'
import { useTick } from '../hooks'
import { configText, deliveryLabel, formatTime, locationName, locationShort, timeAgo } from '../lib'
import { useTargetName } from '../components/RegionPicker'

function Stat({ label, value, sub, icon, tone = 'zinc' }: { label: string; value: ReactNode; sub?: ReactNode; icon: ReactNode; tone?: 'zinc' | 'emerald' | 'amber' }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        </div>
        <div
          className={clsx(
            'rounded-lg p-2',
            tone === 'emerald' && 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
            tone === 'amber' && 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
            tone === 'zinc' && 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
          )}
        >
          {icon}
        </div>
      </div>
      {sub && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </Card>
  )
}

function PollRow({ p }: { p: PollStatus }) {
  const targetName = useTargetName()
  const ok = !p.lastError
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="flex min-w-40 items-center gap-2.5">
        {ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <AlertTriangle className="size-4 text-amber-500" />}
        <span className="text-sm font-medium">{targetName(p.target)}</span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        上次成功 <span className="text-zinc-700 dark:text-zinc-200">{timeAgo(p.lastSuccess)}</span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        耗时 <span className="text-zinc-700 tabular-nums dark:text-zinc-200">{p.durationMs} ms</span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        有货 <span className="font-medium text-emerald-600 tabular-nums dark:text-emerald-400">{p.inStock.toLocaleString()}</span> / {p.slots.toLocaleString()}
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">下次 {timeAgo(p.nextPoll)}</div>
      {!ok && <div className="w-full truncate text-xs text-amber-600 dark:text-amber-400">错误（连续 {p.failures} 次）：{p.lastError}</div>}
      {p.catalogError && <div className="w-full truncate text-xs text-amber-600 dark:text-amber-400">目录刷新失败：{p.catalogError}</div>}
    </div>
  )
}

export function Dashboard() {
  const targetName = useTargetName()
  useTick()
  const toast = useToast()
  const { data, isLoading } = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 60_000 })
  const poll = useMutation({ mutationFn: api.pollNow, onSuccess: () => toast('success', '已触发立即轮询') })

  if (isLoading || !data) return <Spinner className="mx-auto mt-20" />

  const slots = data.polls.reduce((n, p) => n + p.slots, 0)
  const inStock = data.polls.reduce((n, p) => n + p.inStock, 0)
  const failing = data.polls.filter((p) => p.lastError).length
  const watchedInStock = data.watched.filter((w) => w.inStock > 0).length

  return (
    <>
      <PageHeader
        title="仪表盘"
        description={`每 ${data.interval} 秒轮询一次，库存变化实时推送`}
        actions={
          <Button onClick={() => poll.mutate()} loading={poll.isPending}>
            <RefreshCw className="size-4" /> 立即轮询
          </Button>
        }
      />

      {!data.notifyConfigured && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <Send className="size-4" /> 尚未配置通知渠道（Telegram 或 Resend 邮件），补货时将无法收到推送。
          </span>
          <Link to="/settings" className="font-medium underline underline-offset-2">
            前往设置
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="监控目标" value={data.polls.length} sub={failing ? `${failing} 个目标轮询异常` : '全部正常'} icon={<Activity className="size-4" />} tone={failing ? 'amber' : 'zinc'} />
        <Stat label="当前有货配置" value={inStock.toLocaleString()} sub={`共 ${slots.toLocaleString()} 个配置 × 机房`} icon={<PackageCheck className="size-4" />} tone="emerald" />
        <Stat label="24 小时补货" value={data.restocks24h} sub="状态从无货变为有货" icon={<TrendingUp className="size-4" />} />
        <Stat label="订阅" value={`${data.enabledSubscriptions} / ${data.subscriptions}`} sub={`${watchedInStock} 个订阅当前有货`} icon={<Bell className="size-4" />} tone={watchedInStock ? 'emerald' : 'zinc'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHeader
              title="我的订阅"
              description="启用订阅的实时库存"
              actions={
                <Link to="/subscriptions" className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                  管理
                </Link>
              }
            />
            {data.watched.length === 0 ? (
              <Empty icon={<Bell className="size-8" />} title="还没有订阅">
                去 <Link to="/stock" className="text-emerald-600 underline dark:text-emerald-400">库存浏览</Link> 选择要监控的机型。
              </Empty>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.watched.map((w) => (
                  <li key={w.id} className="flex items-center gap-3 px-5 py-3">
                    <StatusDot status={w.inStock > 0 ? 'available' : 'unavailable'} pulse />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{w.name}</span>
                        <Badge className="font-mono">{w.productCode}</Badge>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {targetName(w)} · {w.inStock ? `有货：${w.locations.map(locationShort).join('、')}` : '暂无库存'}
                      </div>
                    </div>
                    <span className={clsx('text-sm font-semibold tabular-nums', w.inStock ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400')}>{w.inStock}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="轮询状态" />
            {data.polls.length === 0 ? (
              <Empty title="没有监控目标">在设置中选择要监控的区域。</Empty>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.polls.map((p) => (
                  <PollRow key={`${p.target.provider}:${p.target.region}`} p={p} />
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <CardHeader
            title="最近补货"
            actions={
              <Link to="/history" className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                全部
              </Link>
            }
          />
          {data.recentRestocks.length === 0 ? (
            <Empty icon={<TrendingUp className="size-8" />} title="暂无补货记录">监控启动后，状态变化会出现在这里。</Empty>
          ) : (
            <ol className="relative space-y-0 px-5 py-4">
              {data.recentRestocks.map((e, i) => (
                <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < data.recentRestocks.length - 1 && <span className="absolute top-3 left-[3px] h-full w-px bg-zinc-200 dark:bg-zinc-800" />}
                  <StatusDot status={e.to} className="relative mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-sm font-medium">{e.productCode}</span>
                      <time className="shrink-0 text-xs text-zinc-400" title={formatTime(e.at)}>
                        {timeAgo(e.at)}
                      </time>
                    </div>
                    <div className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={e.config}>
                      <span className="font-medium text-zinc-700 dark:text-zinc-300" title={locationName(e.location)}>
                        {locationShort(e.location)}
                      </span>{' '}
                      · {deliveryLabel(e.rawState)} · {configText(e.config, e.productCode)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  )
}
