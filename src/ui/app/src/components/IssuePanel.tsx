import * as React from 'react'
import { AlertTriangle, Lock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getIssueDetail, getTimeline, type AttentionAction, type IssueDetail, type IssueRecord, type TimelineEvent } from '@/lib/api'
import { useActionRunner } from '@/lib/actions'
import { formatAge, useLiveSnapshot } from '@/lib/snapshot'
import { useIssuePanel } from '@/lib/useIssuePanel'
import { BUCKET_COLOR, SEGMENT_CLASS, ageMs, capTone, formatTokens, modelOf, phaseLabel, runBucket, segments } from '@/lib/runs'

export const PhaseBar = ({ record, height = 'h-1.5', gap = 'gap-1' }: { readonly record: IssueRecord; readonly height?: string; readonly gap?: string }): React.ReactElement => (
  <span className={cn('flex', gap)} aria-hidden>{segments(record).map((segment, index) => <span key={index} className={cn('grow rounded-sm', height, SEGMENT_CLASS[segment])} />)}</span>
)

export const CapBar = ({ used, cap, height = 'h-1' }: { readonly used: number; readonly cap: number | null | undefined; readonly height?: string }): React.ReactElement => (
  <span className={cn('flex rounded-sm bg-line-soft', height)} role="meter" aria-label="Tokens vs cap" aria-valuenow={used} aria-valuemin={0} aria-valuemax={cap || undefined}>
    <span className={cn('rounded-sm', height, capTone(used, cap))} style={{ width: cap ? `${Math.min(100, used / cap * 100)}%` : '0%' }} />
  </span>
)

const TABS = ['Evidence', 'Review', 'Worker', 'Timeline', 'Cost'] as const
type Tab = typeof TABS[number]

const CRITERION = { proven: { icon: '✔', color: 'text-success', ev: 'text-ink-subtle' }, failed: { icon: '✘', color: 'text-danger', ev: 'text-red-300' }, missing: { icon: '◌', color: 'text-warning', ev: 'text-warning' } } as const

/** Structured fields worth showing on a timeline row, in reading order; anything else stays out of the way. */
const TIMELINE_FIELDS = ['round', 'status', 'blocking', 'pr', 'head', 'provider', 'model', 'tokens', 'reason', 'error', 'detail', 'message'] as const

export const timelineFields = (event: TimelineEvent): readonly string[] =>
  TIMELINE_FIELDS.flatMap((field) => {
    const value = event[field]
    if (value === undefined || value === null || value === '') return []
    if (field === 'tokens' && typeof value === 'number') return [`tokens ${formatTokens(value)}`]
    if (field === 'pr' && typeof value === 'number') return [`PR #${value}`]
    if (field === 'head' && typeof value === 'string') return [`head ${value.slice(0, 7)}`]
    return typeof value === 'object' ? [] : [`${field} ${String(value)}`]
  })

const Meta = ({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.ReactElement => (
  <span>{label} <span className="text-ink-muted">{value}</span></span>
)

const EvidenceTab = ({ detail }: { readonly detail: IssueDetail }): React.ReactElement => (
  <>
    {detail.contract
      ? <>
          <div className="text-xs text-ink-subtle">Contract <span className="font-mono text-ink-muted">sha {detail.contract.digest.slice(0, 4)}…{detail.contract.digest.slice(-3)}</span>{detail.contract.frozenAt && <> · frozen {formatAge(ageMs(detail.contract.frozenAt, Date.now()))} ago</>}</div>
          <div className="text-[13px] text-ink-muted">{detail.contract.intent}</div>
        </>
      : <div className="text-xs text-ink-subtle">No frozen contract yet.</div>}
    <ul className="flex flex-col gap-2">
      {detail.criteria.map((criterion) => (
        <li key={criterion.id} className="flex gap-2.5 rounded-lg border border-line-soft bg-[#121820] px-3 py-2.5">
          <span className={cn('w-5 font-mono text-sm', CRITERION[criterion.status].color)} aria-label={criterion.status}>{CRITERION[criterion.status].icon}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px]">{criterion.id} {criterion.text}</span>
            <span className={cn('truncate font-mono text-[11px]', CRITERION[criterion.status].ev)}>
              {criterion.evidence ?? (criterion.status === 'missing' ? 'missing: no evidence recorded' : '—')}{criterion.source ? ` · ${criterion.source}` : ''}
            </span>
          </div>
        </li>
      ))}
      {detail.criteria.length === 0 && <li className="text-xs text-ink-subtle">No criteria recorded.</li>}
    </ul>
    <SpendBar detail={detail} />
  </>
)

const SpendBar = ({ detail }: { readonly detail: IssueDetail }): React.ReactElement => {
  const { tokens, cap } = detail.spend
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-ink-subtle">
        <span>Tokens vs cap</span>
        <span className={cn('font-mono', capTone(tokens, cap) === 'bg-accent' ? 'text-ink-muted' : capTone(tokens, cap) === 'bg-warning' ? 'text-warning' : 'text-danger')}>
          {formatTokens(tokens)} / {cap ? formatTokens(cap) : 'no cap'}{cap ? ` · ${Math.round(tokens / cap * 100)}%` : ''}
        </span>
      </div>
      <CapBar used={tokens} cap={cap} height="h-1.5" />
    </div>
  )
}

const ReviewTab = ({ detail }: { readonly detail: IssueDetail }): React.ReactElement => detail.review
  ? (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-subtle">
        <Meta label="status" value={detail.review.status} />
        <Meta label="blocking" value={<span className={detail.review.blocking > 0 ? 'text-danger' : 'text-success'}>{detail.review.blocking}</span>} />
        {detail.review.head && <Meta label="head" value={detail.review.head.slice(0, 7)} />}
        {(detail.review.provider || detail.review.model) && <Meta label="reviewer" value={[detail.review.provider, detail.review.model].filter(Boolean).join(' · ')} />}
        <Meta label="fix rounds" value={`${detail.fixRounds.used}/${detail.fixRounds.max ?? '—'}`} />
      </div>
      <ul className="flex flex-col gap-2">
        {detail.review.findings.map((finding, index) => (
          <li key={index} className="flex flex-col gap-1 rounded-lg border border-line-soft bg-[#121820] px-3 py-2.5 text-[13px]">
            <span className="font-mono text-[11px] text-ink-subtle"><span className={finding.severity === 'blocking' || finding.severity === 'high' ? 'text-danger' : 'text-warning'}>{finding.severity}</span>{finding.file ? ` · ${finding.file}` : ''}</span>
            <span>{finding.text}</span>
          </li>
        ))}
        {detail.review.findings.length === 0 && <li className="text-xs text-ink-subtle">No findings.</li>}
      </ul>
    </>
  )
  : <div className="text-xs text-ink-subtle">No review recorded yet.</div>

const WorkerTab = ({ detail }: { readonly detail: IssueDetail }): React.ReactElement => detail.worker
  ? (
    <>
      <div className="flex gap-4 font-mono text-xs text-ink-subtle">
        <Meta label="terminal" value={detail.worker.terminal ?? '—'} />
        <Meta label="last output" value={detail.worker.lastOutputAt ? `${formatAge(ageMs(detail.worker.lastOutputAt, Date.now()))} ago` : '—'} />
      </div>
      <pre className="min-h-0 grow overflow-auto rounded-lg border border-line-soft bg-surface p-3 font-mono text-[11px] whitespace-pre-wrap text-ink-muted">{detail.worker.preview ?? 'No output captured.'}</pre>
    </>
  )
  : <div className="text-xs text-ink-subtle">No live worker for this issue.</div>

const TimelineTab = ({ issue, version }: { readonly issue: string; readonly version: string }): React.ReactElement => {
  const [events, setEvents] = React.useState<readonly TimelineEvent[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    getTimeline(issue).then((value) => { if (!cancelled) setEvents(value.events) }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [issue, version])
  if (error) return <div role="alert" className="text-xs text-red-300">{error}</div>
  if (!events) return <div className="text-xs text-ink-subtle">Loading…</div>
  return (
    <ol className="flex flex-col gap-1 font-mono text-xs">
      {[...events].reverse().map((event, index) => (
        <li key={`${event.at}:${index}`} className="flex flex-col gap-0.5 rounded-md bg-panel-alt px-3 py-2">
          <span className="flex gap-2.5"><span className="text-ink-subtle">{new Date(event.at).toLocaleString()}</span><span className="text-accent-strong">{event.type}</span></span>
          {timelineFields(event).length > 0 && <span className="text-ink-muted">{timelineFields(event).join(' · ')}</span>}
        </li>
      ))}
      {events.length === 0 && <li className="text-ink-subtle">No events.</li>}
    </ol>
  )
}

const CostTab = ({ detail }: { readonly detail: IssueDetail }): React.ReactElement => (
  <>
    <SpendBar detail={detail} />
    <div className="flex gap-4 font-mono text-xs text-ink-subtle">
      <Meta label="calls" value={detail.spend.calls} />
      <Meta label="per call" value={detail.spend.calls ? formatTokens(detail.spend.tokens / detail.spend.calls) : '—'} />
    </div>
  </>
)

export const StatusBox = ({ record, detail, locked, onAction, busy }: {
  readonly record: IssueRecord
  readonly detail: IssueDetail | null
  readonly locked: string | null
  readonly onAction: (action: AttentionAction) => void
  readonly busy: string | null
}): React.ReactElement => {
  const next = detail?.nextStep ?? null
  const stopped = next !== null
  return (
    <div className={cn('flex flex-col gap-2.5 rounded-xl border px-3.5 py-3', stopped ? 'border-[#4a2227] bg-[#1f1416]' : 'border-line-soft bg-panel')}>
      <div className="flex items-center gap-2 text-[13px]">
        {stopped && <AlertTriangle className="size-4 text-danger" aria-hidden />}
        <span className={cn('font-semibold', stopped ? 'text-red-200' : BUCKET_COLOR[runBucket(record)])}>{phaseLabel(record)}</span>
        <span className="ml-auto font-mono text-xs text-ink-subtle">{formatAge(ageMs(record.phaseSince ?? record.updatedAt, Date.now()))} ago</span>
      </div>
      {next && <div className="text-[13px] text-[#e8c4c4]">{next.reason}{next.detail && <span className="mt-1 block font-mono text-[11px] text-ink-subtle">{next.detail}</span>}</div>}
      {!next && record.error && <div className="text-[13px] text-ink-muted">{record.error}</div>}
      {next && next.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {next.actions.map((action) => {
            const lockedOut = action.destructive && locked !== null
            return (
              <Button key={action.id} size="sm" variant={action.destructive ? 'destructive-outline' : action.primary ? 'primary' : 'outline'}
                disabled={lockedOut || busy === `${action.id}:${record.issue}`} title={lockedOut ? locked : undefined} onClick={() => onAction(action)}>
                {lockedOut ? 'Reconcile first' : action.label}
              </Button>
            )
          })}
        </div>
      )}
      {locked && <div className="flex items-center gap-1.5 text-xs text-drift"><Lock className="size-3.5" aria-hidden />{locked}</div>}
    </div>
  )
}

const prLink = (repo: string, number: number): string | null => /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pull/${number}` : null

/** Issue side panel driven by `?issue=`; render it once per page. */
export const IssuePanel = (): React.ReactElement | null => {
  const panel = useIssuePanel()
  const { snapshot } = useLiveSnapshot()
  const actions = useActionRunner()
  const [tab, setTab] = React.useState<Tab>('Evidence')
  const [detail, setDetail] = React.useState<IssueDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const record = panel.issue ? snapshot?.issues.find((candidate) => candidate.issue === panel.issue) ?? null : null
  const version = record?.updatedAt ?? ''
  const { close } = panel

  React.useEffect(() => {
    if (!panel.issue) return
    let cancelled = false
    setError(null)
    getIssueDetail(panel.issue).then((value) => { if (!cancelled) setDetail(value) }).catch((cause: unknown) => { if (!cancelled) { setDetail(null); setError(cause instanceof Error ? cause.message : String(cause)) } })
    return () => { cancelled = true }
  }, [panel.issue, version])
  React.useEffect(() => { setTab('Evidence'); setDetail(null) }, [panel.issue])
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  if (!panel.issue) return null
  const issue = panel.issue
  const locked = snapshot?.extras?.locks[issue] ?? null
  const pr = record?.pullRequest ? prLink(snapshot?.project.repo ?? '', record.pullRequest.number) : null

  return (
    <aside aria-label="Run detail" className="fixed top-0 right-0 z-40 flex h-screen w-[470px] flex-col border-l border-[#243040] bg-[#0f141b] shadow-[-24px_0_48px_rgba(0,0,0,.45)]">
      <div className="flex flex-col gap-3 border-b border-line-soft px-6 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <span className={cn('font-mono text-sm font-semibold', record ? BUCKET_COLOR[runBucket(record)] : 'text-ink')}>{issue}</span>
          {record?.url && <a href={record.url} target="_blank" rel="noreferrer" className="text-xs text-accent-strong no-underline">tracker ↗</a>}
          {record?.pullRequest && (pr
            ? <a href={pr} target="_blank" rel="noreferrer" className="text-xs text-accent-strong no-underline">PR #{record.pullRequest.number} ↗</a>
            : <span className="text-xs text-ink-subtle">PR #{record.pullRequest.number}</span>)}
          <Button variant="outline" size="icon" className="ml-auto size-8" aria-label="Close detail" onClick={panel.close}><X className="size-4" aria-hidden /></Button>
        </div>
        <h2 className="text-lg font-semibold">{record?.title ?? issue}</h2>
        {record && <StatusBox record={record} detail={detail} locked={locked} busy={actions.busy}
          onAction={(action) => actions.run(action, { issue, head: record.pullRequest?.head ?? null, lockReason: locked })} />}
        {record && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-xs text-ink-subtle">
            <Meta label="builder" value={record.run?.builder ?? modelOf(record)} />
            <Meta label="flow" value={record.run ? record.run.flow ?? 'default' : '—'} />
            <Meta label="branch" value={record.dispatch?.branch ?? '—'} />
            <Meta label="attempt" value={record.run?.attempt ?? '—'} />
          </div>
        )}
        {!record && snapshot && <div className="text-xs text-ink-subtle">This issue is not in the loop's current snapshot.</div>}
        {(error ?? actions.error) && <div role="alert" className="rounded-md border border-danger/40 bg-danger-dim px-3 py-2 text-xs text-red-200">{error ?? actions.error}</div>}
      </div>
      <div role="tablist" aria-label="Run detail sections" className="flex gap-1 border-b border-line-soft px-4">
        {TABS.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}
            className={cn('h-[42px] border-b-2 px-2.5 text-[13px] font-medium', tab === name ? 'border-accent text-ink' : 'border-transparent text-ink-subtle hover:text-ink')}>{name}</button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab} className="flex min-h-0 grow flex-col gap-3.5 overflow-auto px-6 py-4">
        {tab === 'Timeline'
          ? <TimelineTab issue={issue} version={version} />
          : !detail
            ? <div className="text-xs text-ink-subtle">{error ? 'Detail unavailable.' : 'Loading…'}</div>
            : tab === 'Evidence' ? <EvidenceTab detail={detail} />
              : tab === 'Review' ? <ReviewTab detail={detail} />
                : tab === 'Worker' ? <WorkerTab detail={detail} />
                  : <CostTab detail={detail} />}
      </div>
      {actions.dialog}
    </aside>
  )
}
