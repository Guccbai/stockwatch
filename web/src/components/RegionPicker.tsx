import clsx from 'clsx'
import type { Target } from '../api'
import { useProviders } from '../hooks'
import { targetKey } from '../lib'

const regionFlag: Record<string, string> = { eu: '🇪🇺', ca: '🇨🇦', us: '🇺🇸' }

/** Segmented provider/region switcher; regions being polled get a green dot. */
export function RegionPicker({ value, onChange, monitored }: { value: Target; onChange: (t: Target) => void; monitored: Set<string> }) {
  const providers = useProviders()
  const current = targetKey(value)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {providers.data?.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{p.name}</span>
          <div role="radiogroup" aria-label={p.name} className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
            {p.regions.map((r) => {
              const t = { provider: p.id, region: r.id }
              const k = targetKey(t)
              const on = k === current
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={`${p.name} · ${r.name} (${r.id}, ${r.currency})${monitored.has(k) ? ' · 监控中' : ''}`}
                  onClick={() => onChange(t)}
                  className={clsx(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                    on ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                  )}
                >
                  {regionFlag[r.id] && <span aria-hidden>{regionFlag[r.id]}</span>}
                  {r.name}
                  {monitored.has(k) && <span className="size-1.5 rounded-full bg-emerald-500" aria-label="监控中" />}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** "ovh/eu" → "OVHcloud · 欧洲" once providers are loaded. */
export function useTargetName() {
  const providers = useProviders()
  return (t: Target) => {
    const p = providers.data?.find((x) => x.id === t.provider)
    const r = p?.regions.find((x) => x.id === t.region)
    return p && r ? `${p.name} · ${r.name}` : `${t.provider}/${t.region}`
  }
}
