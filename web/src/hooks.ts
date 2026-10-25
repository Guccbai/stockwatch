import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type PollStatus, type StockEvent } from './api'

/** Subscribes to the server's SSE stream and refreshes cached queries when stock changes. */
export function useLiveUpdates(onRestock?: (events: StockEvent[]) => void) {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)
  const cb = useRef(onRestock)
  cb.current = onRestock

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout>
    let closed = false
    const connect = () => {
      es = new EventSource('/api/stream')
      es.onopen = () => setConnected(true)
      es.onerror = () => {
        setConnected(false)
        es?.close()
        if (!closed) retry = setTimeout(connect, 5000)
      }
      es.addEventListener('poll', (e) => {
        const polls = JSON.parse((e as MessageEvent).data) as PollStatus[]
        qc.setQueryData(['overview'], (old: unknown) => (old ? { ...(old as object), polls } : old))
        qc.invalidateQueries({ queryKey: ['stock'] })
      })
      es.addEventListener('events', (e) => {
        const events = JSON.parse((e as MessageEvent).data) as StockEvent[]
        qc.invalidateQueries({ queryKey: ['overview'] })
        qc.invalidateQueries({ queryKey: ['events'] })
        qc.invalidateQueries({ queryKey: ['stock-detail'] })
        const restocks = events.filter((x) => (x.to === 'available' || x.to === 'low') && x.from !== 'available' && x.from !== 'low')
        if (restocks.length) cb.current?.(restocks)
      })
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      es?.close()
    }
  }, [qc])
  return connected
}

export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: api.providers, staleTime: Infinity })
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings })
}

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('sw-theme', dark ? 'dark' : 'light')
    } catch {
      /* storage unavailable */
    }
  }, [dark])
  return [dark, setDark] as const
}

/** Re-renders every `ms` so relative timestamps stay fresh. */
export function useTick(ms = 15_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}
