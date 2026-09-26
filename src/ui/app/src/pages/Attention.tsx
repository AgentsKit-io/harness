import * as React from 'react'
import { Link } from 'react-router-dom'
import { Lock, Plus } from 'lucide-react'
import { Shell, SectionTitle } from '@/components/Shell'
import { Button } from '@/components/ui/button'
import { Sparkline } from '@/components/Sparkline'
import { CapBar, IssuePanel, PhaseBar } from '@/components/IssuePanel'
import { cn } from '@/lib/utils'
import { answerDecision, getMetrics, type AttentionAction, type AttentionGroup, type AttentionItem, type IssueRecord, type MetricsReport, type UiSnapshot } from '@/lib/api'
import { useActionRunner, type ActionTarget } from '@/lib/actions'
import { formatAge, useLiveSnapshot } from '@/lib/snapshot'
import { useIssuePanel } from '@/lib/useIssuePanel'
import { BUCKET_COLOR, ageMs, formatTokens, modelOf, phaseLabel, recentChanges, runBucket, tokensByIssue } from '@/lib/runs'

export const GROUPS: readonly { readonly group: AttentionGroup; readonly name: string; readonly color: string; readonly dot: string }[] = [
  { group: 'human', name: 'Human decisions', color: 'text-warning', dot: 'bg-warning' },
  { group: 'failed', name: 'Stuck or failed', color: 'text-danger', dot: 'bg-danger' },
  { group: 'drift', name: 'Out of sync', color: 'text-drift', dot: 'bg-drift' },
  { group: 'system', name: 'System', color: 'text-system', dot: 'bg-system' },
]

export const targetOf = (item: AttentionItem): ActionTarget => ({
  issue: item.issue,
  head: item.head ?? null,
  stage: item.stage ?? null,
  // ponytail: AttentionItem carries no plan id; plan/design gates are assumed to use `issue`, else the id suffix.
  planId: item.issue ?? item.id.slice(item.id.indexOf(':') + 1),
  lockReason: item.locked ? item.lockReason ?? 'Out of sync' : null,
})

export interface AttentionCardProps {
  readonly item: AttentionItem
  readonly color: string
  readonly now: number
  readonly busy: string | null
  readonly onAction: (item: AttentionItem, action: AttentionAction) => void
  readonly onAnswer: (item: AttentionItem, optionId: string) => void
}

export const AttentionCard = ({ item, color, now, busy, onAction, onAnswer }: AttentionCardProps): React.ReactElement => {
  const decision = item.decision
  return (
    <article aria-label={`${item.issue ?? item.stage ?? item.kind}: ${item.title}`} className="flex flex-col gap-2.5 rounded-[10px] border border-line-soft bg-panel px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className={cn('font-mono text-[13px] font-semibold', color)}>{item.issue ?? item.stage ?? item.kind}</span>
        <span className="grow truncate text-sm font-medium">{item.title}</span>
        <span className="font-mono text-xs text-ink-subtle">{formatAge(ageMs(item.since, now))}</span>
      </div>
      <div className="text-[13px] text-ink-muted">{item.reason}</div>
      {decision && decision.options.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
          {decision.options.map((option) => {
            const recommended = option.id === decision.recommendedOptionId
            return (
              <button key={option.id} type="button" title={option.description || undefined} disabled={busy === `answer:${item.id}`}
                onClick={() => onAnswer(item, option.id)}
                className={cn('h-8 rounded-md border bg-surface px-3 text-[13px] hover:brightness-125 disabled:opacity-50', recommended ? 'border-warning' : 'border-line')}>
                {option.title}{recommended && ' (recommended)'}
              </button>
            )
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        {item.locked && <span className="flex items-center gap-1.5 text-xs text-drift"><Lock className="size-3.5" aria-hidden />{item.lockReason ?? 'Cancel, close and reopen locked until reconciled'}</span>}
        <div className="ml-auto flex gap-2">
          {item.actions.filter((action) => !(action.id === 'answer' && decision?.options.length)).map((action) => {
            const lockedOut = item.locked && action.destructive
            return (
              <Button key={action.id} variant={action.primary ? 'primary' : action.destructive ? 'destructive-outline' : 'outline'}
                className={action.primary ? undefined : 'bg-transparent'} disabled={lockedOut || busy === `${action.id}:${item.issue ?? ''}`}
                title={lockedOut ? 'Reconcile first' : undefined} onClick={() => onAction(item, action)}>
                {action.label}
              </Button>
            )
          })}
        </div>
      </div>
    </article>
  )
}

export const AttentionQueue = ({ items, now, busy, onAction, onAnswer }: Omit<AttentionCardProps, 'item' | 'color'> & { readonly items: readonly AttentionItem[] }): React.ReactElement => (
  <>
    {GROUPS.map(({ group, name, color, dot }) => {
      const inGroup = items.filter((item) => item.group === group)
      if (inGroup.length === 0) return null
      return (
        <div key={group} className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className={cn('size-2.5 rounded-[3px]', dot)} />
            <h2 className="text-[13px] font-semibold tracking-[.06em] text-[#c5ccd8] uppercase">{name}</h2>
            <span className="font-mono text-xs text-ink-subtle">{inGroup.length}</span>
          </div>
          {inGroup.map((item) => <AttentionCard key={item.id} item={item} color={color} now={now} busy={busy} onAction={onAction} onAnswer={onAnswer} />)}
        </div>
      )
    })}
  </>
)

const SPARKS = [
  { key: 'merged', label: 'Merged · 24h', color: 'text-success' },
  { key: 'failed', label: 'Failures · 24h', color: 'text-danger' },
  { key: 'tokens', label: 'Tokens · 24h', color: 'text-accent' },
] as const

const SparkCards = ({ metrics }: { readonly metrics: MetricsReport | null }): React.ReactElement => (
  <div className="grid grid-cols-3 gap-2.5">
    {SPARKS.map(({ key, label, color }) => {
      const values = metrics?.sparks[key] ?? []
      const total = values.reduce((sum, value) => sum + value, 0)
      return (
        <div key={key} className="flex flex-col gap-1 rounded-[10px] border border-line-soft bg-panel px-3 py-2.5">
          <span className="text-[11px] text-ink-subtle">{label}</span>
          <span className={cn('font-mono text-lg font-semibold', color)}>{metrics ? (key === 'tokens' ? formatTokens(total) : total) : '—'}</span>
          <Sparkline values={values.length ? values : [0, 0]} className={color} />
          <span className="font-mono text-[11px] text-ink-subtle">
            {key === 'tokens' && metrics?.tokens.cacheHitRate != null ? `${Math.round(metrics.tokens.cacheHitRate * 100)}% cache hits` : 'last 24h'}
          </span>
        </div>
      )
    })}
  </div>
)

export const WorkerCard = ({ record, tokens, now, onOpen }: { readonly record: IssueRecord; readonly tokens: number | undefined; readonly now: number; readonly onOpen: () => void }): React.ReactElement => {
  const cap = record.run?.perIssueTokens || null
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded-[10px] border border-line-soft bg-panel px-3.5 py-3 text-left hover:border-line">
      <span className="flex w-full items-center gap-2.5">
        <span className="pulse size-2 rounded-full bg-accent" aria-hidden />
        <span className="font-mono text-[13px] font-semibold text-accent-strong">{record.issue}</span>
        <span className="grow truncate text-[13px]">{record.title ?? ''}</span>
      </span>
      <span className="w-full"><PhaseBar record={record} /></span>
      <span className="flex w-full gap-3 font-mono text-xs text-ink-subtle">
        <span className="text-[#c5ccd8]">{phaseLabel(record)}</span>
        <span>{formatAge(ageMs(record.updatedAt, now))}</span>
        <span>{modelOf(record)}</span>
        <span className="ml-auto">{tokens !== undefined ? formatTokens(tokens) : '—'}{cap ? ` / ${formatTokens(cap)}` : ''}</span>
      </span>
      {cap && tokens !== undefined && <span className="w-full"><CapBar used={tokens} cap={cap} /></span>}
    </button>
  )
}

const LiveColumn = ({ snapshot, metrics, now, onOpen }: { readonly snapshot: UiSnapshot; readonly metrics: MetricsReport | null; readonly now: number; readonly onOpen: (issue: string) => void }): React.ReactElement => {
  const tokens = tokensByIssue(metrics)
  const running = snapshot.issues.filter((record) => { const bucket = runBucket(record); return bucket === 'running' || bucket === 'review' })
  const queued = snapshot.issues.filter((record) => runBucket(record) === 'queued')
  const feed = recentChanges(snapshot)
  return (
    <aside aria-label="Live overview" className="flex w-[400px] shrink-0 flex-col gap-4 overflow-auto">
      <SparkCards metrics={metrics} />
      <div className="flex flex-col gap-2.5">
        <SectionTitle aside={<Link to="/runs" className="text-[13px] text-accent-strong no-underline">All runs</Link>}>Running now</SectionTitle>
        {running.map((record) => <WorkerCard key={record.issue} record={record} tokens={tokens.get(record.issue)} now={now} onOpen={() => onOpen(record.issue)} />)}
        {running.length === 0 && <div className="rounded-[10px] border border-line-soft bg-panel px-3.5 py-3 text-[13px] text-ink-subtle">No workers running.</div>}
      </div>
      <div className="flex items-center gap-3.5 rounded-[10px] border border-line-soft bg-panel px-3.5 py-3">
        <div className="flex flex-col"><span className="font-mono text-[26px] font-semibold">{queued.length}</span><span className="text-xs text-ink-subtle">queued</span></div>
        <div className="flex min-w-0 flex-col gap-0.5 text-xs text-ink-subtle">
          <span>Next up</span>
          <span className="truncate font-mono text-[#c5ccd8]">{queued.slice(0, 3).map((record) => record.issue).join(' · ') || '—'}</span>
        </div>
        <span className="ml-auto shrink-0 text-xs text-ink-subtle">{snapshot.capacity.free} {snapshot.capacity.free === 1 ? 'slot' : 'slots'} free</span>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        <SectionTitle>Event stream</SectionTitle>
        <ol aria-label="Recent changes" className="flex flex-col gap-px overflow-hidden rounded-[10px] border border-line-soft font-mono text-xs">
          {feed.map((row, index) => (
            <li key={row.key} className={cn('flex gap-2.5 bg-panel-alt px-3 py-2', index === 0 && 'tick-in')}>
              <span className="text-ink-subtle">{new Date(row.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className={cn('w-[130px] shrink-0 truncate', BUCKET_COLOR[row.bucket])}>{row.label}</span>
              <button type="button" className="truncate text-left text-[#c5ccd8] hover:text-ink" onClick={() => onOpen(row.issue)}>{row.text}</button>
            </li>
          ))}
          {feed.length === 0 && <li className="bg-panel-alt px-3 py-2 text-ink-subtle">No activity yet.</li>}
        </ol>
      </div>
    </aside>
  )
}

export const AttentionPage = (): React.ReactElement => {
  const { snapshot, refresh } = useLiveSnapshot()
  const panel = useIssuePanel()
  const actions = useActionRunner()
  const [metrics, setMetrics] = React.useState<MetricsReport | null>(null)
  const [answering, setAnswering] = React.useState<string | null>(null)
  const [answerError, setAnswerError] = React.useState<string | null>(null)
  const now = snapshot ? Date.parse(snapshot.generatedAt) : Date.now()

  // Metrics are a rollup, not live state: refresh them when the snapshot moves, at most once a minute.
  const minute = Math.floor(now / 60_000)
  React.useEffect(() => { getMetrics('24h').then(setMetrics).catch(() => setMetrics(null)) }, [minute])

  const items = snapshot?.extras?.attention ?? []
  const oldest = items.reduce<number | null>((max, item) => Math.max(max ?? 0, ageMs(item.since, now) ?? 0), null)
  const running = snapshot?.issues.filter((record) => runBucket(record) === 'running' || runBucket(record) === 'review').length ?? 0

  const onAnswer = (item: AttentionItem, optionId: string): void => {
    const decision = item.decision
    if (!decision) return
    setAnswering(`answer:${item.id}`); setAnswerError(null)
    answerDecision(decision.issue, decision.id, { optionId, expectedDigest: decision.digest })
      .then(refresh).catch((cause: unknown) => setAnswerError(cause instanceof Error ? cause.message : String(cause))).finally(() => setAnswering(null))
  }

  return (
    <Shell bare title="Needs you" error={actions.error ?? answerError}
      subtitle={snapshot?.extras ? `${items.length} ${items.length === 1 ? 'item' : 'items'}${oldest !== null ? ` · oldest ${formatAge(oldest)}` : ''}` : undefined}
      actions={<Button asChild className="h-[38px] px-4"><Link to="/batch" className="no-underline"><Plus className="size-4" aria-hidden />New batch</Link></Button>}>
      <div className="flex min-h-0 grow gap-6 px-8 py-6">
        <section aria-label="Attention queue" className="flex min-w-0 grow flex-col gap-[22px] overflow-auto">
          {!snapshot && <p className="text-sm text-ink-subtle">Loading…</p>}
          {snapshot && !snapshot.extras && <p className="text-sm text-ink-subtle">This server does not report an attention queue. Upgrade the harness to see what needs you.</p>}
          {snapshot?.extras && items.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <span className="text-lg font-semibold">Nothing needs you</span>
              <span className="text-sm text-ink-subtle">{running} running · {snapshot.capacity.free} free {snapshot.capacity.free === 1 ? 'slot' : 'slots'}</span>
            </div>
          )}
          <AttentionQueue items={items} now={now} busy={answering ?? actions.busy} onAnswer={onAnswer}
            onAction={(item, action) => actions.run(action, targetOf(item))} />
        </section>
        {snapshot && <LiveColumn snapshot={snapshot} metrics={metrics} now={now} onOpen={panel.open} />}
      </div>
      {actions.dialog}
      <IssuePanel />
    </Shell>
  )
}
