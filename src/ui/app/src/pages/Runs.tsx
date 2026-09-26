import * as React from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Plus, Search } from 'lucide-react'
import { Shell } from '@/components/Shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CapBar, PhaseBar } from '@/components/IssuePanel'
import { cn } from '@/lib/utils'
import { getMetrics, type IssueRecord, type MetricsReport } from '@/lib/api'
import { formatAge, useLiveSnapshot, useSnapshotAge } from '@/lib/snapshot'
import { useIssuePanel } from '@/lib/useIssuePanel'
import { BUCKET_COLOR, fixRoundsAtCap, fixRoundsLabel, formatTokens, phaseAgeMs, matchesSearch, modelOf, phaseLabel, runBucket, tokensByIssue, type RunBucket } from '@/lib/runs'

export type RunFilter = 'all' | Exclude<RunBucket, 'available'>

const FILTERS: readonly { readonly id: RunFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'running', label: 'Running' }, { id: 'blocked', label: 'Blocked' }, { id: 'held', label: 'Held' },
  { id: 'review', label: 'Review' }, { id: 'queued', label: 'Queued' }, { id: 'done', label: 'Done' }, { id: 'archived', label: 'Archived' },
]

export const PAGE_SIZE = 25

/** "All" is everything the loop still owns: archived runs only show under their own chip. */
export const inFilter = (record: IssueRecord, filter: RunFilter): boolean => {
  const bucket = runBucket(record)
  return filter === 'all' ? bucket !== 'archived' : bucket === filter
}

export const filterCounts = (records: readonly IssueRecord[]): Readonly<Record<RunFilter, number>> =>
  Object.fromEntries(FILTERS.map(({ id }) => [id, records.filter((record) => inFilter(record, id)).length])) as Record<RunFilter, number>

const COLUMNS = 'grid grid-cols-[88px_minmax(0,1fr)_150px_64px_90px_48px_110px] gap-2.5'

export const RunsTable = ({ rows, tokens, now, selected, onOpen }: {
  readonly rows: readonly IssueRecord[]
  readonly tokens: ReadonlyMap<string, number>
  readonly now: number
  readonly selected: string | null
  readonly onOpen: (issue: string) => void
}): React.ReactElement => (
  <div role="table" aria-label="Runs" className="flex flex-col">
    <div role="row" className={cn(COLUMNS, 'border-b border-line-soft px-2.5 pb-2 font-mono text-[11px] tracking-[.06em] text-ink-subtle uppercase')}>
      {['ID', 'Title', 'Phase', 'In phase', 'Model', 'Rd', 'Tokens'].map((name) => <span key={name} role="columnheader">{name}</span>)}
    </div>
    {rows.map((record) => {
      const color = BUCKET_COLOR[runBucket(record)]
      const used = tokens.get(record.issue)
      const cap = record.run?.perIssueTokens || null
      const weakened = record.run?.weakenedGates?.length ?? 0
      return (
        <div key={record.issue} role="row" tabIndex={0} aria-selected={selected === record.issue} onClick={() => onOpen(record.issue)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(record.issue) } }}
          className={cn(COLUMNS, 'h-[46px] cursor-pointer items-center border-b border-line-ghost px-2.5 text-[13px] outline-none hover:bg-[#121821] focus-visible:bg-[#121821]', selected === record.issue && 'bg-[#16202b]')}>
          <span role="cell" className={cn('font-mono font-semibold', color)}>{record.issue}</span>
          <span role="cell" className="flex min-w-0 items-center gap-2">
            <span className="truncate">{record.title ?? '—'}</span>
            {weakened > 0 && <Badge tone="warn" title={record.run?.weakenedGates?.join(', ')}>personal override</Badge>}
          </span>
          <span role="cell" className="flex flex-col gap-1.5">
            <span className={cn('truncate font-mono text-xs', color)}>{phaseLabel(record)}</span>
            <PhaseBar record={record} height="h-1" gap="gap-[3px]" />
          </span>
          <span role="cell" className="font-mono text-xs text-ink-muted">{formatAge(phaseAgeMs(record, now))}</span>
          <span role="cell" className="truncate font-mono text-xs text-ink-muted">{modelOf(record)}</span>
          <span role="cell" className={cn('font-mono text-xs', fixRoundsAtCap(record) ? 'text-danger' : 'text-ink-muted')}>{fixRoundsLabel(record)}</span>
          <span role="cell" className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-ink-muted">{used !== undefined ? formatTokens(used) : '—'}{cap ? `/${formatTokens(cap)}` : ''}</span>
            <CapBar used={used ?? 0} cap={cap} />
          </span>
        </div>
      )
    })}
  </div>
)

export const RunsPage = (): React.ReactElement => {
  const { snapshot } = useLiveSnapshot()
  const age = useSnapshotAge()
  const panel = useIssuePanel()
  const [filter, setFilter] = React.useState<RunFilter>('all')
  const [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(0)
  const [metrics, setMetrics] = React.useState<MetricsReport | null>(null)
  const now = snapshot ? Date.parse(snapshot.generatedAt) : Date.now()
  const minute = Math.floor(now / 60_000)
  // ponytail: per-issue spend comes from the 30d metrics rollup; a run older than that shows no token count.
  React.useEffect(() => { getMetrics('30d').then(setMetrics).catch(() => setMetrics(null)) }, [minute])
  React.useEffect(() => setPage(0), [filter, query])

  const records = snapshot?.issues ?? []
  const counts = filterCounts(records)
  const rows = [...records].filter((record) => inFilter(record, filter) && matchesSearch(record, query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const shown = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <Shell bare title="Runs"
      subtitle={<span className="flex items-center gap-4">
        <span className="flex rounded-[9px] border border-line-soft bg-panel p-[3px] font-sans" role="group" aria-label="View">
          <NavLink to="/runs" end className="flex h-[30px] items-center rounded-md bg-[#1c2530] px-3.5 text-[13px] font-semibold text-ink no-underline">Table</NavLink>
          <NavLink to="/runs/trends" className="flex h-[30px] items-center rounded-md px-3.5 text-[13px] text-ink-muted no-underline hover:text-ink">Trends</NavLink>
        </span>
        <span>updated {formatAge(age)} ago</span>
      </span>}
      actions={<Button asChild className="h-[38px] px-4"><Link to="/batch" className="no-underline"><Plus className="size-4" aria-hidden />New batch</Link></Button>}>
      <div className="flex min-h-0 grow flex-col overflow-auto px-8 py-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter runs">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
              className={cn('h-8 rounded-2xl border px-3 text-[13px]', filter === id ? 'border-ink bg-ink font-semibold text-surface' : 'border-line text-[#c5ccd8] hover:border-ink-subtle')}>
              {label} <span className={cn('font-mono', filter !== id && 'text-ink-subtle')}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <label className="mt-3 flex h-9 max-w-[700px] items-center gap-2 rounded-lg border border-line-soft bg-panel-alt px-3 text-[13px] text-ink-subtle">
          <Search className="size-[15px]" aria-hidden />
          <span className="sr-only">Search runs</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search id, title, branch, PR"
            className="grow bg-transparent text-ink outline-none placeholder:text-ink-subtle" />
        </label>
        <div className="mt-3">
          {!snapshot ? <p className="text-sm text-ink-subtle">Loading…</p> : (
            <>
              <RunsTable rows={shown} tokens={tokensByIssue(metrics)} now={now} selected={panel.issue} onOpen={panel.open} />
              {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-subtle">No runs match.</p>}
              <div className="flex items-center justify-between px-2.5 py-3 text-xs text-ink-subtle">
                <span className="font-mono">{rows.length ? `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${rows.length}` : '0 of 0'}</span>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="icon" className="size-8 bg-transparent" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</Button>
                  <Button variant="outline" size="icon" className="size-8 bg-transparent" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  )
}
