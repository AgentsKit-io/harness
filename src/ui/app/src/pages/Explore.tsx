import * as React from 'react'
import { Copy, ExternalLink, Search } from 'lucide-react'
import { EmptyState, Shell } from '@/components/Shell'
import { useOpenIssue } from '@/components/Insights'
import { tone } from '@/components/charts'
import { Button } from '@/components/ui/button'
import { searchRecords, type MetricsWindow, type SearchHit, type SearchResult, type SearchType } from '@/lib/api'
import { formatAgo } from '@/lib/format'
import { useLiveSnapshot } from '@/lib/snapshot'
import { cn } from '@/lib/utils'

type ExploreWindow = Extract<MetricsWindow, '24h' | '7d' | '30d'>
const PERIODS: readonly { readonly value: ExploreWindow; readonly label: string }[] = [
  { value: '7d', label: 'Last 7 days' }, { value: '24h', label: 'Last 24h' }, { value: '30d', label: 'Last 30 days (max)' },
]
const TYPES: readonly SearchType[] = ['event', 'contract', 'evidence', 'review', 'learning']
const TYPE_COLOR: Readonly<Record<SearchType, string>> = { event: 'var(--color-accent-strong)', contract: tone.system, evidence: tone.success, review: tone.warning, learning: tone.drift }
const MIN_CHARS = 2
const DEBOUNCE_MS = 300

const useDebounced = <T,>(value: T, ms: number): T => {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => { const timer = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(timer) }, [value, ms])
  return debounced
}

const TypeTag = ({ type }: { readonly type: SearchType }): React.ReactElement => (
  <span className="rounded-[5px] bg-surface px-2 py-0.5 font-mono text-[11px]" style={{ color: TYPE_COLOR[type] }}>{type}</span>
)

const Preview = ({ hit }: { readonly hit: SearchHit }): React.ReactElement => {
  const openIssue = useOpenIssue()
  const [copied, setCopied] = React.useState(false)
  const json = JSON.stringify(hit.body, null, 2)
  const copy = (): void => { void navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_500) }) }
  return (
    <aside aria-label="Result preview" className="flex w-[430px] shrink-0 flex-col gap-3.5 overflow-hidden rounded-xl border border-line-soft bg-panel p-[18px]">
      <div className="flex items-center gap-2.5">
        <TypeTag type={hit.type} />
        <span className="font-mono text-sm font-semibold text-accent-strong">{hit.issue ?? hit.id}</span>
        <span className="ml-auto font-mono text-xs text-ink-subtle">{formatAgo(hit.at)}</span>
      </div>
      <h2 className="text-base font-semibold">{hit.title}</h2>
      <pre className="min-h-0 grow overflow-auto rounded-lg border border-line-soft bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-muted">{json}</pre>
      <div className="flex flex-col gap-1.5 font-mono text-xs text-ink-subtle">
        <span>source <span className="text-ink-muted">{hit.source}</span></span>
        <span>id <span className="text-ink-muted">{hit.id}</span></span>
      </div>
      <div className="flex gap-2">
        {hit.issue && <Button variant="primary" onClick={() => openIssue(hit.issue ?? '')}><ExternalLink className="size-4" aria-hidden />Open issue</Button>}
        <Button variant="outline" onClick={copy}><Copy className="size-4" aria-hidden />{copied ? 'Copied' : 'Copy JSON'}</Button>
        <span className="sr-only" role="status">{copied ? 'JSON copied to clipboard' : ''}</span>
      </div>
    </aside>
  )
}

export const ExplorePage = (): React.ReactElement => {
  const { snapshot } = useLiveSnapshot()
  const [query, setQuery] = React.useState('')
  const [period, setPeriod] = React.useState<ExploreWindow>('7d')
  const [issue, setIssue] = React.useState('')
  const [hidden, setHidden] = React.useState<ReadonlySet<SearchType>>(new Set())
  const [result, setResult] = React.useState<SearchResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const q = useDebounced(query.trim(), DEBOUNCE_MS)

  React.useEffect(() => {
    if (q.length < MIN_CHARS) { setResult(null); setError(null); return }
    let cancelled = false
    setLoading(true)
    // ponytail: all types are fetched and the chips filter locally, so every chip keeps its count while toggled off.
    searchRecords({ q, window: period, issue: issue || null })
      .then((value) => { if (!cancelled) { setResult(value); setError(null); setSelected(value.hits[0]?.id ?? null) } })
      .catch((cause: unknown) => { if (!cancelled) { setResult(null); setError(cause instanceof Error ? cause.message : String(cause)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [q, period, issue])

  const shown = result?.hits.filter((hit) => !hidden.has(hit.type)) ?? []
  const current = shown.find((hit) => hit.id === selected) ?? shown[0] ?? null
  const periodLabel = PERIODS.find((item) => item.value === period)?.label.toLowerCase() ?? period
  const toggle = (type: SearchType): void => setHidden((prev) => { const next = new Set(prev); if (next.has(type)) next.delete(type); else next.add(type); return next })
  const issues = snapshot?.issues.map((record) => record.issue) ?? []

  return (
    <Shell title="Explore" subtitle={<span className="font-sans">Search everything the loop produced: events, contracts, evidence, reviews, learnings.</span>} bare>
      <div className="flex flex-col gap-3 px-8 pt-5 pb-3.5">
        <div className="flex gap-2.5">
          <label className="flex h-11 grow items-center gap-2.5 rounded-[9px] border border-line bg-panel-alt px-3.5 text-ink-subtle focus-within:border-accent">
            <Search className="size-[18px]" aria-hidden />
            <span className="sr-only">Search</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus placeholder="Search at least 2 characters, e.g. duplicate row"
              className="grow border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle" />
            {result && <span className="font-mono text-xs" aria-live="polite">{result.hits.length}{result.truncated ? '+' : ''} results · {result.tookMs} ms</span>}
            {loading && !result && <span className="font-mono text-xs" role="status">searching…</span>}
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-subtle">Period
            <select value={period} onChange={(event) => setPeriod(event.target.value as ExploreWindow)} className="h-11 rounded-[9px] border border-line bg-panel-alt px-3 text-[13px] text-ink">
              {PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-subtle">Issue
            <select value={issue} onChange={(event) => setIssue(event.target.value)} className="h-11 max-w-[180px] rounded-[9px] border border-line bg-panel-alt px-3 text-[13px] text-ink">
              <option value="">Any</option>
              {issues.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          {TYPES.map((type) => {
            const on = !hidden.has(type)
            return (
              <button key={type} type="button" aria-pressed={on} onClick={() => toggle(type)}
                className={cn('h-[30px] rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-info', on ? 'bg-[#121a23] text-ink' : 'border-line text-ink-subtle')}
                style={on ? { borderColor: TYPE_COLOR[type] } : undefined}>
                {type} <span className="font-mono text-ink-subtle">{result?.counts[type] ?? 0}</span>
              </button>
            )
          })}
          <span className="ml-auto text-xs text-ink-subtle">Every search is bounded by the period; events older than 30 days are archived.</span>
        </div>
      </div>
      {error && <div role="alert" className="mx-8 mb-3 rounded-md border border-danger/40 bg-danger-dim px-4 py-3 text-sm text-red-200">Search failed: {error}</div>}
      <div className="flex min-h-0 grow gap-5 px-8 pb-[22px]">
        <section aria-label="Results" className="flex min-w-0 grow flex-col gap-2 overflow-auto">
          {q.length < MIN_CHARS ? <EmptyState>Type at least {MIN_CHARS} characters to search the {periodLabel}.</EmptyState>
            : result && shown.length === 0 ? <EmptyState>{result.hits.length ? 'Every matching type is filtered out.' : `No matches for “${result.query}” in the ${periodLabel}.`}</EmptyState>
              : null}
          {shown.map((hit) => {
            const active = hit.id === current?.id
            return (
              <button key={hit.id} type="button" aria-current={active ? 'true' : undefined} onClick={() => setSelected(hit.id)}
                className={cn('flex flex-col gap-1.5 rounded-[10px] border px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-info', active ? 'border-[#2b6f95] bg-[#0f1a24]' : 'border-line-soft bg-panel hover:border-line')}>
                <span className="flex w-full items-center gap-2.5">
                  <TypeTag type={hit.type} />
                  <span className="font-mono text-[13px] font-semibold text-accent-strong">{hit.issue ?? hit.id}</span>
                  <span className="truncate text-[13px] text-ink-muted">{hit.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-ink-subtle">{formatAgo(hit.at)}</span>
                </span>
                <span className="text-[13px] text-ink-muted">{hit.snippet.pre}<mark className="rounded-[3px] bg-[#3a3314] px-0.5 text-[#fde68a]">{hit.snippet.hit}</mark>{hit.snippet.post}</span>
              </button>
            )
          })}
          {result?.truncated && <p className="text-xs text-ink-subtle">Showing the first {result.hits.length} matches. Narrow the query, period or issue to see the rest.</p>}
        </section>
        {current ? <Preview key={current.id} hit={current} /> : <aside aria-label="Result preview" className="flex w-[430px] shrink-0 items-center justify-center rounded-xl border border-dashed border-line text-sm text-ink-subtle">Select a result to preview it.</aside>}
      </div>
    </Shell>
  )
}
