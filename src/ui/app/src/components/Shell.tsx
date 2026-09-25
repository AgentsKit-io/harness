import * as React from 'react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'

export interface ShellProps {
  readonly title: string
  readonly subtitle?: string
  readonly inboxCount: number
  readonly error?: string | null
  readonly children: React.ReactNode
}

const navLinkClass = ({ isActive }: { readonly isActive: boolean }): string =>
  cn('flex items-center justify-between rounded-md px-2.5 py-2 text-sm text-ink-muted hover:bg-accent-dim hover:text-ink', isActive && 'bg-accent-dim text-ink')

export const Shell = ({ title, subtitle, inboxCount, error, children }: ShellProps): React.ReactElement => (
  <div className="grid min-h-screen grid-cols-[220px_1fr]">
    <aside className="border-r border-line-soft bg-surface-dim p-5">
      <div className="mb-10 flex items-center gap-2.5 px-1 font-bold tracking-tight">
        <span className="grid size-6 place-items-center rounded-md bg-accent font-black text-ink-on-accent">A</span>
        <span>AgentsKit Harness</span>
      </div>
      <p className="mb-2 px-2 text-[10px] font-semibold tracking-widest text-ink-subtle uppercase">Workspace</p>
      <nav className="grid gap-0.5">
        <NavLink to="/" end className={navLinkClass}>Operação</NavLink>
        <NavLink to="/inbox" className={navLinkClass}>
          <span>Inbox</span>
          {inboxCount > 0 && <span className="rounded-full bg-warning-dim px-1.5 py-0.5 text-[10px] text-warning">{inboxCount}</span>}
        </NavLink>
      </nav>
    </aside>
    <main className="mx-auto w-full max-w-6xl px-10 py-8">
      <header className="mb-7 flex items-start justify-between gap-6">
        <div>
          <p className="mb-1.5 text-[10px] font-bold tracking-widest text-accent uppercase">SDLC control surface</p>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
        </div>
      </header>
      {error && <div className="mb-5 rounded-md border border-danger/40 bg-danger-dim px-4 py-3 text-sm text-red-200">{error}</div>}
      {children}
    </main>
  </div>
)

export const EmptyState = ({ children }: { readonly children: React.ReactNode }): React.ReactElement => <div className="py-10 text-center text-sm text-ink-muted">{children}</div>
