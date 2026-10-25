import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, type Settings, type SettingsUpdate } from '../api'
import { Button, Card, CardHeader, Field, Input, PageHeader, Spinner, Toggle, useToast } from '../components/ui'
import { useProviders, useSettings } from '../hooks'
import { targetKey } from '../lib'

function useSave() {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (s: SettingsUpdate) => api.updateSettings(s),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data)
      qc.invalidateQueries({ queryKey: ['overview'] })
      toast('success', '设置已保存')
    },
    onError: (e) => toast('error', (e as Error).message),
  })
}

function TelegramCard({ s }: { s: Settings }) {
  const toast = useToast()
  const save = useSave()
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState(s.telegramChatId)
  const [commands, setCommands] = useState(s.telegramCommands)
  useEffect(() => {
    setChatId(s.telegramChatId)
    setCommands(s.telegramCommands)
  }, [s])

  const test = useMutation({
    mutationFn: api.testNotify,
    onSuccess: () => toast('success', '测试消息已发送'),
    onError: (e) => toast('error', `发送失败：${(e as Error).message}`),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const body: SettingsUpdate = { telegramCommands: commands }
    if (!s.envOverrides.telegramChatId) body.telegramChatId = chatId
    if (token && !s.envOverrides.telegramToken) body.telegramToken = token
    save.mutate(body, { onSuccess: () => setToken('') })
  }

  return (
    <Card>
      <CardHeader title="Telegram 通知" description="补货时通过 Telegram Bot 推送消息" />
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field
          label="Bot Token"
          hint={
            s.envOverrides.telegramToken
              ? '由环境变量 SW_TELEGRAM_TOKEN 提供，无法在此修改'
              : s.telegramTokenSet
                ? `已设置（${s.telegramTokenHint || '已隐藏'}），留空保持不变`
                : '在 Telegram 中与 @BotFather 对话创建机器人获取'
          }
        >
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.telegramTokenSet ? '••••••••' : '123456789:AA…'} disabled={s.envOverrides.telegramToken} />
        </Field>
        <Field label="Chat ID" hint={s.envOverrides.telegramChatId ? '由环境变量 SW_TELEGRAM_CHAT_ID 提供' : '多个用英文逗号分隔。向机器人发送任意消息后，可通过 @userinfobot 或 getUpdates 获取；群组 ID 以 -100 开头'}>
          <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="例如 123456789" disabled={s.envOverrides.telegramChatId} />
        </Field>
        <Toggle checked={commands} onChange={setCommands} label="启用机器人命令（/status /subs /pause /resume）" />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" variant="primary" loading={save.isPending}>
            保存
          </Button>
          <Button type="button" onClick={() => test.mutate()} loading={test.isPending} disabled={!s.telegramTokenSet || !s.telegramChatId}>
            <Send className="size-4" /> 发送测试消息
          </Button>
        </div>
      </form>
    </Card>
  )
}

function MonitorCard({ s }: { s: Settings }) {
  const providers = useProviders()
  const save = useSave()
  const [interval, setInterval_] = useState(String(s.interval))
  const [cooldown, setCooldown] = useState(String(Math.round(s.cooldown / 60)))
  const [retention, setRetention] = useState(String(s.retentionDays))
  const [targets, setTargets] = useState(new Set(s.targets.map(targetKey)))
  useEffect(() => {
    setInterval_(String(s.interval))
    setCooldown(String(Math.round(s.cooldown / 60)))
    setRetention(String(s.retentionDays))
    setTargets(new Set(s.targets.map(targetKey)))
  }, [s])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate({
      interval: Number(interval),
      cooldown: Number(cooldown) * 60,
      retentionDays: Number(retention),
      targets: [...targets].map((k) => {
        const [provider, region] = k.split(':')
        return { provider, region }
      }),
    })
  }

  return (
    <Card>
      <CardHeader title="监控" description="轮询频率、通知防抖与监控区域" />
      <form onSubmit={submit} className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="轮询间隔（秒）" hint="最小 15 秒">
            <Input type="number" min={15} value={interval} onChange={(e) => setInterval_(e.target.value)} />
          </Field>
          <Field label="通知冷却（分钟）" hint="同一配置短时间内反复变化只通知一次">
            <Input type="number" min={0} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
          </Field>
          <Field label="历史保留（天）">
            <Input type="number" min={1} value={retention} onChange={(e) => setRetention(e.target.value)} />
          </Field>
        </div>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">监控区域</span>
          <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">勾选的区域会持续轮询以供库存浏览；有启用订阅的区域会自动加入。</p>
          <div className="space-y-3">
            {providers.data?.map((p) => (
              <div key={p.id}>
                <div className="mb-1.5 text-xs font-medium text-zinc-500">{p.name}</div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {p.regions.map((r) => {
                    const k = `${p.id}:${r.id}`
                    return (
                      <label key={k} className="inline-flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 rounded accent-emerald-600"
                          checked={targets.has(k)}
                          onChange={(e) => {
                            const next = new Set(targets)
                            if (e.target.checked) next.add(k)
                            else next.delete(k)
                            setTargets(next)
                          }}
                        />
                        {r.name} <span className="font-mono text-xs text-zinc-400">{r.id}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <Button type="submit" variant="primary" loading={save.isPending}>
          保存
        </Button>
      </form>
    </Card>
  )
}

function PauseCard({ s }: { s: Settings }) {
  const save = useSave()
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">暂停通知</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">暂停期间监控和历史记录照常进行，只是不发送通知。</p>
      </div>
      <Toggle checked={s.paused} onChange={(v) => save.mutate({ paused: v })} disabled={save.isPending} label={s.paused ? '已暂停' : '正常'} />
    </Card>
  )
}

function PasswordCard() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      toast('success', '密码已修改，其他设备需要重新登录')
      setCurrent('')
      setNext('')
      setConfirm('')
    },
    onError: (e) => toast('error', (e as Error).message),
  })
  const mismatch = confirm !== '' && confirm !== next
  return (
    <Card>
      <CardHeader title="修改密码" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          change.mutate()
        }}
        className="grid gap-4 p-5 sm:grid-cols-3"
      >
        <Field label="当前密码">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="新密码" hint="至少 8 位">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="确认新密码" hint={mismatch ? <span className="text-rose-600">两次输入不一致</span> : undefined}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 8 || next !== confirm}>
            修改密码
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function SettingsPage() {
  const { data } = useSettings()
  if (!data) return <Spinner className="mx-auto mt-20" />
  return (
    <>
      <PageHeader title="设置" />
      <div className="space-y-6">
        <TelegramCard s={data} />
        <MonitorCard s={data} />
        <PauseCard s={data} />
        <PasswordCard />
      </div>
    </>
  )
}
