import type { LoopEvent } from '../../loop/retro.js'
import type { AttentionAction, AttentionActionId, AttentionGroup, AttentionItem, AttentionKind, Drift } from './contract.js'
import type { IssueRecord } from './projection.js'
import { trackerClosed } from './reconcile.js'

/**
 * The Attention list: everything that needs the operator, in one order — human decisions, then stuck/failed runs,
 * then drift, then system — oldest first inside a group. Pure: `extras.ts` reads the state files and the
 * (windowed) event tail, this only classifies. A reason is always a sentence; the raw code stays in `detail`.
 */

/** The latest event per issue that explains why its run stopped, classified by type — never by message text. */
export interface StopSignal {
  readonly type: string
  readonly reason: string | null
  readonly at: string
  /** A `cost-guard.tripped`/`max-duration.tripped` that came with the stop, when there was one. */
  readonly breaker: 'cost-guard' | 'max-duration' | null
}

export interface AttentionInput {
  readonly now: Date
  readonly issues: readonly IssueRecord[]
  readonly drift: readonly Drift[]
  readonly locks: Readonly<Record<string, string>>
  readonly stops: Readonly<Record<string, StopSignal>>
  /** Delivery facts the projection does not carry: fix rounds spent and the head a held PR waits on. */
  readonly delivery: Readonly<Record<string, { readonly fixRounds: number; readonly maxFixRounds: number | null; readonly heldFor: string | null }>>
  readonly boardStates: Readonly<Record<string, string>>
  /** Issues whose resilience pause (`failures.json`) is still set. */
  readonly pausedIssues: readonly string[]
  readonly plans: readonly { readonly id: string; readonly objective: string; readonly gate: 'plan' | 'design'; readonly since: string }[]
  readonly release: { readonly head: string; readonly since: string } | null
  readonly stagePauses: readonly { readonly stage: string; readonly since: string; readonly reason: string | null }[]
  readonly cooldowns: readonly { readonly provider: string; readonly until: string; readonly reason: string; readonly since: string }[]
  readonly syncFailures: readonly { readonly issue: string | null; readonly operation: string | null; readonly error: string | null; readonly at: string }[]
  readonly pii: readonly { readonly issue: string | null; readonly kinds: readonly string[]; readonly at: string }[]
  readonly automations: readonly { readonly name: string; readonly stage: string | null; readonly state: 'missing' | 'drifted' | 'undeclared'; readonly fields: readonly string[]; readonly since: string }[]
}

const STOP_TYPES = new Set([
  'worker.blocked', 'worker.stuck', 'worker.failed', 'worker.permission-wait', 'worker.dispatch-failed', 'issue.paused',
  'contract.failed', 'contract.escalated', 'plan.failed', 'plan.escalated', 'ui.cleanup-failed',
  'github-intake.blocked', 'github-intake.stuck', 'github-intake.failed',
])
/** Any other delivery-family event after a stop means the issue moved on and the stop no longer explains it. */
const PROGRESS_FAMILY = /^(worker|pr|github-intake|ui)\./
const BREAKER_WINDOW_MS = 60_000

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

/** Fold the (already windowed) event tail into the latest stop per issue. */
export const latestStops = (events: readonly LoopEvent[]): Record<string, StopSignal> => {
  const stops: Record<string, StopSignal> = {}
  const breakers: Record<string, { readonly kind: 'cost-guard' | 'max-duration'; readonly at: number }> = {}
  const ordered = [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  for (const event of ordered) {
    const issue = text(event.issue) ?? (typeof event['pr'] === 'number' ? `pr-${event['pr']}` : null)
    if (!issue) continue
    if (event.type === 'cost-guard.tripped' || event.type === 'max-duration.tripped') { breakers[issue] = { kind: event.type === 'cost-guard.tripped' ? 'cost-guard' : 'max-duration', at: Date.parse(event.at) }; continue }
    if (!STOP_TYPES.has(event.type)) {
      if (PROGRESS_FAMILY.test(event.type) && event.type !== 'pr.merge-refused') { delete stops[issue]; delete breakers[issue] }
      continue
    }
    const breaker = breakers[issue]
    const reasons = Array.isArray(event['reasons']) ? event['reasons'].filter((item): item is string => typeof item === 'string').join('; ') : null
    stops[issue] = {
      type: event.type, at: event.at,
      reason: text(event['reason']) ?? text(event['error']) ?? text(event['detail']) ?? (reasons || null),
      breaker: breaker && Date.parse(event.at) - breaker.at <= BREAKER_WINDOW_MS ? breaker.kind : null,
    }
  }
  return stops
}

const GROUP_ORDER: readonly AttentionGroup[] = ['human', 'failed', 'drift', 'system']

const LABELS: Readonly<Record<AttentionActionId, string>> = {
  answer: 'Answer', 'approve-pr': 'Approve PR', 'approve-plan': 'Approve plan', 'approve-design': 'Approve design', 'approve-release': 'Approve release',
  retry: 'Retry', cancel: 'Cancel run', resume: 'Resume', open: 'Open', reconcile: 'Reconcile',
  'reinstall-automations': 'Reinstall automations', 'resume-stage': 'Resume stage', 'run-doctor': 'Run doctor',
}
const DESTRUCTIVE = new Set<AttentionActionId>(['cancel', 'reconcile'])
const GATES = new Set<AttentionActionId>(['approve-pr', 'approve-plan', 'approve-design', 'approve-release'])

const actions = (...ids: readonly AttentionActionId[]): readonly AttentionAction[] => ids.map((id, index) => ({ id, label: LABELS[id], primary: index === 0, destructive: DESTRUCTIVE.has(id), gate: GATES.has(id) }))

/** One sentence per failure kind; the event's own reason goes to `detail`. */
const FAILED_REASON: Readonly<Record<string, string>> = {
  'ci-failed': 'CI is failing and the run stopped; look at the checks before retrying.',
  'fix-round-cap': 'The run used every fix round without passing review; a person needs to take over.',
  stuck: 'The worker stopped producing output and could not be revived.',
  'permission-wait': 'The worker is waiting on a tool-permission prompt; the loop never answers those.',
  'cost-guard': 'The run was stopped for spending more than its usage budget.',
  'max-duration': 'The run was stopped for exceeding its time limit.',
  blocked: 'The run is blocked and will not continue on its own.',
}

interface Classified { readonly kind: AttentionKind; readonly reason: string; readonly detail: string | null; readonly since: string; readonly ids: readonly AttentionActionId[] }

/** Why an issue's run needs the operator, or `null` when it is moving. Shared by Attention and the issue detail's next step. */
export const classifyIssue = (record: IssueRecord, stop: StopSignal | undefined, delivery: AttentionInput['delivery'][string] | undefined, paused = false): Classified | null => {
  const detail = stop?.reason ?? record.error
  const since = stop?.at ?? record.updatedAt
  const runIds: AttentionActionId[] = record.run ? ['retry', 'cancel', 'open'] : ['open']
  if (stop?.type === 'worker.permission-wait' && record.phase !== 'completed') return { kind: 'permission-wait', reason: FAILED_REASON['permission-wait']!, detail, since, ids: record.run ? ['open', 'cancel'] : ['open'] }
  if (paused) return { kind: 'blocked', reason: 'The issue was paused after repeated failures; resume it once the cause is fixed.', detail, since, ids: ['resume', 'open'] }
  // Resumed since (the pause file is cleared without an event): the pause no longer explains anything.
  if (stop?.type === 'issue.paused') return null
  if (record.phase === 'needs-decision') return { kind: 'blocked', reason: 'The pull request was closed without merging; close the issue or reopen it.', detail, since, ids: ['open'] }
  if (record.phase !== 'blocked') return null
  let kind: AttentionKind = 'blocked'
  if (stop?.breaker) kind = stop.breaker
  else if (stop?.type === 'worker.stuck' || stop?.type === 'github-intake.stuck') kind = 'stuck'
  else if (delivery && delivery.maxFixRounds !== null && delivery.fixRounds >= delivery.maxFixRounds && (stop?.type === 'worker.blocked' || stop?.type === 'github-intake.blocked')) kind = 'fix-round-cap'
  else if (record.reviewState === 'ci-failed') kind = 'ci-failed'
  return { kind, reason: FAILED_REASON[kind]!, detail, since, ids: runIds }
}

export const buildAttention = (input: AttentionInput): readonly AttentionItem[] => {
  const items: AttentionItem[] = []
  const lockOf = (issue: string | null): Pick<AttentionItem, 'locked' | 'lockReason'> => {
    const reason = issue ? input.locks[issue] ?? null : null
    return { locked: reason !== null, lockReason: reason }
  }
  const push = (item: Omit<AttentionItem, 'locked' | 'lockReason'>): void => { items.push({ ...item, ...lockOf(item.issue) }) }

  for (const record of input.issues) {
    const closed = trackerClosed(input.boardStates[record.issue] ?? record.trackerState)
    // Cancelled/archived work never shows up as blocked: nobody is waiting on it.
    if (closed || record.run?.archived || record.run?.status === 'cancelled') continue
    for (const decision of record.pendingDecisions) {
      push({ id: `hitl:${decision.id}`, group: 'human', kind: 'hitl', issue: record.issue, title: decision.title, reason: `The ${decision.role} needs a decision before the ${decision.stage} stage can continue.`, detail: decision.message || null, since: decision.createdAt, actions: actions('answer', 'open'), decision })
    }
    const delivery = input.delivery[record.issue]
    if (record.reviewState === 'human-approval' && record.phase !== 'completed') {
      const head = delivery?.heldFor ?? record.pullRequest?.head ?? null
      push({ id: `held-pr:${record.issue}:${head ?? 'unknown'}`, group: 'human', kind: 'held-pr', issue: record.issue, title: record.title ?? record.issue, reason: 'The pull request touches protected paths and waits for a person to approve this exact head.', detail: record.pullRequest ? `PR #${record.pullRequest.number}` : null, since: record.updatedAt, actions: actions('approve-pr', 'open'), head })
    }
    const classified = classifyIssue(record, input.stops[record.issue], delivery, input.pausedIssues.includes(record.issue))
    if (classified) push({ id: `${classified.kind}:${record.issue}`, group: 'failed', kind: classified.kind, issue: record.issue, title: record.title ?? record.issue, reason: classified.reason, detail: classified.detail, since: classified.since, actions: actions(...classified.ids) })
  }

  const records = new Map(input.issues.map((record) => [record.issue, record]))
  for (const item of input.drift) {
    push({ id: `drift:${item.issue ?? 'global'}:${item.kind}`, group: 'drift', kind: 'drift', issue: item.issue, title: item.issue ? records.get(item.issue)?.title ?? item.issue : 'Worker capacity', reason: item.kind === 'capacity-overcount' ? 'More workers hold a slot than the machine ceiling allows.' : 'The loop and the outside world disagree about this issue.', detail: `${item.kind}: ${item.detail}`, since: item.issue ? records.get(item.issue)?.updatedAt ?? input.now.toISOString() : input.now.toISOString(), actions: item.issue ? actions('reconcile', 'open') : actions('open') })
  }

  for (const plan of input.plans) {
    push(plan.gate === 'plan'
      ? { id: `plan:${plan.id}`, group: 'human', kind: 'plan-gate', issue: plan.id, title: plan.objective, reason: 'The PRD is complete and waits for a person to approve it.', detail: null, since: plan.since, actions: actions('approve-plan') }
      : { id: `design:${plan.id}`, group: 'human', kind: 'design-gate', issue: plan.id, title: plan.objective, reason: 'The design reached consensus and waits for a person to approve it.', detail: null, since: plan.since, actions: actions('approve-design') })
  }
  if (input.release) push({ id: `release-gate:${input.release.head}`, group: 'human', kind: 'release-gate', issue: null, title: 'Release batch', reason: 'A release batch waits for a person to approve it.', detail: `head ${input.release.head.slice(0, 12)}`, since: input.release.since, actions: actions('approve-release'), head: input.release.head })

  for (const pause of input.stagePauses) push({ id: `stage-paused:${pause.stage}`, group: 'system', kind: 'stage-paused', issue: null, title: `${pause.stage} stage paused`, reason: `The ${pause.stage} stage paused itself after repeated failures.`, detail: pause.reason, since: pause.since, actions: actions('resume-stage', 'run-doctor'), stage: pause.stage })
  for (const cooldown of input.cooldowns) push({ id: `provider-cooldown:${cooldown.provider}`, group: 'system', kind: 'provider-cooldown', issue: null, title: `${cooldown.provider} cooling down`, reason: `${cooldown.provider} is unavailable until ${cooldown.until}; work routes to other providers meanwhile.`, detail: cooldown.reason, since: cooldown.since, actions: actions('run-doctor') })
  const latestSync = new Map<string, AttentionInput['syncFailures'][number]>()
  for (const failure of input.syncFailures) { const key = failure.issue ?? 'global'; const current = latestSync.get(key); if (!current || current.at < failure.at) latestSync.set(key, failure) }
  for (const [key, failure] of latestSync) push({ id: `tracker-sync:${key}`, group: 'system', kind: 'tracker-sync', issue: failure.issue, title: failure.issue ?? 'Tracker', reason: 'The loop could not update the tracker; its state there may be behind.', detail: [failure.operation, failure.error].filter(Boolean).join(': ') || null, since: failure.at, actions: actions('open') })
  const latestPii = new Map<string, AttentionInput['pii'][number]>()
  for (const hit of input.pii) { const key = hit.issue ?? 'global'; const current = latestPii.get(key); if (!current || current.at < hit.at) latestPii.set(key, hit) }
  for (const [key, hit] of latestPii) push({ id: `pii:${key}`, group: 'system', kind: 'pii', issue: hit.issue, title: hit.issue ?? 'Personal data', reason: 'Issue text looks like it contains personal data; redact it at the source.', detail: hit.kinds.join(', ') || null, since: hit.at, actions: actions('open') })
  for (const automation of input.automations) {
    const missing = automation.state === 'missing'
    push({ id: `automation-${missing ? 'missing' : 'drift'}:${automation.name}`, group: 'system', kind: missing ? 'automation-missing' : 'automation-drift', issue: null, title: automation.name, reason: missing ? 'A loop automation is not installed, so that stage never runs on its own.' : automation.state === 'undeclared' ? 'An automation the config no longer declares is still enabled.' : 'A loop automation differs from what the config declares.', detail: automation.fields.length ? automation.fields.join(', ') : automation.state, since: automation.since, actions: actions('reinstall-automations'), stage: automation.stage })
  }

  const rank = (item: AttentionItem): number => GROUP_ORDER.indexOf(item.group)
  return items.sort((left, right) => rank(left) - rank(right) || Date.parse(left.since) - Date.parse(right.since) || left.id.localeCompare(right.id))
}
