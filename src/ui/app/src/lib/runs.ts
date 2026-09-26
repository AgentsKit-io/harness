import type { BoardIssue, IssueRecord, MetricsReport, UiSnapshot } from './api'

/** Pure read helpers over the snapshot shared by Attention, Runs, Batch and the issue panel. */

export type RunBucket = 'running' | 'blocked' | 'held' | 'review' | 'queued' | 'done' | 'archived' | 'available'

export const runBucket = (record: IssueRecord): RunBucket => {
  if (record.run?.archived) return 'archived'
  if (record.phase === 'completed') return 'done'
  // Closed in the tracker (done, cancelled, duplicate): history, whatever the loop last recorded.
  if (record.trackerState && /^(done|completed|closed|cancell?ed|canceled|duplicate|won'?t ?(do|fix))$/i.test(record.trackerState.trim())) return 'done'
  if (record.reviewState === 'human-approval') return 'held'
  if (record.phase === 'blocked' || record.phase === 'needs-input' || record.phase === 'needs-decision' || record.run?.status === 'failed') return 'blocked'
  if (record.phase === 'review') return 'review'
  // `ui.run-enqueued` already says `running`; until the engine reports a dispatch the run is only queued.
  if (!record.dispatch && (record.run?.status === 'queued' || record.run?.status === 'dispatching')) return 'queued'
  if (record.phase === 'running') return 'running'
  return 'available'
}

export const BUCKET_COLOR: Readonly<Record<RunBucket, string>> = {
  running: 'text-accent-strong', blocked: 'text-danger', held: 'text-warning', review: 'text-success',
  queued: 'text-ink-muted', done: 'text-ink-subtle', archived: 'text-ink-subtle', available: 'text-ink-muted',
}

export const STAGES = ['contract', 'build', 'review', 'merge'] as const

/** Index of the current stage in `STAGES`; `STAGES.length` once merged, `-1` before any run exists. */
export const stageIndex = (record: IssueRecord): number => {
  if (record.phase === 'completed') return STAGES.length
  if (record.reviewState === 'human-approval' || record.reviewState === 'ready-to-merge') return 3
  if (record.phase === 'review' || record.pullRequest) return 2
  if (record.dispatch) return 1
  return record.run ? 0 : -1
}

export type Segment = 'done' | 'active' | 'stopped' | 'todo'

export const segments = (record: IssueRecord): readonly Segment[] => {
  const current = stageIndex(record)
  const bucket = runBucket(record)
  const moving = bucket === 'running' || bucket === 'review' || (bucket === 'queued' && record.run?.status === 'dispatching')
  return STAGES.map((_, index) => index < current ? 'done' : index === current ? (moving ? 'active' : 'stopped') : 'todo')
}

export const SEGMENT_CLASS: Readonly<Record<Segment, string>> = { done: 'bg-[#2b6f95]', active: 'seg-active', stopped: 'bg-warning', todo: 'bg-line-soft' }

export const phaseLabel = (record: IssueRecord): string => {
  const bucket = runBucket(record)
  const stage = STAGES[Math.max(0, Math.min(stageIndex(record), STAGES.length - 1))] ?? 'contract'
  switch (bucket) {
    case 'done': return record.pullRequest?.state === 'MERGED' ? 'merged' : 'done'
    case 'held': return 'held · approve'
    case 'queued': return record.run?.status === 'dispatching' ? 'dispatching' : 'queued'
    case 'blocked': return `${stage} · ${record.phase === 'needs-input' ? 'needs input' : record.phase === 'needs-decision' ? 'needs decision' : 'blocked'}`
    case 'review': return record.reviewState ? `review · ${record.reviewState.replace(/-/g, ' ')}` : 'review'
    case 'running': return stage
    case 'archived': return 'archived'
    case 'available': return 'available'
  }
}

export const modelOf = (record: IssueRecord): string => record.dispatch?.model ?? record.run?.builder.split('/').pop() ?? '—'

export const formatTokens = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(Math.round(value))

export const tokensByIssue = (report: MetricsReport | null): ReadonlyMap<string, number> =>
  new Map((report?.tokens.perIssue ?? []).map((row) => [row.issue, row.tokens]))

/** Bar color for spend against a cap: ≥80% warning, ≥100% danger. */
export const capTone = (used: number, cap: number | null | undefined): 'bg-accent' | 'bg-warning' | 'bg-danger' => {
  if (!cap) return 'bg-accent'
  const ratio = used / cap
  return ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warning' : 'bg-accent'
}

export const matchesSearch = (record: IssueRecord, query: string): boolean => {
  const needle = query.trim().toLowerCase().replace(/^#/, '')
  if (!needle) return true
  return [record.issue, record.title ?? '', record.dispatch?.branch ?? '', record.pullRequest ? String(record.pullRequest.number) : '']
    .some((field) => field.toLowerCase().includes(needle))
}

export const ageMs = (at: string | null | undefined, now: number): number | null => at ? Math.max(0, now - Date.parse(at)) : null

/** Time in the current phase; records projected before `phaseSince` existed fall back to their last change. */
export const phaseAgeMs = (record: IssueRecord, now: number): number | null => ageMs(record.phaseSince ?? record.updatedAt, now)

/** `used/max` fix rounds, or `—` before the issue was ever dispatched. */
export const fixRoundsLabel = (record: IssueRecord): string => !(record.dispatch || record.pullRequest || record.run) ? '—' : record.run ? `${record.fixRoundsUsed ?? 0}/${record.run.maxFixRounds}` : String(record.fixRoundsUsed ?? 0)
export const fixRoundsAtCap = (record: IssueRecord): boolean => record.run !== null && (record.fixRoundsUsed ?? 0) >= record.run.maxFixRounds && record.run.maxFixRounds > 0

/** A board issue can be queued when the control plane never touched it, or did and it settled back to available. */
export const availableIssues = (snapshot: UiSnapshot): readonly BoardIssue[] => {
  const byIssue = new Map(snapshot.issues.map((record) => [record.issue, record]))
  return (snapshot.board?.issues ?? []).filter((issue) => {
    const record = byIssue.get(issue.identifier)
    return (!record || record.phase === 'available') && issue.lane !== 'done'
  })
}
