import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { remainingUsagePercent } from '../adapters/providers.js'
import { orcaTerminalList, orcaWorktrees, type OrcaTerminal, type OrcaWorktree } from '../adapters/orca-cli.js'
import { createDispatchLedger } from '../execution/coordination.js'
import { contractPath } from './contract.js'
import { buildDebriefReport, type DebriefIssueRow } from './debrief.js'
import { deliveryStatePath, listDispatched, readDeliveryState } from './deliver.js'
import { dispatchRecordPath } from './tick.js'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { buildRetroReport, parseSince, readLoopEvents, type LoopEvent } from './retro.js'
import { runLoopDoctor, type LoopDoctorReport } from './doctor.js'

export type ObservabilitySeverity = 'warning' | 'action_required'

export interface ObservabilityAnomaly {
  readonly id: string
  readonly severity: ObservabilitySeverity
  readonly issue: string | null
  readonly message: string
  readonly evidence: Readonly<Record<string, unknown>>
}

export interface ObservabilityMetrics {
  readonly queueReady: number
  readonly freeSlots: number
  readonly runningWorkers: number
  readonly maxAgents: number
  readonly activeClaims: number
  readonly inFlight: number
  readonly held: number
  readonly merged: number
  readonly blocked: number
  readonly fixRounds: number
  readonly reviewFindings: number
  readonly reviewIncomplete: number
  readonly medianLeadTimeMin: number | null
  readonly providerRemainingPercent: Readonly<Record<string, number | null>>
  readonly machine: { readonly cpuCount: number; readonly load1PerCpuPercent: number; readonly memoryUsedPercent: number; readonly freeRamGb: number }
  readonly memory: { readonly recalls: number; readonly hits: number; readonly approxCharsSaved: number }
  readonly cache: { readonly cachedContracts: number }
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly events: Readonly<Record<string, number>>
}

export interface ObservabilityReport {
  readonly status: 'healthy' | 'action_required'
  readonly generatedAt: string
  readonly project: string
  readonly person: string
  readonly windowHours: number
  readonly anomalies: readonly ObservabilityAnomaly[]
  readonly metrics: ObservabilityMetrics
}

export interface ObservabilityTerminal {
  readonly handle: string
  readonly status: string
  readonly worktreeId: string | null
  readonly lastOutputAt: number | null
  readonly preview: string
}

export interface ObservabilitySnapshot {
  readonly generatedAt: string
  readonly project: string
  readonly person: string
  readonly windowHours: number
  readonly workerIdleTimeoutMin: number
  readonly queueReady: number
  readonly freeSlots: number
  /** A scheduled loop stage currently owns the coordination lock. */
  readonly stageBusy?: boolean
  readonly runningWorkers: number
  readonly maxAgents: number
  readonly activeClaims: number
  readonly missingDeliveryIssues: readonly string[]
  readonly terminals: readonly ObservabilityTerminal[]
  readonly finalizedDirtyWorktrees: readonly { readonly worktreeId: string; readonly issue: string | null; readonly files: number }[]
  readonly issues: readonly Pick<DebriefIssueRow, 'issue' | 'phase' | 'ageMin' | 'heldFor'>[]
  readonly events: readonly LoopEvent[]
  readonly merged: number
  readonly blocked: number
  readonly fixRounds: number
  readonly reviewFindings: number
  readonly reviewIncomplete: number
  readonly medianLeadTimeMin: number | null
  readonly providerRemainingPercent: Readonly<Record<string, number | null>>
  readonly machine: ObservabilityMetrics['machine']
  readonly memory: ObservabilityMetrics['memory']
  readonly cache: ObservabilityMetrics['cache']
  readonly tokens: ObservabilityMetrics['tokens']
}

const connectedStatuses = new Set(['connected', 'running', 'active', 'idle'])
const stalledPhases = new Set(['waiting-for-pr', 'awaiting-review', 'review-incomplete', 'fix-round'])
const heldRow = (row: Pick<DebriefIssueRow, 'phase' | 'heldFor'>): boolean => Boolean(row.heldFor) || row.phase === 'held' || row.phase === 'held-incomplete-review'
const count = (events: readonly LoopEvent[], type: string): number => events.filter((event) => event.type === type).length
const sum = (events: readonly LoopEvent[], key: string): number => events.reduce((total, event) => total + (typeof event[key] === 'number' && Number.isFinite(event[key]) ? Number(event[key]) : 0), 0)
const uniqueIssues = (events: readonly LoopEvent[], types: readonly string[]): number => new Set(events.filter((event) => types.includes(event.type) && typeof event.issue === 'string').map((event) => event.issue)).size

/** Pure, deterministic anomaly assessment. No network calls or writes. */
export const assessObservability = (input: ObservabilitySnapshot): ObservabilityReport => {
  const anomalies: ObservabilityAnomaly[] = []
  for (const issue of input.missingDeliveryIssues) anomalies.push({ id: 'claim-without-delivery', severity: 'action_required', issue, message: `${issue} has an active claim but no delivery.json`, evidence: { issue } })
  for (const terminal of input.terminals) {
    if (terminal.worktreeId && connectedStatuses.has(terminal.status.toLowerCase()) && terminal.lastOutputAt === null && !terminal.preview.trim()) anomalies.push({ id: 'connected-without-output', severity: 'warning', issue: null, message: `terminal ${terminal.handle} is connected but has not emitted output`, evidence: { handle: terminal.handle, worktreeId: terminal.worktreeId, status: terminal.status } })
  }
  for (const worktree of input.finalizedDirtyWorktrees) anomalies.push({ id: 'finalized-dirty-worktree', severity: 'action_required', issue: worktree.issue, message: `finalized worktree ${worktree.worktreeId} still has ${worktree.files} uncommitted file(s)`, evidence: { ...worktree } })
  const latestDispatch = input.events.filter((event) => event.type === 'worker.dispatched').map((event) => Date.parse(event.at)).filter(Number.isFinite).sort((a, b) => b - a)[0]
  const quietForMin = latestDispatch === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.round((Date.parse(input.generatedAt) - latestDispatch) / 60_000))
  if (!input.stageBusy && input.queueReady > 0 && input.freeSlots > 0 && quietForMin >= 15) anomalies.push({ id: 'queue-ready-no-dispatch', severity: 'action_required', issue: null, message: `${input.queueReady} ready issue(s) and ${input.freeSlots} free slot(s), but no dispatch in ${Number.isFinite(quietForMin) ? `${quietForMin} min` : 'the observation window'}`, evidence: { queueReady: input.queueReady, freeSlots: input.freeSlots, quietForMin } })
  for (const row of input.issues) {
    if (row.heldFor || !stalledPhases.has(row.phase) || row.ageMin === null || row.ageMin < input.workerIdleTimeoutMin) continue
    anomalies.push({ id: 'stalled-delivery', severity: 'action_required', issue: row.issue, message: `${row.issue} is in ${row.phase} for ${row.ageMin} min (threshold ${input.workerIdleTimeoutMin} min)`, evidence: { issue: row.issue, phase: row.phase, ageMin: row.ageMin, thresholdMin: input.workerIdleTimeoutMin } })
  }
  const events: Record<string, number> = {}
  for (const event of input.events) events[event.type] = (events[event.type] ?? 0) + 1
  const report: ObservabilityReport = {
    status: anomalies.some((item) => item.severity === 'action_required') ? 'action_required' : 'healthy',
    generatedAt: input.generatedAt,
    project: input.project,
    person: input.person,
    windowHours: input.windowHours,
    anomalies,
    metrics: {
      queueReady: input.queueReady, freeSlots: input.freeSlots, runningWorkers: input.runningWorkers, maxAgents: input.maxAgents,
      activeClaims: input.activeClaims, inFlight: input.issues.filter((row) => !heldRow(row)).length, held: input.issues.filter(heldRow).length,
      merged: input.merged, blocked: input.blocked, fixRounds: input.fixRounds, reviewFindings: input.reviewFindings, reviewIncomplete: input.reviewIncomplete,
      medianLeadTimeMin: input.medianLeadTimeMin, providerRemainingPercent: input.providerRemainingPercent, machine: input.machine, memory: input.memory, cache: input.cache, tokens: input.tokens, events,
    },
  }
  return report
}

const compactTerminal = (terminal: OrcaTerminal): ObservabilityTerminal => ({ handle: terminal.handle, status: terminal.status, worktreeId: terminal.worktreeId, lastOutputAt: terminal.lastOutputAt, preview: terminal.preview })

const dirtyFinalizedWorktrees = async (runner: CommandRunner, worktrees: readonly OrcaWorktree[]): Promise<readonly ObservabilitySnapshot['finalizedDirtyWorktrees'][number][]> => {
  const out: ObservabilitySnapshot['finalizedDirtyWorktrees'][number][] = []
  for (const worktree of worktrees) {
    if (worktree.workspaceStatus.trim().toLowerCase() !== 'completed' || !worktree.path) continue
    try {
      const result = await runner.run(['git', '-C', worktree.path, 'status', '--porcelain'], { timeoutMs: 10_000 })
      if (result.code === 0 && result.stdout.trim()) out.push({ worktreeId: worktree.id, issue: worktree.linkedLinearIssue, files: result.stdout.trim().split(/\r?\n/).length })
    } catch { /* observability is best effort; doctor remains the transport health gate */ }
  }
  return out
}

/** Collect current read-only state from the existing doctor, debrief and event log. */
export const runObservability = async (input: { readonly configPath?: string; readonly loaded?: LoadedLoopConfig; readonly runner: CommandRunner; readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly since?: string; readonly now?: () => Date }): Promise<ObservabilityReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath ?? 'loop.config.yaml')
  const now = input.now ?? (() => new Date())
  const at = now()
  const since = parseSince(input.since ?? '24h', at)
  const [doctor, debrief, worktrees, terminals] = await Promise.all([
    runLoopDoctor({ loaded, runner: input.runner, env: input.env, platform: input.platform, now: () => at, probe: false }),
    Promise.resolve(buildDebriefReport({ loaded, since: input.since ?? '24h', now: () => at })),
    orcaWorktrees(input.runner, { bin: loaded.config.orca.bin, timeoutMs: loaded.config.orca.timeoutMs }).catch(() => [] as readonly OrcaWorktree[]),
    orcaTerminalList(input.runner, {}, { bin: loaded.config.orca.bin, timeoutMs: loaded.config.orca.timeoutMs }).catch(() => [] as readonly OrcaTerminal[]),
  ])
  const events = readLoopEvents(loaded.stateDir).filter((event) => Date.parse(event.at) >= since.getTime() && Date.parse(event.at) <= at.getTime())
  const ledger = createDispatchLedger(loaded.stateDir)
  const active = ledger.active()
  // A dispatch claim legitimately exists before the first delivery pass writes
  // delivery.json. Flag only the unrecoverable case: a claim with neither the
  // dispatch record nor delivery state. This avoids treating healthy workers
  // waiting for their first PR as a production incident.
  const missingDeliveryIssues = active
    .filter((lease) => !existsSync(deliveryStatePath(loaded.stateDir, lease.issue)) && !existsSync(dispatchRecordPath(loaded.stateDir, lease.issue)))
    .map((lease) => lease.issue)
  const records = listDispatched(loaded.stateDir)
  const stageBusy = existsSync(join(loaded.stateDir, '.stage-tick.lock')) || existsSync(join(loaded.stateDir, '.stage-deliver.lock'))
  const completed = records.map((record) => ({ record, state: readDeliveryState(loaded.stateDir, record.issue) })).filter(({ state }) => state.finishedAt && Date.parse(state.finishedAt) >= since.getTime())
  const leadTimes = completed.map(({ record, state }) => (state.finishedAt ? (Date.parse(state.finishedAt) - Date.parse(record.dispatchedAt)) / 60_000 : null)).filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b)
  const medianLeadTimeMin = leadTimes.length ? leadTimes.length % 2 ? leadTimes[Math.floor(leadTimes.length / 2)]! : (leadTimes[leadTimes.length / 2 - 1]! + leadTimes[leadTimes.length / 2]!) / 2 : null
  const providerRemainingPercent = Object.fromEntries(doctor.providers.map((provider) => [provider.id, remainingUsagePercent(provider.usage, loaded.config.models.routing.usageMetric)]))
  const cachedContracts = records.filter((record) => existsSync(contractPath(loaded.stateDir, record.issue))).length
  const memoryEvents = events.filter((event) => event.type === 'memory.recalled')
  const tokens = { input: sum(events, 'inputTokens'), output: sum(events, 'outputTokens'), total: sum(events, 'totalTokens'), cacheRead: sum(events, 'cacheReadTokens'), cacheWrite: sum(events, 'cacheWriteTokens') }
  const machine = { cpuCount: doctor.machine.sample.cpus, load1PerCpuPercent: doctor.machine.sample.load1PerCpuPercent, memoryUsedPercent: doctor.machine.sample.memoryUsedPercent, freeRamGb: doctor.machine.freeRamGb }
  const snapshot: ObservabilitySnapshot = {
    generatedAt: at.toISOString(), project: doctor.config.project, person: doctor.config.person, windowHours: Math.max(1, Math.round((at.getTime() - since.getTime()) / 3_600_000)), workerIdleTimeoutMin: loaded.config.delivery.workerIdleTimeoutMin,
    queueReady: doctor.queue.count, freeSlots: doctor.machine.free, stageBusy, runningWorkers: doctor.workers.running, maxAgents: doctor.machine.maxAgents, activeClaims: active.length, missingDeliveryIssues,
    terminals: terminals.map(compactTerminal), finalizedDirtyWorktrees: await dirtyFinalizedWorktrees(input.runner, worktrees), issues: debrief.inFlight.map(({ issue, phase, ageMin, heldFor }) => ({ issue, phase, ageMin, heldFor })), events,
    merged: uniqueIssues(events, ['pr.merged', 'worker.merged']), blocked: Math.max(records.filter((record) => readDeliveryState(loaded.stateDir, record.issue).finalOutcome === 'blocked').length, uniqueIssues(events, ['worker.blocked'])), fixRounds: records.reduce((total, record) => total + readDeliveryState(loaded.stateDir, record.issue).fixRounds, 0),
    reviewFindings: count(events, 'pr.reviewed') - count(events.filter((event) => event['status'] !== 'findings'), 'pr.reviewed'), reviewIncomplete: events.filter((event) => event.type === 'pr.reviewed' && event['status'] === 'incomplete').length,
    medianLeadTimeMin, providerRemainingPercent, machine, memory: { recalls: memoryEvents.length, hits: sum(memoryEvents, 'hits'), approxCharsSaved: sum(memoryEvents, 'approxCharsSaved') }, cache: { cachedContracts }, tokens,
  }
  return assessObservability(snapshot)
}

export const renderObservabilityMarkdown = (report: ObservabilityReport): string => {
  const m = report.metrics
  const headroom = Object.entries(m.providerRemainingPercent).map(([provider, remaining]) => `${provider} ${remaining === null ? '?' : `${remaining}%`}`).join(', ')
  const lines = [`# Loop observability — ${report.project} · ${report.person}`, '', `_${report.status}_ · generated ${report.generatedAt.slice(0, 19)}Z · last ${report.windowHours}h`, '', '## Metrics', '', `- Queue: ${m.queueReady} ready · ${m.freeSlots} free slot(s) · ${m.runningWorkers}/${m.maxAgents} workers`, `- Delivery: ${m.inFlight} in flight · ${m.held} held · ${m.merged} merged · ${m.blocked} blocked · ${m.fixRounds} fix round(s)`, `- Reviews: ${m.reviewFindings} findings · ${m.reviewIncomplete} incomplete`, `- Machine: ${m.machine.cpuCount} CPU · ${m.machine.load1PerCpuPercent}% load · ${m.machine.memoryUsedPercent}% memory · ${m.machine.freeRamGb} GB free`, `- Providers: ${headroom || 'n/a'}`, `- Memory/cache: ${m.memory.recalls} recall(s), ${m.memory.hits} hit(s), ${m.memory.approxCharsSaved} chars saved · ${m.cache.cachedContracts} cached contract(s)`, `- Tokens observed: ${m.tokens.total || (m.tokens.input + m.tokens.output) || 'n/a'}`, '']
  if (report.anomalies.length) { lines.push('## Anomalies', ''); for (const anomaly of report.anomalies) lines.push(`- **${anomaly.severity}**${anomaly.issue ? ` · ${anomaly.issue}` : ''}: ${anomaly.message}`); lines.push('') } else lines.push('## Anomalies', '', '_None detected._', '')
  lines.push('_Read-only. Run `ak-harness loop tick` or `deliver` to act on the queue._')
  return lines.join('\n')
}
