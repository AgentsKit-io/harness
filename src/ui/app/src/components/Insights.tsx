import * as React from 'react'
import { useIssuePanel } from '@/lib/useIssuePanel'
import { cn } from '@/lib/utils'

/** Load once per `deps` change; keeps the previous data while reloading so charts don't flash empty. */
export const useFetched = <T,>(load: () => Promise<T>, deps: React.DependencyList): { readonly data: T | null; readonly error: string | null; readonly loading: boolean; readonly reload: () => void } => {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [nonce, setNonce] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().then((value) => { if (!cancelled) { setData(value); setError(null) } })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `load` is recreated every render; `deps` is the contract.
  }, [...deps, nonce])
  return { data, error, loading, reload: React.useCallback(() => setNonce((value) => value + 1), []) }
}

/** Opens the issue side panel (rendered once by `Shell`). */
export const useOpenIssue = (): ((issue: string) => void) => useIssuePanel().open

export const RangeChips = <V extends string>({ options, value, onChange, label }: {
  readonly options: readonly { readonly value: V; readonly label: string }[]
  readonly value: V
  readonly onChange: (value: V) => void
  readonly label: string
}): React.ReactElement => (
  <div role="group" aria-label={label} className="flex gap-1.5">
    {options.map((option) => (
      <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}
        className={cn('h-8 rounded-full border px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-info',
          option.value === value ? 'border-ink bg-ink font-semibold text-surface' : 'border-line text-ink-muted hover:border-accent')}>
        {option.label}
      </button>
    ))}
  </div>
)

/** Card section used by the insight grids: title, optional caption and right-aligned figure. */
export const Panel = ({ title, caption, aside, className, children }: {
  readonly title: string
  readonly caption?: React.ReactNode
  readonly aside?: React.ReactNode
  readonly className?: string
  readonly children: React.ReactNode
}): React.ReactElement => (
  <section aria-label={title} className={cn('flex min-h-0 min-w-0 flex-col gap-2.5 rounded-xl border border-line-soft bg-panel px-[18px] py-4', className)}>
    <div className="flex items-baseline gap-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {caption && <span className="min-w-0 truncate text-xs text-ink-subtle">{caption}</span>}
      {aside && <span className="ml-auto flex shrink-0 items-baseline gap-1.5">{aside}</span>}
    </div>
    {children}
  </section>
)

export const Loading = (): React.ReactElement => <div className="py-10 text-center text-sm text-ink-subtle" role="status">Loading…</div>
