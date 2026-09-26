import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { EmptyState, Shell } from '@/components/Shell'
import { Loading, useFetched } from '@/components/Insights'
import { useConfirm } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  getJob, getSystem, pauseStage, promoteLearnings, reinstallAutomations, rejectLearnings, resumeStage, runDoctor, runStage,
  type CheckStatus, type SystemReport, type UiJobRecord,
} from '@/lib/api'
import { formatAgo, formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

const POLL_MS = 1_000
const ACTIVE_JOB = new Set<UiJobRecord['status']>(['running', 'cancel-pending'])

const CHECK_ICON: Readonly<Record<CheckStatus, { readonly glyph: string; readonly className: string; readonly label: string }>> = {
  pass: { glyph: '✔', className: 'text-success', label: 'pass' },
  warn: { glyph: '!', className: 'text-warning', label: 'warning' },
  fail: { glyph: '✖', className: 'text-danger', label: 'fail' },
}

const Card = ({ title, aside, children }: { readonly title: string; readonly aside?: React.ReactNode; readonly children: React.ReactNode }): React.ReactElement => (
  <section aria-label={title} className="flex min-h-0 min-w-0 flex-col gap-2.5 overflow-auto rounded-xl border border-line-soft bg-panel px-[18px] py-4">
    <div className="flex items-center gap-2.5">
      <h2 className="text-[13px] font-semibold tracking-[.06em] text-ink-muted uppercase">{title}</h2>
      {aside && <span className="ml-auto font-mono text-xs text-ink-subtle">{aside}</span>}
    </div>
    {children}
  </section>
)

const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** Starts a job and polls it to a terminal status; one at a time. */
const useJobRunner = (onDone: () => void): { readonly job: { readonly label: string; readonly record: UiJobRecord } | null; readonly start: (label: string, run: () => Promise<{ readonly job: UiJobRecord }>) => void; readonly error: string | null } => {
  const [job, setJob] = React.useState<{ readonly label: string; readonly record: UiJobRecord } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const done = React.useRef(onDone)
  done.current = onDone
  React.useEffect(() => {
    if (!job || !ACTIVE_JOB.has(job.record.status)) return
    const timer = setTimeout(() => {
      getJob(job.record.id).then(({ job: record }) => {
        setJob({ label: job.label, record })
        if (!ACTIVE_JOB.has(record.status)) done.current()
      }).catch((cause: unknown) => setError(errorText(cause)))
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [job])
  const start = (label: string, run: () => Promise<{ readonly job: UiJobRecord }>): void => {
    setError(null)
    run().then(({ job: record }) => { setJob({ label, record }); if (!ACTIVE_JOB.has(record.status)) done.current() }).catch((cause: unknown) => setError(errorText(cause)))
  }
  return { job, start, error }
}

const JobStrip = ({ label, record }: { readonly label: string; readonly record: UiJobRecord }): React.ReactElement => {
  const active = ACTIVE_JOB.has(record.status)
  const last = record.events.at(-1)
  return (
    <div role="status" className={cn('mx-8 mt-4 flex items-center gap-3 rounded-md border px-4 py-2.5 text-[13px]',
      active ? 'border-line bg-panel' : record.status === 'succeeded' ? 'border-success/40 bg-success-dim' : 'border-danger/40 bg-danger-dim')}>
      {active && <Loader2 className="size-4 animate-spin text-accent motion-reduce:animate-none" aria-hidden />}
      <span className="font-semibold">{label}</span>
      <span className="font-mono text-xs text-ink-muted">{record.status}{record.phase ? ` · ${record.phase}` : ''}</span>
      <span className="min-w-0 truncate text-xs text-ink-subtle">{record.error?.message ?? last?.detail ?? ''}</span>
    </div>
  )
}

type Stage = SystemReport['stages'][number]

const stageState = (stage: Stage): { readonly text: string; readonly className: string } => {
  if (!stage.installed) return { text: 'not installed', className: 'text-danger' }
  if (stage.drift.length) return { text: `drift: ${stage.drift.join(', ')}`, className: 'text-warning' }
  if (stage.paused) return { text: `paused${stage.pausedReason ? ` · ${stage.pausedReason}` : ''}`, className: 'text-ink-muted' }
  return { text: 'running', className: 'text-success' }
}

const StageRow = ({ stage, onPause, onResume, onReinstall }: {
  readonly stage: Stage
  readonly onPause: (reason: string) => Promise<unknown>
  readonly onResume: () => void
  readonly onReinstall: () => void
}): React.ReactElement => {
  const [asking, setAsking] = React.useState(false)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const state = stageState(stage)
  const needsReinstall = !stage.installed || stage.drift.length > 0
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    onPause(reason.trim()).then(() => { setAsking(false); setReason('') }).finally(() => setBusy(false))
  }
  return (
    <div className="border-b border-line-ghost">
      <div className="grid h-[38px] grid-cols-[90px_100px_130px_minmax(0,1fr)_88px] items-center gap-2.5 text-[13px]">
        <span className="font-mono">{stage.stage}</span>
        <span className="truncate font-mono text-xs text-ink-subtle">{stage.schedule ?? '—'}</span>
        <span className="truncate font-mono text-xs text-ink-subtle">{stage.lastRunAt ? `${formatAgo(stage.lastRunAt)}${stage.lastStatus ? ` · ${stage.lastStatus}` : ''}` : '—'}</span>
        <span className={cn('truncate text-xs', state.className)} title={state.text}>{state.text}</span>
        {needsReinstall ? <Button size="sm" variant="outline" onClick={onReinstall}>Reinstall</Button>
          : stage.paused ? <Button size="sm" variant="outline" onClick={onResume}>Resume</Button>
            : <Button size="sm" variant="outline" aria-expanded={asking} onClick={() => setAsking((value) => !value)}>Pause</Button>}
      </div>
      {asking && (
        <form onSubmit={submit} className="flex items-center gap-2 pb-2.5">
          <label className="sr-only" htmlFor={`pause-${stage.stage}`}>Reason for pausing {stage.stage}</label>
          <input id={`pause-${stage.stage}`} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus placeholder={`Why pause ${stage.stage}?`}
            className="h-8 grow rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-accent" />
          <Button size="sm" variant="ghost" type="button" onClick={() => setAsking(false)}>Cancel</Button>
          <Button size="sm" variant="primary" type="submit" disabled={busy || reason.trim().length === 0}>Pause {stage.stage}</Button>
        </form>
      )}
    </div>
  )
}

const SystemGrid = ({ report, reload, setError }: { readonly report: SystemReport; readonly reload: () => void; readonly setError: (error: string | null) => void }): React.ReactElement => {
  const { ask, dialog } = useConfirm()
  const act = (run: () => Promise<unknown>): Promise<unknown> => run().then(() => { setError(null); reload() }).catch((cause: unknown) => setError(errorText(cause)))
  const checks = report.doctor?.checks ?? []
  const passing = checks.filter((check) => check.status === 'pass').length
  const proposed = report.learnings.filter((learning) => learning.status === 'proposed')
  const promoted = report.learnings.filter((learning) => learning.status === 'promoted').length
  const { machine } = report
  const reinstall = (): void => ask({
    title: 'Reinstall loop automations',
    effects: ['Rewrite every stage automation from the current loop config', 'Clear the drift between installed schedules and the config', 'Paused stages stay paused'],
    basis: [], confirmLabel: 'Reinstall', tone: 'normal',
    onConfirm: () => reinstallAutomations().then(reload),
  })
  const promote = (learning: SystemReport['learnings'][number]): void => ask({
    title: 'Promote learning',
    effects: [`Add “${learning.text}” to the promoted learnings`, 'Every run queued from now on reads it as project guidance'],
    basis: [{ label: 'sightings', value: `${learning.sightings}× · from ${learning.source}`, ageMs: 0, stale: false }],
    confirmLabel: 'Promote', tone: 'gate',
    onConfirm: () => promoteLearnings([learning.id]).then(reload),
  })

  return (
    <div className="grid min-h-full grid-cols-2 grid-rows-[minmax(300px,1fr)_minmax(300px,1fr)] gap-[18px]">
      {dialog}
      <Card title="Health · doctor" aside={report.doctor ? `ran ${formatAgo(report.doctor.ranAt)} · ${passing}/${checks.length} pass` : 'never ran'}>
        <div className="grid grid-cols-3 gap-2.5 font-mono">
          <div className="flex flex-col gap-1 rounded-lg bg-panel-alt p-2.5"><span className="text-[11px] text-ink-subtle">Load</span><span className="text-lg">{machine.loadPercent === null ? '—' : `${Math.round(machine.loadPercent)}%`}</span></div>
          <div className="flex flex-col gap-1 rounded-lg bg-panel-alt p-2.5"><span className="text-[11px] text-ink-subtle">RAM free</span><span className="text-lg">{machine.freeRamGb === null ? '—' : `${machine.freeRamGb.toFixed(1)}G`}</span></div>
          <div className="flex flex-col gap-1 rounded-lg bg-panel-alt p-2.5"><span className="text-[11px] text-ink-subtle">Terminals live</span><span className="text-lg">{machine.liveTerminals ?? '—'} / {machine.slots}</span></div>
        </div>
        {report.doctor === null ? <EmptyState>Doctor has not run yet. Use Run doctor above.</EmptyState> : (
          <ul className="flex flex-col text-[13px]">
            {checks.map((check) => {
              const icon = CHECK_ICON[check.status]
              return (
                <li key={check.name} className="flex min-h-[30px] items-center gap-2.5">
                  <span className={cn('w-4 font-mono', icon.className)} aria-label={icon.label} role="img">{icon.glyph}</span>
                  <span className="grow text-ink-muted">{check.name}</span>
                  <span className={cn('max-w-[55%] truncate font-mono text-xs', check.status === 'pass' ? 'text-ink-subtle' : icon.className)} title={check.detail}>{check.detail}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Providers · routing">
        <div className="flex flex-col text-[13px]" role="table" aria-label="Model routing">
          <div role="row" className="grid grid-cols-[100px_170px_minmax(0,1fr)] gap-2.5 border-b border-line-soft pb-1.5 font-mono text-[11px] tracking-[.06em] text-ink-subtle uppercase">
            <span role="columnheader">Role</span><span role="columnheader">Model</span><span role="columnheader">Why</span>
          </div>
          {report.routing.length === 0 && <EmptyState>No routing decisions yet.</EmptyState>}
          {report.routing.map((route) => (
            <div role="row" key={route.role} className="grid h-[34px] grid-cols-[100px_170px_minmax(0,1fr)] items-center gap-2.5 border-b border-line-ghost">
              <span role="cell" className="text-ink-muted">{route.role}</span>
              <span role="cell" className="truncate font-mono text-xs text-accent-strong">{route.model ?? '—'}</span>
              <span role="cell" className="truncate text-xs text-ink-subtle" title={route.reason}>{route.reason}</span>
            </div>
          ))}
        </div>
        {report.cooldowns.map((cooldown) => (
          <div key={cooldown.provider} className="flex items-center gap-2.5 rounded-lg bg-panel-alt px-3 py-2.5 text-xs">
            <span className="size-2 rounded-full bg-danger" aria-hidden />
            <span className="text-ink-muted">{cooldown.provider} in cooldown until <span className="font-mono">{formatClock(cooldown.until)}</span> ({cooldown.reason})</span>
          </div>
        ))}
        <span className="mt-auto text-xs text-ink-subtle">{report.handoffs} provider handoff{report.handoffs === 1 ? '' : 's'} recorded{report.cooldowns.length === 0 ? ' · no provider in cooldown' : ''}</span>
      </Card>

      <Card title="Automations · stages">
        <div className="flex flex-col">
          {report.stages.length === 0 && <EmptyState>No stage automations found.</EmptyState>}
          {report.stages.map((stage) => (
            <StageRow key={stage.stage} stage={stage} onReinstall={reinstall}
              onPause={(reason) => act(() => pauseStage(stage.stage, reason))}
              onResume={() => { void act(() => resumeStage(stage.stage)) }} />
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2.5 text-xs text-ink-subtle">
          <span>Alerts webhook</span>
          <span className={cn('font-mono', report.alerts.configured ? 'text-ink-muted' : 'text-warning')}>{report.alerts.configured ? 'configured' : 'not configured'}</span>
          {report.alerts.lastDelivery && (
            <span className={cn('ml-auto', report.alerts.lastDelivery.status === 'error' || report.alerts.lastDelivery.status >= 400 ? 'text-danger' : 'text-success')}>
              last delivery {report.alerts.lastDelivery.status} · {formatClock(report.alerts.lastDelivery.at)}
            </span>
          )}
        </div>
      </Card>

      <Card title="Learnings · retro" aside={`${proposed.length} proposed · ${promoted} promoted`}>
        {proposed.length === 0 && <EmptyState>No learnings waiting for a decision.</EmptyState>}
        {proposed.map((learning) => (
          <div key={learning.id} className="flex flex-col gap-2 rounded-lg bg-panel-alt px-3 py-2.5">
            <div className="flex gap-2 text-xs text-ink-subtle"><span className="font-mono text-drift">{learning.category}</span><span>seen {learning.sightings}×</span><span className="ml-auto">from {learning.source}</span></div>
            <span className="text-[13px]">{learning.text}</span>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { void act(() => rejectLearnings([learning.id])) }}>Reject</Button>
              <Button size="sm" variant="primary" onClick={() => promote(learning)}>Promote</Button>
            </div>
          </div>
        ))}
        {report.retroSuggestions.map((suggestion) => (
          <div key={suggestion.text} className="flex gap-2.5 rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-ink-muted">
            <span className="font-mono text-warning">retro</span>
            <span>{suggestion.text}{suggestion.knob && <> · <span className="font-mono">{suggestion.knob}</span></>}</span>
            <span className="ml-auto shrink-0 text-ink-subtle">{suggestion.target}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

export const SystemPage = (): React.ReactElement => {
  const { data, error, loading, reload } = useFetched(getSystem, [])
  const [actionError, setActionError] = React.useState<string | null>(null)
  const runner = useJobRunner(reload)
  const busy = runner.job !== null && ACTIVE_JOB.has(runner.job.record.status)
  return (
    <Shell title="System" error={actionError ?? runner.error ?? error} bare
      actions={<>
        <Button variant="outline" disabled={busy} onClick={() => runner.start('Doctor', runDoctor)}>Run doctor</Button>
        <Button variant="outline" disabled={busy} onClick={() => runner.start('Tick', () => runStage('tick'))}>Run tick now</Button>
        <Button variant="outline" disabled={busy} onClick={() => runner.start('Deliver', () => runStage('deliver'))}>Run deliver now</Button>
      </>}>
      {runner.job && <JobStrip label={runner.job.label} record={runner.job.record} />}
      <div className="min-h-0 grow overflow-auto px-8 py-[22px]">
        {data ? <SystemGrid report={data} reload={reload} setError={setActionError} /> : loading ? <Loading /> : <EmptyState>System report unavailable.</EmptyState>}
      </div>
    </Shell>
  )
}
