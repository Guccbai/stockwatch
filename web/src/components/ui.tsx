import clsx from 'clsx'
import { X, Loader2 } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import type { StockStatus } from '../api'
import { statusLabel } from '../lib'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900', className)}>{children}</div>
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-emerald-600 text-white hover:bg-emerald-700',
        variant === 'secondary' && 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700',
        variant === 'ghost' && 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-700',
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

export const inputClass =
  'h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-500'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx(inputClass, className)} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx(inputClass, 'pr-8', className)}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex items-center gap-2.5 text-sm select-none', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500',
          checked ? 'bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700',
        )}
      >
        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
      {label}
    </label>
  )
}

const dotColor: Record<StockStatus, string> = {
  available: 'bg-emerald-500',
  low: 'bg-amber-500',
  unavailable: 'bg-rose-500/70',
  unknown: 'bg-zinc-400',
}

export function StatusDot({ status, pulse, className }: { status: StockStatus; pulse?: boolean; className?: string }) {
  return <span className={clsx('inline-block size-2 shrink-0 rounded-full', dotColor[status], pulse && status === 'available' && 'pulse-ring', className)} />
}

const badgeColor: Record<StockStatus, string> = {
  available: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20',
  low: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20',
  unavailable: 'bg-rose-50 text-rose-700 ring-rose-600/10 dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/20',
  unknown: 'bg-zinc-100 text-zinc-600 ring-zinc-500/10 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-700',
}

export function StatusBadge({ status, children }: { status: StockStatus; children?: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', badgeColor[status])}>
      <StatusDot status={status} />
      {children ?? statusLabel[status]}
    </span>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', className)}>
      {children}
    </span>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-zinc-300 dark:text-zinc-600">{icon}</div>}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-zinc-400', className)} />
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative flex h-full w-full max-w-lg flex-col bg-white shadow-2xl dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="关闭">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  )
}

// --- toasts ---

type Toast = { id: number; kind: 'success' | 'error'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ring-1',
              t.kind === 'success' ? 'bg-emerald-600 text-white ring-emerald-700' : 'bg-rose-600 text-white ring-rose-700',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
