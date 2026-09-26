import * as React from 'react'
import { NavLink } from 'react-router-dom'
import { AlertTriangle, Cpu, Gauge, List, Search, SlidersHorizontal, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatAge, useLiveSnapshot, useSnapshotAge } from '@/lib/snapshot'

export interface ShellProps {
  readonly title: string
  readonly subtitle?: React.ReactNode
  /** Right side of the header (primary actions, range pickers). */
  readonly actions?: React.ReactNode
  readonly error?: string | null
  readonly children: React.ReactNode
  /** Pages with their own internal layout (side panel, split view) opt out of the padded content box. */
  readonly bare?: boolean
}

const navLinkClass = ({ isActive }: { readonly isActive: boolean }): string =>
  cn('flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm text-ink-muted no-underline hover:bg-[#121821]', isActive && 'bg-raised font-medium text-ink')

const Sidebar = (): React.ReactElement => {
  const { snapshot } = useLiveSnapshot()
  const age = useSnapshotAge()
  const attention = snapshot?.extras?.attention.length ?? 0
  const running = snapshot?.capacity.running ?? 0
  const maxAgents = snapshot?.capacity.maxAgents ?? 0
  const stale = snapshot?.extras ? age !== null && age > snapshot.extras.staleAfterMs : false
  const tracker = snapshot?.extras?.freshness.find((item) => item.source === 'tracker') ?? null
  return (
    <nav aria-label="Primary" className="flex w-[232px] shrink-0 flex-col gap-7 border-r border-line-soft bg-surface-dim px-3.5 py-5">
      <div className="flex items-center gap-2.5 px-2">
        <Activity className="size-5 text-accent" aria-hidden />
        <div className="flex flex-col">
          <span className="font-mono text-sm font-semibold">ak-harness</span>
          <span className="text-xs text-ink-subtle">{snapshot ? `${snapshot.project.name} · ${snapshot.project.baseBranch}` : 'loading…'}</span>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <NavLink to="/" end className={navLinkClass}>
          <AlertTriangle className="size-[18px]" aria-hidden /><span className="grow">Attention</span>
          {attention > 0 && <span className="rounded-full bg-warning px-1.5 py-0.5 font-mono text-xs font-semibold text-[#1a1206]">{attention}</span>}
        </NavLink>
        <NavLink to="/runs" className={navLinkClass}>
          <List className="size-[18px]" aria-hidden /><span className="grow">Runs</span>
          <span className="font-mono text-xs text-ink-subtle">{running}</span>
        </NavLink>
        <NavLink to="/costs" className={navLinkClass}><Gauge className="size-[18px]" aria-hidden /><span className="grow">Costs</span></NavLink>
        <NavLink to="/system" className={navLinkClass}><Cpu className="size-[18px]" aria-hidden /><span className="grow">System</span></NavLink>
        <NavLink to="/explore" className={navLinkClass}><Search className="size-[18px]" aria-hidden /><span className="grow">Explore</span></NavLink>
        <NavLink to="/settings" className={navLinkClass}><SlidersHorizontal className="size-[18px]" aria-hidden /><span className="grow">Settings</span></NavLink>
      </div>
      <div className="mt-auto flex flex-col gap-3 border-t border-line-soft px-2.5 pt-3.5 text-xs text-ink-subtle">
        <div className="flex items-center gap-2 text-[13px] text-ink">
          <span className={cn('size-2 rounded-full', stale ? 'bg-warning' : 'pulse bg-accent')} />
          <span>{stale ? 'Stale' : 'Live'}</span>
          <span className="ml-auto font-mono text-xs text-ink-subtle">{formatAge(age)} ago</span>
        </div>
        <div className="flex justify-between"><span>Tracker sync</span><span className="font-mono">{formatAge(tracker?.ageMs ?? null)}</span></div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between"><span>Workers</span><span className="font-mono text-ink">{running} / {maxAgents}</span></div>
          <div className="flex gap-1">{Array.from({ length: Math.max(maxAgents, 1) }, (_, index) => <span key={index} className={cn('h-1.5 grow rounded-sm', index < running ? 'bg-[#2b6f95]' : 'bg-line-soft')} />)}</div>
        </div>
      </div>
    </nav>
  )
}

export const Shell = ({ title, subtitle, actions, error, children, bare = false }: ShellProps): React.ReactElement => {
  const { error: liveError } = useLiveSnapshot()
  const shown = error ?? liveError
  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Sidebar />
      <main className="flex min-w-0 grow flex-col">
        <header className="flex h-[68px] shrink-0 items-center gap-4 border-b border-line-soft px-8">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <span className="font-mono text-[13px] text-ink-subtle">{subtitle}</span>}
          {actions && <div className="ml-auto flex items-center gap-2.5">{actions}</div>}
        </header>
        {shown && <div role="alert" className="mx-8 mt-4 rounded-md border border-danger/40 bg-danger-dim px-4 py-3 text-sm text-red-200">{shown}</div>}
        {bare ? children : <div className="min-h-0 grow overflow-auto px-8 py-6">{children}</div>}
      </main>
    </div>
  )
}

export const EmptyState = ({ children }: { readonly children: React.ReactNode }): React.ReactElement => <div className="py-10 text-center text-sm text-ink-subtle">{children}</div>

export const SectionTitle = ({ children, aside }: { readonly children: React.ReactNode; readonly aside?: React.ReactNode }): React.ReactElement => (
  <div className="flex items-center gap-2.5">
    <h2 className="text-[13px] font-semibold tracking-[.06em] text-ink-muted uppercase">{children}</h2>
    {aside && <span className="ml-auto">{aside}</span>}
  </div>
)
