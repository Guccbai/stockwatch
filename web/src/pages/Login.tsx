import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Button, Input } from '../components/ui'

export function Login() {
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await api.login(password)
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="mb-4 size-12" />
          <h1 className="text-xl font-semibold tracking-tight">StockWatch</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">云服务商库存监控平台</p>
        </div>
        <form onSubmit={submit} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300" htmlFor="pw">
            管理员密码
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
            <Input id="pw" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-9" />
          </div>
          {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <Button type="submit" variant="primary" loading={loading} disabled={!password} className="mt-5 w-full">
            登录
          </Button>
          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">首次启动时的密码来自环境变量 SW_ADMIN_PASSWORD，未设置时会打印在服务日志中。</p>
        </form>
      </div>
    </div>
  )
}
