import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { loopStatus, type AutomationStatus } from './install.js'
import { runObservability, type ObservabilityReport } from './observability.js'

/** One thing a human has to look at, named stably enough that the same problem twice produces the same signature. */
export interface ObserveProblem { readonly id: string; readonly detail: string }

export interface ObserverState {
  readonly signature: string | null
  readonly firstSeenAt: string | null
  readonly lastNotifiedAt: string | null
}

export interface ObserveStageReport {
  readonly status: 'healthy' | 'action_required'
  /** True when Orca should launch the observer agent: the problem set is new, or unresolved past the reminder window. */
  readonly notify: boolean
  readonly generatedAt: string
  readonly signature: string
  readonly problems: readonly ObserveProblem[]
  readonly firstSeenAt: string | null
  readonly reason: 'healthy' | 'new-problems' | 'reminder' | 'already-notified'
  readonly observability: ObservabilityReport
}

export const observerStatePath = (stateDir: string): string => join(stateDir, 'observer-state.json')

export const readObserverState = (stateDir: string): ObserverState => {
  try {
    const value = JSON.parse(readFileSync(observerStatePath(stateDir), 'utf8')) as Partial<ObserverState>
    return {
      signature: typeof value.signature === 'string' ? value.signature : null,
      firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : null,
      lastNotifiedAt: typeof value.lastNotifiedAt === 'string' ? value.lastNotifiedAt : null,
    }
  } catch { return { signature: null, firstSeenAt: null, lastNotifiedAt: null } }
}

/** Stage locks whose file is older than the threshold: a killed precheck that left its lock behind, not a long run. */
export const staleStageLocks = (stateDir: string, staleLockMin: number, now: Date): readonly string[] => {
  if (!existsSync(stateDir)) return []
  try {
    return readdirSync(stateDir)
      .filter((name) => /^\.stage-.*\.lock$/.test(name))
      .filter((name) => { try { return now.getTime() - statSync(join(stateDir, name)).mtimeMs > staleLockMin * 60_000 } catch { return false } })
      .sort()
  } catch { return [] }
}

export interface ObserveAssessmentInput {
  readonly observability: ObservabilityReport
  readonly automations: readonly AutomationStatus[]
  readonly automationError: string | null
  readonly staleLocks: readonly string[]
  readonly previous: ObserverState
  readonly now: Date
  readonly reminderHours: number
  readonly schedulerStallMin: number
}

export interface ObserveAssessment { readonly report: Omit<ObserveStageReport, 'observability'>; readonly state: ObserverState }

/**
 * Decide whether this scan is worth a human's attention.
 *
 * The signature covers *which* problems are present, never their numeric detail, so a percentage moving by one point
 * is not a new problem. An unresolved set that was already reported stays silent until the reminder window passes —
 * on 2026-09-13 the previous observer fired nine times in two hours over the same three unchanged facts.
 */
export const assessObserveStage = (input: ObserveAssessmentInput): ObserveAssessment => {
  const problems: ObserveProblem[] = []
  for (const anomaly of input.observability.anomalies) {
    if (anomaly.severity !== 'action_required') continue
    problems.push({ id: `anomaly:${anomaly.id}${anomaly.issue ? `:${anomaly.issue}` : ''}`, detail: anomaly.message })
  }
  for (const check of input.observability.failingChecks) problems.push({ id: `check:${check.id}`, detail: check.detail })
  if (input.automationError) problems.push({ id: 'automations:unavailable', detail: input.automationError })
  for (const automation of input.automations) {
    if (!automation.installed) { problems.push({ id: `automation-missing:${automation.name}`, detail: `${automation.name} is declared by the config but does not exist in Orca` }); continue }
    if (!automation.enabled) { problems.push({ id: `automation-disabled:${automation.name}`, detail: `${automation.name} exists but is switched off` }); continue }
    const at = automation.lastRun?.at ? Date.parse(automation.lastRun.at) : null
    if (at !== null && Number.isFinite(at) && input.now.getTime() - at > input.schedulerStallMin * 60_000) {
      problems.push({ id: `automation-stalled:${automation.name}`, detail: `${automation.name} last ran at ${automation.lastRun?.at} — more than ${input.schedulerStallMin} min ago, so the scheduler itself stopped` })
    }
  }
  for (const lock of input.staleLocks) problems.push({ id: `stale-lock:${lock}`, detail: `${lock} is older than the stale-lock threshold; the stage that owned it is gone` })

  const ordered = [...problems].sort((left, right) => left.id.localeCompare(right.id))
  const signature = createHash('sha256').update(JSON.stringify(ordered.map((problem) => problem.id))).digest('hex').slice(0, 16)
  const at = input.now.toISOString()
  if (!ordered.length) {
    return { report: { status: 'healthy', notify: false, generatedAt: at, signature, problems: [], firstSeenAt: null, reason: 'healthy' }, state: { signature: null, firstSeenAt: null, lastNotifiedAt: null } }
  }
  if (input.previous.signature !== signature) {
    return { report: { status: 'action_required', notify: true, generatedAt: at, signature, problems: ordered, firstSeenAt: at, reason: 'new-problems' }, state: { signature, firstSeenAt: at, lastNotifiedAt: at } }
  }
  const lastNotified = input.previous.lastNotifiedAt ? Date.parse(input.previous.lastNotifiedAt) : null
  const overdue = lastNotified === null || !Number.isFinite(lastNotified) || input.now.getTime() - lastNotified > input.reminderHours * 3_600_000
  const firstSeenAt = input.previous.firstSeenAt ?? at
  return overdue
    ? { report: { status: 'action_required', notify: true, generatedAt: at, signature, problems: ordered, firstSeenAt, reason: 'reminder' }, state: { signature, firstSeenAt, lastNotifiedAt: at } }
    : { report: { status: 'action_required', notify: false, generatedAt: at, signature, problems: ordered, firstSeenAt, reason: 'already-notified' }, state: { ...input.previous, signature, firstSeenAt } }
}

/**
 * The `observe` stage: one read-only health scan of the loop, deduplicated against the previous scan.
 *
 * It is the only stage whose exit code carries meaning — 0 asks Orca to launch the observer agent — which is why it
 * belongs in the harness and not in a machine-local script outside any repository.
 */
export const runObserveStage = async (input: { readonly configPath?: string; readonly loaded?: LoadedLoopConfig; readonly runner: CommandRunner; readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly now?: () => Date; readonly persist?: boolean }): Promise<ObserveStageReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const now = (input.now ?? (() => new Date()))()
  const { observer } = loaded.config.schedule
  const observability = await runObservability({ loaded, runner: input.runner, env: input.env, platform: input.platform, since: observer.since, now: () => now })
  let automations: readonly AutomationStatus[] = []
  let automationError: string | null = null
  try { automations = (await loopStatus({ loaded, runner: input.runner })).automations } catch (error) { automationError = error instanceof Error ? error.message.split('\n')[0]! : String(error) }
  const { report, state } = assessObserveStage({
    observability,
    automations,
    automationError,
    staleLocks: staleStageLocks(loaded.stateDir, observer.staleLockMin, now),
    previous: readObserverState(loaded.stateDir),
    now,
    reminderHours: observer.reminderHours,
    schedulerStallMin: observer.schedulerStallMin,
  })
  if (input.persist !== false) writeJsonAtomic(observerStatePath(loaded.stateDir), state)
  return { ...report, observability }
}

export const renderObserveMarkdown = (report: ObserveStageReport): string => {
  const lines = [`# Loop observe — ${report.observability.project}`, '', `_${report.status}_ · ${report.notify ? 'notifying' : 'silent'} (${report.reason}) · signature \`${report.signature}\` · generated ${report.generatedAt.slice(0, 19)}Z`, '']
  if (report.problems.length) { lines.push('## Problems', ''); for (const problem of report.problems) lines.push(`- \`${problem.id}\` — ${problem.detail}`); lines.push('', `First seen: ${report.firstSeenAt ?? 'now'}`, '') } else lines.push('_No problems detected._', '')
  return lines.join('\n')
}
