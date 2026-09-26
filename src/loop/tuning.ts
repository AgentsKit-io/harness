import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import type { CommandRunner } from '../adapters/command.js'
import { fail } from '../kernel/errors.js'
import { LoopConfigSchema, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { RetroReport } from './retro.js'

export type TuningKnob = LoopConfig['tuning']['knobs'][number]
export type TuningMetric = TuningKnob['metric']

/** What one knob is worth right now, and which direction is better. */
export interface MetricReading { readonly metric: TuningMetric; readonly value: number; readonly betterWhen: 'lower' }

export interface TuningRecord {
  readonly path: string
  readonly metric: TuningMetric
  readonly from: string | number
  readonly to: string | number
  readonly at: string
  readonly reason: string
  /** The metric at the moment of the change — the number the next cycle is compared against. */
  readonly metricBefore: number
  readonly evidence: Readonly<Record<string, unknown>>
  readonly status: 'applied' | 'reverted'
  /** Set on the revert: the reading that undid the change. */
  readonly metricAfter?: number
}

export interface TuningState { readonly history: readonly TuningRecord[]; readonly frozen: readonly string[] }

export const tuningStatePath = (stateDir: string): string => join(stateDir, 'tuning.json')

export const readTuningState = (stateDir: string): TuningState => {
  try {
    const value = JSON.parse(readFileSync(tuningStatePath(stateDir), 'utf8')) as Partial<TuningState>
    return { history: Array.isArray(value.history) ? value.history as TuningRecord[] : [], frozen: Array.isArray(value.frozen) ? value.frozen.filter((path): path is string => typeof path === 'string') : [] }
  } catch { return { history: [], frozen: [] } }
}

/** Every metric the tuner understands, read from one retro report. Lower is better for all of them, by construction. */
export const readMetrics = (report: RetroReport): Readonly<Record<TuningMetric, number>> => {
  const reviews = report.delivery.reviewsClean + report.delivery.reviewsFindings + report.delivery.reviewsIncomplete
  return {
    'review-findings-ratio': reviews ? report.delivery.reviewsFindings / reviews : 0,
    'stuck-count': report.delivery.stuck + report.delivery.abandoned,
    'fix-rounds-per-merge': report.delivery.merged ? report.delivery.fixRounds / report.delivery.merged : report.delivery.fixRounds,
    'escalation-count': report.escalations.total,
  }
}

const readPath = (config: LoopConfig, path: string): unknown => path.split('.').reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), config)

/**
 * The next value for a knob, or `null` when it should not move.
 *
 * The rule is the same for every metric because every metric is "lower is better": a metric that is not zero says
 * the current setting is not paying off, so the knob moves one step towards stricter/more patient. A metric at
 * zero leaves it alone — there is nothing to fix, and a loop that keeps tightening a healthy knob is a loop that
 * eventually stops merging anything.
 */
export const nextValue = (knob: TuningKnob, current: unknown, reading: number): string | number | null => {
  if (reading <= 0) return null
  if (knob.values) {
    const index = knob.values.findIndex((value) => value === current)
    if (index < 0 || index >= knob.values.length - 1) return null
    return knob.values[index + 1] ?? null
  }
  if (typeof current !== 'number' || knob.step === undefined) return null
  const max = knob.max ?? Number.POSITIVE_INFINITY
  const min = knob.min ?? Number.NEGATIVE_INFINITY
  const candidate = Math.min(max, Math.max(min, current + knob.step))
  return candidate === current ? null : candidate
}

export interface TuningDecision {
  readonly path: string
  readonly action: 'change' | 'revert' | 'hold'
  readonly from: string | number
  readonly to: string | number
  readonly metric: TuningMetric
  readonly metricBefore: number
  readonly metricNow: number
  readonly reason: string
}

/**
 * Decide what the retro may change this cycle, without touching anything.
 *
 * A change made last cycle is judged first: if its metric got worse, it is undone and that knob is frozen, because
 * a knob that oscillates is worse than a knob nobody tuned. Only then may a new change be proposed, at most
 * `maxChangesPerRetro` of them.
 */
export const planTuning = (config: LoopConfig, report: RetroReport, state: TuningState): readonly TuningDecision[] => {
  if (!config.tuning.enabled) return []
  const metrics = readMetrics(report)
  const decisions: TuningDecision[] = []
  const frozen = new Set(state.frozen)
  const lastApplied = new Map<string, TuningRecord>()
  for (const record of state.history) if (record.status === 'applied') lastApplied.set(record.path, record)

  for (const knob of config.tuning.knobs) {
    if (frozen.has(knob.path)) continue
    const current = readPath(config, knob.path)
    if (current === undefined) continue
    const now = metrics[knob.metric]
    const previous = lastApplied.get(knob.path)
    if (previous && previous.to === current) {
      if (now > previous.metricBefore) {
        decisions.push({ path: knob.path, action: 'revert', from: current as string | number, to: previous.from, metric: knob.metric, metricBefore: previous.metricBefore, metricNow: now, reason: `${knob.metric} worsened from ${previous.metricBefore} to ${now} after the last change` })
        frozen.add(knob.path)
        continue
      }
      // It helped or made no difference: leave it where it is and stop tuning this knob this cycle.
      decisions.push({ path: knob.path, action: 'hold', from: current as string | number, to: current as string | number, metric: knob.metric, metricBefore: previous.metricBefore, metricNow: now, reason: `${knob.metric} did not worsen (${previous.metricBefore} → ${now})` })
      continue
    }
    const next = nextValue(knob, current, now)
    if (next === null) continue
    decisions.push({ path: knob.path, action: 'change', from: current as string | number, to: next, metric: knob.metric, metricBefore: now, metricNow: now, reason: `${knob.metric} is ${now}` })
  }
  const changes = decisions.filter((decision) => decision.action === 'change').slice(0, config.tuning.maxChangesPerRetro)
  return [...decisions.filter((decision) => decision.action !== 'change'), ...changes]
}

/** Write one value into the project's YAML in place, keeping every comment and every other line untouched. */
export const applyToYaml = (text: string, path: string, value: string | number): string => {
  const document = parseDocument(text)
  const keys = path.split('.')
  if (document.getIn(keys) === undefined) fail(`tuning: ${path} does not exist in this config file; declare it before it can be tuned.`, 'INVALID_CONFIG')
  document.setIn(keys, value)
  return document.toString()
}

export interface TuningResult { readonly decisions: readonly TuningDecision[]; readonly applied: readonly TuningDecision[]; readonly committed: boolean; readonly notes: readonly string[] }

/**
 * Apply the plan to `loop.config.yaml`, record it, and (when asked) commit it with the reason and the evidence.
 *
 * The edited file is validated before it is kept: a knob range that produces an invalid config must fail here,
 * not on the next scheduled run of a loop nobody is watching.
 */
export const applyTuning = async (input: {
  readonly loaded: LoadedLoopConfig
  readonly report: RetroReport
  readonly runner?: CommandRunner
  readonly now?: () => Date
  readonly dryRun?: boolean
}): Promise<TuningResult> => {
  const { loaded } = input
  const now = (input.now ?? (() => new Date()))()
  const state = readTuningState(loaded.stateDir)
  const decisions = planTuning(loaded.config, input.report, state)
  const actionable = decisions.filter((decision) => decision.action !== 'hold')
  const notes: string[] = []
  if (!actionable.length || input.dryRun) return { decisions, applied: [], committed: false, notes: input.dryRun && actionable.length ? ['dry-run: nothing written'] : [] }

  let text = existsSync(loaded.path) ? readFileSync(loaded.path, 'utf8') : fail(`tuning: ${loaded.path} is not readable`, 'INVALID_CONFIG')
  const applied: TuningDecision[] = []
  for (const decision of actionable) {
    try { text = applyToYaml(text, decision.path, decision.to); applied.push(decision) } catch (error) { notes.push(`${decision.path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (!applied.length) return { decisions, applied: [], committed: false, notes }

  const parsed = LoopConfigSchema.safeParse(parseDocument(text).toJS() as unknown)
  if (!parsed.success) return { decisions, applied: [], committed: false, notes: [...notes, `tuning produced an invalid config and was discarded: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`] }
  writeFileSync(loaded.path, text, 'utf8')

  const records: TuningRecord[] = applied.map((decision) => ({
    path: decision.path, metric: decision.metric, from: decision.from, to: decision.to, at: now.toISOString(),
    reason: decision.reason, metricBefore: decision.metricBefore,
    evidence: { window: input.report.window, delivery: input.report.delivery, escalations: input.report.escalations.total, digest: input.report.digest },
    status: decision.action === 'revert' ? 'reverted' : 'applied',
    ...(decision.action === 'revert' ? { metricAfter: decision.metricNow } : {}),
  }))
  const frozen = [...new Set([...state.frozen, ...applied.filter((decision) => decision.action === 'revert').map((decision) => decision.path)])]
  // windowed: planTuning only ever reads the newest record per knob path (line ~101), so that is all persisting
  // needs to keep — without this, history grows one entry per retro cycle forever and is fully re-scanned each time.
  const latestByPath = new Map<string, TuningRecord>()
  for (const record of [...state.history, ...records]) latestByPath.set(record.path, record)
  writeJsonAtomic(tuningStatePath(loaded.stateDir), { history: [...latestByPath.values()], frozen })

  let committed = false
  if (loaded.config.tuning.commit && input.runner) {
    const summary = applied.map((decision) => `${decision.path} ${decision.from} → ${decision.to}`).join(', ')
    const body = applied.map((decision) => `- ${decision.path}: ${decision.reason} (evidence: ${input.report.digest})`).join('\n')
    try {
      const add = await input.runner.run(['git', '-C', loaded.root, 'add', loaded.path], { timeoutMs: 15_000 })
      if (add.code !== 0) throw new Error(add.stderr.trim() || `git add exited ${add.code ?? 'null'}`)
      const commit = await input.runner.run(['git', '-C', loaded.root, 'commit', '-m', `chore(loop): tune ${summary}`, '-m', body], { timeoutMs: 30_000 })
      if (commit.code !== 0) throw new Error(commit.stderr.trim() || `git commit exited ${commit.code ?? 'null'}`)
      committed = true
    } catch (error) { notes.push(`tuning commit failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { decisions, applied, committed, notes }
}

export const renderTuningMarkdown = (result: TuningResult): string => {
  if (!result.decisions.length) return ''
  const lines = ['', '## Tuning', '']
  for (const decision of result.decisions) {
    if (decision.action === 'hold') { lines.push(`- \`${decision.path}\` held at \`${decision.to}\` — ${decision.reason}`); continue }
    const done = result.applied.some((item) => item.path === decision.path)
    lines.push(`- ${decision.action === 'revert' ? '**reverted**' : '**changed**'} \`${decision.path}\`: \`${decision.from}\` → \`${decision.to}\` — ${decision.reason}${done ? '' : ' (not written)'}`)
  }
  if (result.committed) lines.push('', '_Committed to `loop.config.yaml`._')
  for (const note of result.notes) lines.push(`- _${note}_`)
  return lines.join('\n')
}

/** Freeze or unfreeze one knob: a frozen knob is skipped by every future retro until a human unfreezes it. */
export const setTuningFrozen = (stateDir: string, path: string, frozen: boolean): TuningState => {
  const state = readTuningState(stateDir)
  const next = { history: state.history, frozen: frozen ? [...new Set([...state.frozen, path])] : state.frozen.filter((item) => item !== path) }
  writeJsonAtomic(tuningStatePath(stateDir), next)
  return next
}

/**
 * A human undoes the tuner's last change to `path`: the pre-tuning value goes back into `loop.config.yaml` the same
 * way the tuner wrote it (in place, validated before it is kept), the revert is recorded, and the knob is frozen.
 */
export const revertTuning = (loaded: LoadedLoopConfig, path: string, now: Date = new Date()): TuningRecord => {
  const state = readTuningState(loaded.stateDir)
  const last = [...state.history].reverse().find((record) => record.path === path)
  if (!last || last.status !== 'applied') return fail(`tuning: ${path} has no applied change to revert.`, 'INVALID_INPUT')
  const text = applyToYaml(readFileSync(loaded.path, 'utf8'), path, last.from)
  const parsed = LoopConfigSchema.safeParse(parseDocument(text).toJS() as unknown)
  if (!parsed.success) return fail(`tuning: reverting ${path} produced an invalid config: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, 'INVALID_CONFIG')
  writeFileSync(loaded.path, text, 'utf8')
  // ponytail: no commit here even with tuning.commit; the UI leaves the reverted loop.config.yaml for the human to commit.
  const record: TuningRecord = { ...last, from: last.to, to: last.from, at: now.toISOString(), reason: 'reverted by a human', evidence: { by: 'human' }, status: 'reverted' }
  writeJsonAtomic(tuningStatePath(loaded.stateDir), { history: [...state.history.filter((item) => item.path !== path), record], frozen: [...new Set([...state.frozen, path])] })
  return record
}
