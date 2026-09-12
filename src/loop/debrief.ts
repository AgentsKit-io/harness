import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { readStoredContract } from './contract.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { listDispatched, readDeliveryState, type DeliveryState } from './deliver.js'
import { readLoopEvents, parseSince, type LoopEvent } from './retro.js'
import { readDispatchRecord, type DispatchRecordFile } from './tick.js'
import { queueOwner } from './rotation.js'
import { readOutcomeProgress, type OutcomeProgress } from './progress.js'

export interface DebriefInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly issue?: string
  readonly since?: string
  readonly now?: () => Date
}

export interface DebriefIssueRow {
  readonly issue: string
  readonly url: string | null
  readonly phase: string
  readonly summary: string
  readonly provider: string | null
  readonly model: string | null
  readonly worktree: string | null
  readonly branch: string | null
  readonly pr: number | null
  readonly prUrl: string | null
  readonly dispatchedAt: string | null
  readonly ageMin: number | null
  readonly fixRounds: number
  readonly reviewStatus: string | null
  readonly heldFor: string | null
  readonly finalOutcome: string | null
  readonly contractIntent: string | null
  /** Best-effort read of `progress.json` from the worktree, keyed by outcome id (see brief.ts rule 10); `null` when the worker hasn't written one. */
  readonly progress: OutcomeProgress | null
}

export interface DebriefReport {
  readonly generatedAt: string
  readonly project: string
  readonly person: string
  readonly repo: string
  readonly windowHours: number
  readonly inFlight: readonly DebriefIssueRow[]
  readonly held: readonly DebriefIssueRow[]
  readonly recentEscalations: readonly { readonly issue: string; readonly at: string; readonly reason: string }[]
  readonly cooldowns: readonly { readonly provider: string; readonly reason: string; readonly until: string }[]
  readonly recentEvents: readonly { readonly at: string; readonly type: string; readonly issue: string | null }[]
  readonly headline: string
}

const minutesBetween = (later: Date, earlier: string | null): number | null => {
  if (!earlier) return null
  const ms = later.getTime() - Date.parse(earlier)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : null
}

const latestReview = (state: DeliveryState): { readonly status: string; readonly attempts: number } | null => {
  const entries = Object.values(state.reviews)
  if (entries.length === 0) return null
  const latest = entries.reduce((best, item) => (item.at > best.at ? item : best))
  return { status: latest.status, attempts: latest.attempts }
}

const phaseOf = (dispatch: DispatchRecordFile | null, delivery: DeliveryState): string => {
  if (delivery.finalOutcome) return delivery.finalOutcome
  if (delivery.heldFor) return 'held'
  if (!dispatch) return 'idle'
  if (!delivery.prNumber) return 'waiting-for-pr'
  const review = latestReview(delivery)
  if (!review) return 'awaiting-review'
  if (review.status === 'incomplete') return review.attempts >= 2 ? 'held-incomplete-review' : 'review-incomplete'
  if (review.status === 'findings') return 'fix-round'
  if (review.status === 'clean') return 'ready-to-merge'
  return 'in-flight'
}

const summarize = (phase: string, delivery: DeliveryState, dispatch: DispatchRecordFile | null): string => {
  if (phase === 'merged') return `Merged PR #${delivery.prNumber ?? '?'}`
  if (phase === 'held' || phase === 'held-incomplete-review') {
    if (delivery.heldFor) return `Held for a human (self-edit or protected path at ${delivery.heldFor.slice(0, 7)})`
    return `Review incomplete twice at the current head — needs a human look`
  }
  if (phase === 'waiting-for-pr') return `Worker ${dispatch?.provider}/${dispatch?.model} active; no PR yet`
  if (phase === 'awaiting-review') return `PR #${delivery.prNumber} open; review not started`
  if (phase === 'review-incomplete') return `PR #${delivery.prNumber} review incomplete (attempt ${latestReview(delivery)?.attempts ?? 1})`
  if (phase === 'fix-round') return `PR #${delivery.prNumber} has review findings; fix round ${delivery.fixRounds}`
  if (phase === 'ready-to-merge') return `PR #${delivery.prNumber} review clean; waiting for deliver to merge`
  if (delivery.finalOutcome) return `Finished as ${delivery.finalOutcome}`
  return 'In flight'
}

const prUrl = (repo: string, number: number | null): string | null => (number ? `https://github.com/${repo}/pull/${number}` : null)

const rowFor = (input: {
  readonly issue: string
  readonly dispatch: DispatchRecordFile | null
  readonly delivery: DeliveryState
  readonly intent: string | null
  readonly repo: string
  readonly now: Date
}): DebriefIssueRow => {
  const phase = phaseOf(input.dispatch, input.delivery)
  const review = latestReview(input.delivery)
  return {
    issue: input.issue,
    progress: readOutcomeProgress(input.dispatch?.worktreePath),
    url: input.dispatch?.url ?? null,
    phase,
    summary: summarize(phase, input.delivery, input.dispatch),
    provider: input.dispatch?.provider ?? null,
    model: input.dispatch?.model ?? null,
    worktree: input.dispatch?.worktree ?? null,
    branch: input.dispatch?.branch ?? null,
    pr: input.delivery.prNumber,
    prUrl: prUrl(input.repo, input.delivery.prNumber),
    dispatchedAt: input.dispatch?.dispatchedAt ?? null,
    ageMin: minutesBetween(input.now, input.dispatch?.dispatchedAt ?? null),
    fixRounds: input.delivery.fixRounds,
    reviewStatus: review ? `${review.status}×${review.attempts}` : null,
    heldFor: input.delivery.heldFor,
    finalOutcome: input.delivery.finalOutcome,
    contractIntent: input.intent,
  }
}

const listIssueIds = (stateDir: string): readonly string[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

/** Filesystem-only human debrief of what the loop is working on right now. No Orca/gh writes. */
export const buildDebriefReport = (input: DebriefInput): DebriefReport => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath ?? 'loop.config.yaml')
  const now = input.now?.() ?? new Date()
  const since = parseSince(input.since ?? '24h', now)
  const windowHours = Math.max(1, Math.round((now.getTime() - since.getTime()) / 3_600_000))
  const config = loaded.config
  const person = queueOwner(loaded)
  const stateDir = loaded.stateDir
  const ids = input.issue ? [input.issue] : [...new Set([...listDispatched(stateDir).map((item) => item.issue), ...listIssueIds(stateDir)])]
  const rows: DebriefIssueRow[] = []
  for (const issue of ids) {
    const dispatch = readDispatchRecord(stateDir, issue)
    const delivery = readDeliveryState(stateDir, issue)
    if (input.issue) {
      /* always include */
    } else if (!dispatch && !delivery.prNumber && !delivery.finalOutcome && !delivery.heldFor && Object.keys(delivery.reviews).length === 0) {
      const contract = readStoredContract(stateDir, issue)
      if (!contract || contract.assessment.dispatchable) continue
    }
    const contract = readStoredContract(stateDir, issue)
    const intent = contract?.contract.intent ?? null
    if (!dispatch && !delivery.prNumber && !delivery.finalOutcome && !delivery.heldFor && Object.keys(delivery.reviews).length === 0) {
      if (contract && !contract.assessment.dispatchable) {
        rows.push({
          issue,
          url: null,
          progress: null,
          phase: 'escalated',
          summary: `Needs-info: ${contract.assessment.reasons[0] ?? 'contract not dispatchable'}`,
          provider: contract.provider,
          model: contract.model,
          worktree: null,
          branch: null,
          pr: null,
          prUrl: null,
          dispatchedAt: null,
          ageMin: minutesBetween(now, contract.generatedAt),
          fixRounds: 0,
          reviewStatus: null,
          heldFor: null,
          finalOutcome: null,
          contractIntent: intent,
        })
        continue
      }
      continue
    }
    rows.push(rowFor({ issue, dispatch, delivery, intent, repo: config.project.repo, now }))
  }
  const inFlight = rows.filter((row) => !row.finalOutcome && row.phase !== 'escalated')
  const held = rows.filter((row) => row.phase === 'held' || row.phase === 'held-incomplete-review' || row.heldFor)
  const events = readLoopEvents(stateDir).filter((event) => Date.parse(event.at) >= since.getTime())
  const recentEscalations = events
    .filter((event) => event.type === 'contract.escalated')
    .slice(-10)
    .map((event) => ({
      issue: typeof event.issue === 'string' ? event.issue : '?',
      at: event.at,
      reason: Array.isArray(event['reasons']) ? String(event['reasons'][0] ?? '') : String(event['reason'] ?? ''),
    }))
  const cooldownState = readCooldowns(stateDir)
  const active = activeCooldowns(cooldownState, now)
  const cooldowns = Object.entries(active).map(([provider, until]) => ({
    provider,
    reason: cooldownState[provider]?.reason ?? 'cooldown',
    until,
  }))
  const recentEvents = events.slice(-15).map((event: LoopEvent) => ({
    at: event.at,
    type: event.type,
    issue: typeof event.issue === 'string' ? event.issue : null,
  }))
  const headline = inFlight.length === 0 && held.length === 0
    ? `Loop idle for ${person} on ${config.project.name}`
    : `Loop working ${inFlight.length} issue(s)` + (held.length ? `, ${held.length} held for a human` : '') + ` on ${config.project.name}`
  return {
    generatedAt: now.toISOString(),
    project: config.project.name,
    person,
    repo: config.project.repo,
    windowHours,
    inFlight,
    held,
    recentEscalations,
    cooldowns,
    recentEvents,
    headline,
  }
}

export const renderDebriefMarkdown = (report: DebriefReport): string => {
  const lines: string[] = []
  lines.push(`# Loop debrief — ${report.project} · ${report.person}`, '')
  lines.push(`_${report.headline}_ · generated ${report.generatedAt.slice(0, 19)}Z · last ${report.windowHours}h`, '')
  if (report.inFlight.length === 0) {
    lines.push('## In flight', '', '_Nothing dispatched right now._', '')
  } else {
    lines.push('## In flight', '')
    for (const row of report.inFlight) {
      lines.push(`### ${row.issue} — ${row.phase}`)
      lines.push(`- ${row.summary}`)
      if (row.contractIntent) lines.push(`- Intent: ${row.contractIntent}`)
      if (row.provider) lines.push(`- Worker: \`${row.provider}/${row.model}\`${row.ageMin !== null ? ` · ${row.ageMin} min` : ''}`)
      if (row.progress) {
        const done = Object.values(row.progress).filter((status) => status === 'done').length
        lines.push(`- Progress: ${done}/${Object.keys(row.progress).length} outcome(s) done (${Object.entries(row.progress).map(([id, status]) => `${id}: ${status}`).join(', ')})`)
      }
      if (row.worktree) lines.push(`- Worktree: \`${row.worktree}\``)
      if (row.branch) lines.push(`- Branch: \`${row.branch}\``)
      if (row.prUrl) lines.push(`- PR: ${row.prUrl}${row.reviewStatus ? ` · review ${row.reviewStatus}` : ''}`)
      if (row.url) lines.push(`- Linear: ${row.url}`)
      lines.push('')
    }
  }
  if (report.held.length) {
    lines.push('## Needs a human', '')
    for (const row of report.held) {
      lines.push(`- **${row.issue}**: ${row.summary}${row.prUrl ? ` (${row.prUrl})` : ''}`)
    }
    lines.push('')
  }
  if (report.cooldowns.length) {
    lines.push('## Provider cooldowns', '')
    for (const item of report.cooldowns) lines.push(`- \`${item.provider}\`: ${item.reason} until ${item.until.slice(0, 19)}Z`)
    lines.push('')
  }
  if (report.recentEscalations.length) {
    lines.push('## Recent escalations', '')
    for (const item of report.recentEscalations) lines.push(`- ${item.at.slice(0, 16)}Z · **${item.issue}**: ${item.reason.slice(0, 160)}`)
    lines.push('')
  }
  if (report.recentEvents.length) {
    lines.push('## Recent events', '')
    for (const item of report.recentEvents) lines.push(`- ${item.at.slice(0, 16)}Z · \`${item.type}\`${item.issue ? ` · ${item.issue}` : ''}`)
    lines.push('')
  }
  lines.push('_Read-only. Run `ak-harness loop deliver` / `tick` to act; `loop retro` for the weekly digest._')
  return lines.join('\n')
}
