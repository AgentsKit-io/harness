import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { hashJson } from '../kernel/hash.js'
import { resolveConnectors, type TrackerConnector } from './connectors.js'
import type { LoadedLoopConfig, LoopConfig } from './config.js'
import { untrusted } from './contract.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { appendLoopEvent } from './tick.js'

export const AlertSchema = z.object({
  /** The source's own id, when it has one. Without it the fingerprint comes from the title. */
  id: z.string().trim().optional(),
  title: z.string().trim().min(1),
  body: z.string().trim().default(''),
  severity: z.string().trim().default(''),
  url: z.string().trim().default(''),
  count: z.number().int().positive().optional(),
})
export type Alert = z.infer<typeof AlertSchema>

export interface FiledRecord { readonly fingerprint: string; readonly at: string; readonly issue: string | null; readonly source: string; readonly title: string }
export interface IntakeState { readonly filed: readonly FiledRecord[] }

export const intakeStatePath = (stateDir: string): string => join(stateDir, 'intake.json')

export const readIntakeState = (stateDir: string): IntakeState => {
  const path = intakeStatePath(stateDir)
  if (!existsSync(path)) return { filed: [] }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<IntakeState>
    return { filed: Array.isArray(value.filed) ? value.filed : [] }
  } catch { return { filed: [] } }
}

/** Same source, same alert identity — not the same numbers. A count going from 11 to 12 is not a new incident. */
export const fingerprintOf = (source: string, alert: Alert): string => hashJson({ source, key: alert.id ?? alert.title }).slice(0, 16)

export const alreadyFiled = (state: IntakeState, fingerprint: string, windowHours: number, now: Date): FiledRecord | null =>
  state.filed.find((record) => record.fingerprint === fingerprint && now.getTime() - Date.parse(record.at) < windowHours * 3_600_000) ?? null

/** windowed: `intake` and `maintain` share this store; a record older than the longer of their two dedupe windows
 * can never again match in `alreadyFiled`, so it is dead weight `filed` would otherwise carry forever. */
const prunedFiled = (filed: readonly FiledRecord[], config: LoopConfig, now: Date): readonly FiledRecord[] => {
  const windowMs = Math.max(config.intake.dedupeWindowHours, config.maintain.dedupeWindowHours) * 3_600_000
  return filed.filter((record) => now.getTime() - Date.parse(record.at) < windowMs)
}

export const parseAlerts = (stdout: string): readonly Alert[] => {
  let parsed: unknown
  try { parsed = JSON.parse(stdout.trim() || '[]') } catch { return [] }
  const list = Array.isArray(parsed) ? parsed : []
  return list.flatMap((entry) => { const result = AlertSchema.safeParse(entry); return result.success ? [result.data] : [] })
}

/** The issue body: what happened, where it came from, and the evidence — treated as data, never as instructions. */
export const renderAlertIssue = (source: string, alert: Alert, fingerprint: string): string => [
  alert.body ? untrusted(`intake:${source}`, alert.body) : '_No detail reported._',
  '',
  `**Source**: \`${source}\`${alert.severity ? ` · severity \`${alert.severity}\`` : ''}${alert.count ? ` · seen ${alert.count}×` : ''}`,
  alert.url ? `**Evidence**: ${alert.url}` : '',
  '',
  `<!-- loop:intake:${fingerprint} -->`,
].filter(Boolean).join('\n')

export const flowLabelFor = (config: LoopConfig, alert: Alert): string | null => {
  const flow = config.intake.flowBySeverity[alert.severity.toLowerCase()]
  return flow ? `flow:${flow}` : null
}

export interface IntakeResult { readonly source: string; readonly title: string; readonly outcome: 'filed' | 'duplicate' | 'failed'; readonly issue?: string | null; readonly detail?: string }
export interface IntakeReport { readonly status: 'ok' | 'idle' | 'failed'; readonly results: readonly IntakeResult[]; readonly notes: readonly string[] }

/**
 * Read every declared source, file what is new, and say plainly what it skipped.
 *
 * Deduplication is the whole point: an alert that fires every minute must produce one issue, not one per minute.
 * The issue lands in the queue's entry state like any other — `Todo → Ready` stays a human gesture, except where
 * the severity maps to a flow the project decided may start on its own.
 */
export const runIntakeStage = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly tracker?: TrackerConnector; readonly now?: () => Date; readonly dryRun?: boolean }): Promise<IntakeReport> => {
  const { loaded } = input
  const { config } = loaded
  const now = (input.now ?? (() => new Date()))()
  if (!config.intake.enabled) return { status: 'idle', results: [], notes: ['intake.enabled is false'] }
  if (!config.intake.sources.length) return { status: 'idle', results: [], notes: ['no intake.sources declared'] }
  const tracker = input.tracker ?? resolveConnectors({ runner: input.runner, config, dryRun: input.dryRun ?? false }).tracker
  const state = readIntakeState(loaded.stateDir)
  const filed = [...state.filed]
  const results: IntakeResult[] = []
  const notes: string[] = []
  let created = 0

  for (const source of config.intake.sources) {
    let alerts: readonly Alert[] = []
    try {
      const outcome = await input.runner.run(source.command, { timeoutMs: source.timeoutSec * 1000, cwd: loaded.root })
      if (outcome.code !== 0) { notes.push(`${source.id}: exited ${outcome.code ?? 'null'}: ${(outcome.stderr || outcome.stdout).trim().slice(0, 200)}`); continue }
      alerts = parseAlerts(outcome.stdout)
    } catch (error) { notes.push(`${source.id}: ${error instanceof Error ? error.message : String(error)}`); continue }

    for (const alert of alerts) {
      if (created >= config.intake.maxPerRun) { notes.push(`stopped at intake.maxPerRun (${config.intake.maxPerRun})`); break }
      const fingerprint = fingerprintOf(source.id, alert)
      const previous = alreadyFiled({ filed }, fingerprint, config.intake.dedupeWindowHours, now)
      if (previous) { results.push({ source: source.id, title: alert.title, outcome: 'duplicate', issue: previous.issue, detail: `already filed at ${previous.at}` }); continue }
      if (input.dryRun) { results.push({ source: source.id, title: alert.title, outcome: 'filed', issue: null, detail: 'dry-run' }); created += 1; continue }
      try {
        const flowLabel = flowLabelFor(config, alert)
        const issue = await tracker.createIssue({
          title: alert.title,
          description: renderAlertIssue(source.id, alert, fingerprint),
          state: config.linear.states[0] ?? 'Todo',
          labels: [...config.intake.labels, ...source.labels, ...(flowLabel ? [flowLabel] : [])],
          dedupeKey: `intake:${fingerprint}`,
        })
        filed.push({ fingerprint, at: now.toISOString(), issue: issue.identifier, source: source.id, title: alert.title })
        results.push({ source: source.id, title: alert.title, outcome: 'filed', issue: issue.identifier })
        appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'intake.filed', issue: issue.identifier, source: source.id, fingerprint, severity: alert.severity })
        created += 1
      } catch (error) { results.push({ source: source.id, title: alert.title, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
  }

  if (!input.dryRun && filed.length !== state.filed.length) writeJsonAtomic(intakeStatePath(loaded.stateDir), { filed: prunedFiled(filed, config, now) })
  return { status: results.some((result) => result.outcome === 'failed') ? 'failed' : results.length ? 'ok' : 'idle', results, notes }
}

export interface MaintainResult { readonly check: string; readonly outcome: 'filed' | 'clean' | 'duplicate' | 'failed'; readonly issue?: string | null; readonly detail?: string }
export interface MaintainReport { readonly status: 'ok' | 'idle' | 'failed'; readonly results: readonly MaintainResult[] }

/**
 * Dependencies, security and licences on a schedule — inside the loop, under the same Definition of Done.
 *
 * A check with nothing to decide files nothing: that is the difference between this and a bot that opens a pull
 * request every morning. What it files is a decision, with the command's own output as the evidence.
 */
export const runMaintainStage = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly tracker?: TrackerConnector; readonly now?: () => Date; readonly dryRun?: boolean }): Promise<MaintainReport> => {
  const { loaded } = input
  const { config } = loaded
  const now = (input.now ?? (() => new Date()))()
  if (!config.maintain.enabled || !config.maintain.checks.length) return { status: 'idle', results: [] }
  const tracker = input.tracker ?? resolveConnectors({ runner: input.runner, config, dryRun: input.dryRun ?? false }).tracker
  const state = readIntakeState(loaded.stateDir)
  const filed = [...state.filed]
  const results: MaintainResult[] = []

  for (const check of config.maintain.checks) {
    let output = ''
    let failed = false
    try {
      const outcome = await input.runner.run(check.command, { timeoutMs: check.timeoutSec * 1000, cwd: loaded.root })
      output = `${outcome.stdout}\n${outcome.stderr}`.trim()
      failed = outcome.code !== 0
    } catch (error) { results.push({ check: check.id, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }); continue }

    const decides = check.fileWhen === 'output' ? output.length > 0 : failed
    if (!decides) { results.push({ check: check.id, outcome: 'clean' }); continue }
    // The fingerprint covers the finding, not the run: the same unresolved advisory must not file a new issue daily.
    const fingerprint = hashJson({ check: check.id, output: output.slice(0, 2_000) }).slice(0, 16)
    const previous = alreadyFiled({ filed }, fingerprint, config.maintain.dedupeWindowHours, now)
    if (previous) { results.push({ check: check.id, outcome: 'duplicate', issue: previous.issue }); continue }
    if (input.dryRun) { results.push({ check: check.id, outcome: 'filed', issue: null, detail: 'dry-run' }); continue }
    try {
      const issue = await tracker.createIssue({
        title: check.title,
        description: `\`${check.command.join(' ')}\` reported something that needs a decision.\n\n\`\`\`\n${output.slice(0, 4_000)}\n\`\`\`\n\n<!-- loop:maintain:${fingerprint} -->`,
        state: config.linear.states[0] ?? 'Todo',
        labels: check.labels,
        dedupeKey: `maintain:${fingerprint}`,
      })
      filed.push({ fingerprint, at: now.toISOString(), issue: issue.identifier, source: `maintain:${check.id}`, title: check.title })
      results.push({ check: check.id, outcome: 'filed', issue: issue.identifier })
      appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'maintain.filed', issue: issue.identifier, check: check.id, fingerprint })
    } catch (error) { results.push({ check: check.id, outcome: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  }

  if (!input.dryRun && filed.length !== state.filed.length) writeJsonAtomic(intakeStatePath(loaded.stateDir), { filed: prunedFiled(filed, config, now) })
  return { status: results.some((result) => result.outcome === 'failed') ? 'failed' : results.some((result) => result.outcome === 'filed') ? 'ok' : 'idle', results }
}
