import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api, type Subscription, type SubscriptionInput } from '../api'
import { emptySubscription, SubscriptionForm } from '../components/SubscriptionForm'
import { Badge, Button, Card, Empty, PageHeader, Spinner, StatusDot, Toggle, useToast } from '../components/ui'
import { locationName, locationShort, timeAgo } from '../lib'
import { useTargetName } from '../components/RegionPicker'

const toInput = ({ id: _id, createdAt: _c, ...rest }: Subscription): SubscriptionInput => rest

export function Subscriptions() {
  const targetName = useTargetName()
  const qc = useQueryClient()
  const toast = useToast()
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions })
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview })
  const [form, setForm] = useState<{ initial: SubscriptionInput; editing?: Subscription } | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['subscriptions'] })
    qc.invalidateQueries({ queryKey: ['overview'] })
  }
  const toggle = useMutation({
    mutationFn: (s: Subscription) => api.updateSubscription(s.id, { ...toInput(s), enabled: !s.enabled }),
    onSuccess: invalidate,
    onError: (e) => toast('error', (e as Error).message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteSubscription(id),
    onSuccess: () => {
      invalidate()
      toast('success', '订阅已删除')
    },
    onError: (e) => toast('error', (e as Error).message),
  })

  const live = new Map(overview.data?.watched.map((w) => [w.id, w]))

  return (
    <>
      <PageHeader
        title="订阅管理"
        description="订阅的机型在指定机房补货时，通过 Telegram 推送通知"
        actions={
          <Button variant="primary" onClick={() => setForm({ initial: emptySubscription() })}>
            <Plus className="size-4" /> 新建订阅
          </Button>
        }
      />
      <Card>
        {subs.isLoading ? (
          <Spinner className="mx-auto my-16" />
        ) : !subs.data?.length ? (
          <Empty icon={<Bell className="size-8" />} title="还没有订阅">
            点击右上角“新建订阅”，或在库存浏览中直接订阅机型。
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50/80 text-xs text-zinc-500 dark:bg-zinc-800/40 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">机型</th>
                  <th className="px-3 py-2.5 text-left font-medium">区域</th>
                  <th className="px-3 py-2.5 text-left font-medium">机房</th>
                  <th className="px-3 py-2.5 text-left font-medium">配置过滤</th>
                  <th className="px-3 py-2.5 text-left font-medium">通知</th>
                  <th className="px-3 py-2.5 text-left font-medium">当前</th>
                  <th className="px-3 py-2.5 text-left font-medium">启用</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {subs.data.map((s) => {
                  const w = live.get(s.id)
                  return (
                    <tr key={s.id} className={s.enabled ? '' : 'opacity-55'}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{w?.name ?? s.productCode}</div>
                        <div className="font-mono text-[11px] text-zinc-500">
                          #{s.id} · {s.productCode}
                        </div>
                        {s.note && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{s.note}</div>}
                      </td>
                      <td className="px-3 py-3 text-xs whitespace-nowrap">{targetName(s)}</td>
                      <td className="px-3 py-3">
                        {s.locations.length ? (
                          <div className="flex flex-wrap gap-1">
                            {s.locations.map((l) => (
                              <Badge key={l}>
                                <span title={locationName(l)}>{locationShort(l)}</span>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-500">全部</span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-300">{s.configFilter || <span className="font-sans text-zinc-400">—</span>}</td>
                      <td className="px-3 py-3 text-xs whitespace-nowrap">{s.notifyOn === 'all' ? '补货 + 售罄' : '仅补货'}</td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {w ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <StatusDot status={w.inStock ? 'available' : 'unavailable'} pulse />
                            {w.inStock ? `${w.inStock} 个有货` : '无货'}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <Toggle checked={s.enabled} onChange={() => toggle.mutate(s)} />
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <span className="mr-2 text-xs text-zinc-400" title={s.createdAt}>
                          {timeAgo(s.createdAt)}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => setForm({ initial: toInput(s), editing: s })} aria-label="编辑">
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="删除"
                          className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
                          onClick={() => confirm(`删除订阅 #${s.id}（${s.productCode}）？`) && remove.mutate(s.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <SubscriptionForm open={!!form} onClose={() => setForm(null)} initial={form?.initial ?? emptySubscription()} editing={form?.editing} />
    </>
  )
}
