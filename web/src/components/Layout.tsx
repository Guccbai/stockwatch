import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, Boxes, History, LayoutDashboard, LogOut, Menu, Moon, Settings, Sun, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from '../api'
import { useLiveUpdates, useTheme } from '../hooks'
import { useToast } from './ui'

const nav = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/stock', label: '库存浏览', icon: Boxes },
  { to: '/subscriptions', label: '订阅管理', icon: Bell },
  { to: '/history', label: '历史记录', icon: History },
  { to: '/settings', label: '设置', icon: Settings },
]

export function Layout({ version }: { version: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [dark, setDark] = useTheme()
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 60_000 })
  const connected = useLiveUpdates((evs) => toast('success', `补货：${[...new Set(evs.map((e) => e.productCode))].slice(0, 3).join('、')} 等 ${evs.length} 项`))

  const logout = async () => {
    await api.logout().catch(() => {})
    qc.clear()
    qc.setQueryData(['me'], { authenticated: false, version })
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <img src="/favicon.svg" alt="" className="size-7" />
        <div>
          <div className="text-sm font-semibold tracking-tight">StockWatch</div>
          <div className="text-[11px] text-zinc-500">云服务商库存监控</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100',
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
        {overview.data?.paused && (
          <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            <BellOff className="size-3.5" /> 通知已暂停
          </div>
        )}
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className={clsx('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-zinc-400')} />
            {connected ? '实时连接' : '连接中…'}
          </span>
          <span className="font-mono">{version}</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setDark(!dark)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            {dark ? '浅色' : '深色'}
          </button>
          <button
            onClick={logout}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <LogOut className="size-3.5" /> 退出
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-900">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-950/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-64 bg-white shadow-xl dark:bg-zinc-900">
            <button className="absolute top-4 right-3 p-1 text-zinc-500" onClick={() => setMobileOpen(false)} aria-label="关闭菜单">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-zinc-200 bg-white px-4 lg:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <button onClick={() => setMobileOpen(true)} className="p-1 text-zinc-600 dark:text-zinc-300" aria-label="打开菜单">
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold">{nav.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))?.label}</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
