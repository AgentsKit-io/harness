import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { orcaAutomationRuns, orcaAutomationsList } from '../adapters/orca-cli.js'
import { hashJson } from '../kernel/hash.js'
import { parseRetro, type LearningRecord } from '../kernel/learning.js'
import { loadLoopConfig, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { readStoredContract } from './contract.js'
import { readCooldowns } from './cooldown.js'
import { readDeliveryState } from './deliver.js'
import { LOOP_STAGES, automationName } from './install.js'
import { readDispatchRecord } from './tick.js'

export interface LoopEvent { readonly at: string; readonly type: string; readonly issue?: string; readonly [key: string]: unknown }

export interface RetroWindow { readonly since: string; readonly until: string; readonly days: number }

export interface RetroIssueRow {
  readonly issue: string
  readonly outcome: string
  readonly provider: string | null
  readonly model: string | null
  readonly dispatchedAt: string | null
  readonly finishedAt: string | null
  readonly leadTimeMin: number | null
  readonly fixRounds: number
  readonly nudges: number
  readonly reviews: number
  readonly pr: number | null
}

export interface RetroSuggestion { readonly id: string; readonly severity: 'info' | 'tune' | 'act'; readonly text: string; readonly evidence: string; readonly knob?: string }

export interface RetroReport {
  readonly generatedAt: string
  readonly window: RetroWindow
  readonly project: string
  readonly person: string
  readonly counts: Readonly<Record<string, number>>
  readonly escalations: { readonly total: number; readonly issues: readonly string[]; readonly reasons: readonly { readonly reason: string; readonly count: number }[] }
  readonly dispatches: { readonly total: number; readonly failed: number; readonly byProvider: Readonly<Record<string, number>> }
  readonly delivery: { readonly merged: number; readonly blocked: number; readonly stuck: number; readonly abandoned: number; readonly inFlight: number; readonly fixRounds: number; readonly reviewsClean: number; readonly reviewsFindings: number; readonly reviewsIncomplete: number; readonly medianLeadTimeMin: number | null }
  readonly providers: { readonly cooldowns: readonly { readonly provider: string; readonly reason: string; readonly until: string }[]; readonly cooldownEvents: number }
  readonly orca: { readonly runs: number; readonly idle: number; readonly work: number; readonly timedOut: number; readonly avgDurationSec: number | null; readonly maxDurationSec: number | null } | null
  readonly issues: readonly RetroIssueRow[]
  readonly suggestions: readonly RetroSuggestion[]
  readonly digest: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const readLoopEvents = (stateDir: string): readonly LoopEvent[] => {
  const path = join(stateDir, 'events.ndjson')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { const parsed = JSON.parse(line) as unknown; return isRecord(parsed) && typeof parsed['at'] === 'string' && typeof parsed['type'] === 'string' ? [parsed as LoopEvent] : [] } catch { return [] } })
}

export const parseSince = (value: string | undefined, now: Date): Date => {
  if (!value) return new Date(now.getTime() - 7 * 86_400_000)
  const match = value.match(/^(\d+)([dhm])$/)
  if (match) { const amount = Number(match[1]); const unit = match[2] === 'd' ? 86_400_000 : match[2] === 'h' ? 3_600_000 : 60_000; return new Date(now.getTime() - amount * unit) }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`Unrecognised --since value: ${value} (use 7d, 12h, 30m or an ISO date)`)
  return new Date(parsed)
}

const median = (values: readonly number[]): number | null => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2 }
const minutes = (later: string | null, earlier: string | null): number | null => later && earlier ? Math.round((Date.parse(later) - Date.parse(earlier)) / 60_000) : null

/** Collapse an escalation reason to its head phrase so identical shapes group together. */
export const normalizeReason = (reason: string): string => reason.replace(/^\d+ blocking ambiguit(y|ies): /, 'blocking ambiguity: ').split(/[|:]/).slice(0, 2).join(':').trim().slice(0, 90)

export const buildSuggestions = (input: { readonly config: LoopConfig; readonly report: Omit<RetroReport, 'suggestions' | 'digest'> }): readonly RetroSuggestion[] => {
  const { config, report } = input
  const out: RetroSuggestion[] = []
  const dispatched = report.dispatches.total
  const escalated = report.escalations.total
  if (escalated + dispatched >= 3 && escalated / Math.max(1, escalated + dispatched) >= 0.6) out.push({ id: 'escalation-rate', severity: 'act', text: `${escalated} of ${escalated + dispatched} contracts escalated. Most issues lack a verifiable acceptance criterion or reference assets the worker cannot reach — answer the needs-info comments or add acceptance criteria templates to the issue template.`, evidence: report.escalations.reasons.slice(0, 3).map((row) => `${row.count}× ${row.reason}`).join('; '), knob: 'issue template / linear.excludeLabels' })
  if (report.delivery.reviewsClean >= 5 && report.delivery.reviewsFindings === 0) out.push({ id: 'review-floor', severity: 'tune', text: `${report.delivery.reviewsClean} reviews with zero blocking findings. The floor may be too permissive to catch anything, or the workers are good; consider lowering delivery.review.minSeverity to "nit" for one week and compare.`, evidence: `reviewsClean=${report.delivery.reviewsClean}`, knob: 'delivery.review.minSeverity' })
  if (report.delivery.blocked >= 2 && report.delivery.blocked >= report.delivery.merged) out.push({ id: 'fix-rounds', severity: 'act', text: `${report.delivery.blocked} PR(s) blocked after ${config.delivery.maxFixRounds} fix round(s) versus ${report.delivery.merged} merged. Either the reviewer floor is too strict for the builder model, or the builder tier is too weak: raise maxFixRounds or move the builder to a stronger model.`, evidence: `blocked=${report.delivery.blocked} merged=${report.delivery.merged}`, knob: 'delivery.maxFixRounds / models.builder' })
  if (report.delivery.stuck >= 2) out.push({ id: 'stuck-workers', severity: 'act', text: `${report.delivery.stuck} worker(s) went idle without a PR. Check the worker briefs and the provider's auto mode; consider a longer delivery.workerIdleTimeoutMin if they were still working.`, evidence: `stuck=${report.delivery.stuck}`, knob: 'delivery.workerIdleTimeoutMin' })
  if (report.delivery.reviewsIncomplete >= 2) out.push({ id: 'review-incomplete', severity: 'tune', text: `${report.delivery.reviewsIncomplete} review(s) came back incomplete (provider, deadline or coverage). Raise delivery.review.deadlineMs or maxCalls, or move the reviewer to a provider with usage headroom.`, evidence: `reviewsIncomplete=${report.delivery.reviewsIncomplete}`, knob: 'delivery.review.deadlineMs / models.reviewer' })
  if (report.providers.cooldownEvents >= 3) out.push({ id: 'provider-cooldowns', severity: 'tune', text: `${report.providers.cooldownEvents} provider cooldown(s) in the window. Add capacity (another subscription via orca account add, or a tier-2 provider) or lower the tick cadence during exhausted windows.`, evidence: report.providers.cooldowns.map((row) => `${row.provider}: ${row.reason}`).join('; ').slice(0, 200), knob: 'models.<role> tiers' })
  if (report.orca && report.orca.runs >= 6 && report.orca.idle / report.orca.runs >= 0.9 && report.delivery.inFlight === 0 && report.escalations.total === 0 && report.dispatches.total === 0) out.push({ id: 'idle-loop', severity: 'info', text: `${report.orca.idle} of ${report.orca.runs} Orca runs were idle and nothing was dispatched. Either the queue is empty or every slot is taken; check machine.minFreeRamGb and the person's Todo/Ready backlog.`, evidence: `idle=${report.orca.idle} runs=${report.orca.runs}`, knob: 'machine.minFreeRamGb / linear.states' })
  if (report.orca && report.orca.timedOut > 0) out.push({ id: 'stage-timeout', severity: 'act', text: `${report.orca.timedOut} Orca precheck run(s) hit the ${config.schedule.stageTimeoutSec}s cap. Lower contract.timeoutMs or contract.maxContextReferences so one tick fits the budget.`, evidence: `maxDurationSec=${report.orca.maxDurationSec}`, knob: 'contract.timeoutMs / schedule.stageTimeoutSec' })
  if (report.delivery.medianLeadTimeMin !== null && report.delivery.medianLeadTimeMin > 6 * 60) out.push({ id: 'lead-time', severity: 'info', text: `Median dispatch→merge is ${Math.round(report.delivery.medianLeadTimeMin / 60)} h. Check whether CI or review deadlines dominate before changing worker models.`, evidence: `medianLeadTimeMin=${report.delivery.medianLeadTimeMin}`, knob: 'schedule.deliver / delivery.review.deadlineMs' })
  if (!out.length) out.push({ id: 'steady', severity: 'info', text: 'No calibration signal in this window. Keep the current configuration.', evidence: `dispatched=${dispatched} escalated=${escalated} merged=${report.delivery.merged}` })
  return out
}

export interface RetroInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner?: CommandRunner
  readonly since?: string
  readonly now?: () => Date
  /** Skip the Orca run summary (offline). */
  readonly skipOrca?: boolean
}

export const buildRetroReport = async (input: RetroInput): Promise<RetroReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const now = (input.now ?? (() => new Date()))()
  const since = parseSince(input.since, now)
  const inWindow = (at: string | null | undefined): boolean => typeof at === 'string' && Date.parse(at) >= since.getTime() && Date.parse(at) <= now.getTime()
  const events = readLoopEvents(loaded.stateDir).filter((event) => inWindow(event.at))
  const counts: Record<string, number> = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1

  const escalations = events.filter((event) => event.type === 'contract.escalated')
  const reasonCounts = new Map<string, number>()
  for (const event of escalations) for (const reason of Array.isArray(event['reasons']) ? event['reasons'].map(String) : []) { const key = normalizeReason(reason); reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1) }
  const dispatchEvents = events.filter((event) => event.type === 'worker.dispatched')
  const byProvider: Record<string, number> = {}
  for (const event of dispatchEvents) { const key = `${String(event['provider'] ?? '?')}/${String(event['model'] ?? '?')}`; byProvider[key] = (byProvider[key] ?? 0) + 1 }

  const issuesDir = join(loaded.stateDir, 'issues')
  const rows: RetroIssueRow[] = []
  let reviewsClean = 0, reviewsFindings = 0, reviewsIncomplete = 0, fixRounds = 0
  if (existsSync(issuesDir)) for (const entry of readdirSync(issuesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const issue = entry.name
    const dispatch = readDispatchRecord(loaded.stateDir, issue)
    const delivery = readDeliveryState(loaded.stateDir, issue)
    const contract = readStoredContract(loaded.stateDir, issue)
    const touched = [dispatch?.dispatchedAt ?? null, delivery.finishedAt, contract?.generatedAt ?? null].filter((value): value is string => Boolean(value))
    if (!touched.some(inWindow)) continue
    for (const review of Object.values(delivery.reviews)) { if (!inWindow(review.at)) continue; if (review.status === 'clean') reviewsClean += 1; else if (review.status === 'findings') reviewsFindings += 1; else reviewsIncomplete += 1 }
    fixRounds += delivery.fixRounds
    const outcome = delivery.finalOutcome ?? (dispatch ? 'in-flight' : contract && !contract.assessment.dispatchable ? 'escalated' : 'contracted')
    rows.push({ issue, outcome, provider: dispatch?.provider ?? null, model: dispatch?.model ?? null, dispatchedAt: dispatch?.dispatchedAt ?? null, finishedAt: delivery.finishedAt, leadTimeMin: delivery.finalOutcome === 'merged' ? minutes(delivery.finishedAt, dispatch?.dispatchedAt ?? null) : null, fixRounds: delivery.fixRounds, nudges: delivery.nudges.length, reviews: Object.keys(delivery.reviews).length, pr: delivery.prNumber })
  }
  rows.sort((left, right) => (right.dispatchedAt ?? '').localeCompare(left.dispatchedAt ?? '') || left.issue.localeCompare(right.issue))
  const tally = (outcome: string): number => rows.filter((row) => row.outcome === outcome).length

  const cooldownState = readCooldowns(loaded.stateDir)
  const cooldowns = Object.entries(cooldownState).filter(([, entry]) => inWindow(entry.markedAt) || Date.parse(entry.until) > now.getTime()).map(([provider, entry]) => ({ provider, reason: entry.reason, until: entry.until }))

  let orca: RetroReport['orca'] = null
  if (!input.skipOrca && input.runner) {
    try {
      const options = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
      const list = await orcaAutomationsList(input.runner, options)
      let runs = 0, idle = 0, work = 0, timedOut = 0
      const durations: number[] = []
      for (const stage of LOOP_STAGES) {
        const automation = list.find((item) => item.name === automationName(config, stage))
        if (!automation) continue
        const result = await orcaAutomationRuns(input.runner, automation.id, options)
        const items = isRecord(result) && Array.isArray(result['runs']) ? result['runs'].filter(isRecord) : []
        for (const run of items) {
          const startedAt = typeof run['startedAt'] === 'number' ? new Date(run['startedAt']).toISOString() : typeof run['createdAt'] === 'number' ? new Date(run['createdAt']).toISOString() : null
          if (!inWindow(startedAt)) continue
          runs += 1
          const precheck = isRecord(run['precheckResult']) ? run['precheckResult'] : null
          if (precheck?.['timedOut'] === true) timedOut += 1
          if (typeof precheck?.['durationMs'] === 'number') durations.push(precheck['durationMs'] / 1000)
          let status: string | null = null
          try { const parsed = JSON.parse(String(precheck?.['stdout'] ?? '')) as Record<string, unknown>; status = typeof parsed['status'] === 'string' ? parsed['status'] : null } catch { status = null }
          if (status === 'idle') idle += 1; else if (status === 'ok') work += 1
        }
      }
      orca = { runs, idle, work, timedOut, avgDurationSec: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null, maxDurationSec: durations.length ? Math.round(Math.max(...durations)) : null }
    } catch { orca = null }
  }

  const base: Omit<RetroReport, 'suggestions' | 'digest'> = {
    generatedAt: now.toISOString(),
    window: { since: since.toISOString(), until: now.toISOString(), days: Number(((now.getTime() - since.getTime()) / 86_400_000).toFixed(2)) },
    project: config.project.repo,
    person: config.linear.person,
    counts,
    escalations: { total: escalations.length, issues: [...new Set(escalations.map((event) => String(event.issue ?? '?')))], reasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count) },
    dispatches: { total: dispatchEvents.length, failed: counts['worker.dispatch-failed'] ?? 0, byProvider },
    delivery: { merged: tally('merged'), blocked: tally('blocked'), stuck: tally('stuck'), abandoned: tally('abandoned'), inFlight: tally('in-flight'), fixRounds, reviewsClean, reviewsFindings, reviewsIncomplete, medianLeadTimeMin: median(rows.map((row) => row.leadTimeMin).filter((value): value is number => value !== null)) },
    providers: { cooldowns, cooldownEvents: counts['provider.cooldown'] ?? 0 },
    orca,
    issues: rows,
  }
  const suggestions = buildSuggestions({ config, report: base })
  return { ...base, suggestions, digest: hashJson({ ...base, suggestions }) }
}

const pct = (part: number, whole: number): string => whole ? `${Math.round((part / whole) * 100)}%` : '—'

/** Markdown digest. Headings follow the harness retro grammar (`## What worked`, `## Problems`, `## Adjustments`) so `parseRetro` can lift learnings from it. */
export const renderRetroMarkdown = (report: RetroReport): string => {
  const lines: string[] = []
  lines.push(`# Loop retro — ${report.project} · ${report.person}`, '', `Window: ${report.window.since.slice(0, 16)}Z → ${report.window.until.slice(0, 16)}Z (${report.window.days} d) · generated ${report.generatedAt.slice(0, 19)}Z · digest ${report.digest.slice(0, 12)}`, '')
  lines.push('## Numbers', '', '| Metric | Value |', '|---|---|')
  lines.push(`| Contracts frozen | ${report.escalations.total + report.dispatches.total} |`)
  lines.push(`| Escalated (needs-info) | ${report.escalations.total} (${pct(report.escalations.total, report.escalations.total + report.dispatches.total)}) |`)
  lines.push(`| Dispatched | ${report.dispatches.total}${report.dispatches.failed ? ` (+${report.dispatches.failed} failed)` : ''} |`)
  lines.push(`| Merged / blocked / stuck / abandoned / in flight | ${report.delivery.merged} / ${report.delivery.blocked} / ${report.delivery.stuck} / ${report.delivery.abandoned} / ${report.delivery.inFlight} |`)
  lines.push(`| Reviews clean / findings / incomplete | ${report.delivery.reviewsClean} / ${report.delivery.reviewsFindings} / ${report.delivery.reviewsIncomplete} |`)
  lines.push(`| Fix rounds | ${report.delivery.fixRounds} |`)
  lines.push(`| Median dispatch→merge | ${report.delivery.medianLeadTimeMin === null ? '—' : `${report.delivery.medianLeadTimeMin} min`} |`)
  lines.push(`| Provider cooldowns | ${report.providers.cooldownEvents} |`)
  if (report.orca) lines.push(`| Orca runs (idle / work / timed out) | ${report.orca.runs} (${report.orca.idle} / ${report.orca.work} / ${report.orca.timedOut}) · avg ${report.orca.avgDurationSec ?? '—'} s · max ${report.orca.maxDurationSec ?? '—'} s |`)
  lines.push('')
  if (Object.keys(report.dispatches.byProvider).length) { lines.push('## Providers', '', ...Object.entries(report.dispatches.byProvider).map(([key, count]) => `- ${key}: ${count} dispatch(es)`), ...report.providers.cooldowns.map((row) => `- cooldown ${row.provider} until ${row.until.slice(0, 16)}Z — ${row.reason}`), '') }
  if (report.escalations.reasons.length) { lines.push('## Problems', '', ...report.escalations.reasons.map((row) => `- ${row.count}× ${row.reason}`), ...report.issues.filter((row) => ['blocked', 'stuck', 'abandoned'].includes(row.outcome)).map((row) => `- ${row.issue} ${row.outcome}${row.pr ? ` (PR #${row.pr})` : ''} after ${row.fixRounds} fix round(s), ${row.nudges} nudge(s)`), '') }
  const worked = report.issues.filter((row) => row.outcome === 'merged')
  if (worked.length) { lines.push('## What worked', '', ...worked.map((row) => `- ${row.issue} merged${row.pr ? ` (PR #${row.pr})` : ''} by ${row.provider}/${row.model} in ${row.leadTimeMin ?? '?'} min, ${row.fixRounds} fix round(s)`), '') }
  lines.push('## Adjustments', '', ...report.suggestions.map((item) => `- [${item.severity}] ${item.text}${item.knob ? ` _(knob: ${item.knob})_` : ''}\n  - evidence: ${item.evidence}`), '')
  if (report.issues.length) { lines.push('## Issues in window', '', '| Issue | Outcome | Worker | Dispatched | Fix rounds | Reviews | PR |', '|---|---|---|---|---|---|---|', ...report.issues.map((row) => `| ${row.issue} | ${row.outcome} | ${row.provider ? `${row.provider}/${row.model}` : '—'} | ${row.dispatchedAt ? row.dispatchedAt.slice(5, 16).replace('T', ' ') : '—'} | ${row.fixRounds} | ${row.reviews} | ${row.pr ? `#${row.pr}` : '—'} |`), '') }
  return lines.join('\n')
}

/** Learnings the harness can track; a human promotes them with `promoteLearnings`. */
export const retroLearnings = (report: RetroReport, markdown: string): readonly LearningRecord[] => parseRetro(markdown, `loop-retro:${report.project}:${report.window.since.slice(0, 10)}`, report.generatedAt)
