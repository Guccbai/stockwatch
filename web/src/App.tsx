import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api, setUnauthorizedHandler } from './api'
import { Layout } from './components/Layout'
import { Spinner } from './components/ui'
import { Dashboard } from './pages/Dashboard'
import { History } from './pages/History'
import { Login } from './pages/Login'
import { SettingsPage } from './pages/Settings'
import { Stock } from './pages/Stock'
import { Subscriptions } from './pages/Subscriptions'

export function App() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })

  useEffect(() => {
    setUnauthorizedHandler(() => qc.setQueryData(['me'], (old: { version: string } | undefined) => ({ authenticated: false, version: old?.version ?? '' })))
  }, [qc])

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!me.data?.authenticated) return <Login />

  return (
    <Routes>
      <Route element={<Layout version={me.data.version} />}>
        <Route index element={<Dashboard />} />
        <Route path="stock" element={<Stock />} />
        <Route path="subscriptions" element={<Subscriptions />} />
        <Route path="history" element={<History />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
