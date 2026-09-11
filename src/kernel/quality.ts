import { fail } from './errors.js'
import { hashJson } from './hash.js'

export const QUALITY_DIMENSIONS = ['correctness', 'completeness', 'speed', 'cost', 'resource', 'reliability'] as const
export type QualityDimension = typeof QUALITY_DIMENSIONS[number]
export type MetricStatus = 'measured' | 'unknown'

export interface PhaseTokenMetrics {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly costUsd?: number
}

export interface PhaseMachineMetrics {
  readonly cpuPercent?: number
  readonly memoryUsedPercent?: number
  readonly peakConcurrency?: number
  readonly queueWaitMs?: number
  readonly contentionMs?: number
  readonly saturationPercent?: number
}

export interface PhaseTelemetry {
  readonly phaseId: string
  readonly durationMs?: number
  readonly attempts?: number
  readonly outcome: 'pass' | 'block' | 'escalate' | 'cancel' | 'unknown'
  readonly failureClass?: string
  readonly evidenceCoverage?: number
  readonly tokens?: PhaseTokenMetrics
  readonly machine?: PhaseMachineMetrics
}

export interface QualityDimensionScore {
  readonly score: number | null
  readonly status: MetricStatus
  readonly baselineDelta: number | null
  readonly source: string
}

export interface QualityMatrix {
  readonly type: 'agentskit-harness-quality-matrix'
  readonly schemaVersion: 1
  readonly dimensions: Readonly<Record<QualityDimension, QualityDimensionScore>>
  readonly overall: QualityDimensionScore
  readonly phaseCount: number
  readonly unknownMetricCount: number
  readonly blockers: readonly WatchdogBlocker[]
  readonly digest: string
}

export interface WatchdogBudget {
  readonly maxDurationMs?: number
  readonly maxTotalTokens?: number
  readonly maxMemoryUsedPercent?: number
  readonly maxSaturationPercent?: number
}

export interface WatchdogBlocker {
  readonly class: 'budget' | 'resource' | 'contention'
  readonly reason: string
  readonly phaseId?: string
}

export interface WatchdogResult {
  readonly status: 'ok' | 'blocked'
  readonly blockers: readonly WatchdogBlocker[]
}

const finite = (value: unknown, label: string, max?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (max !== undefined && value > max)) return fail(`${label} is invalid.`, 'INVALID_INPUT')
  return value
}
const integer = (value: unknown, label: string): number => { const result = finite(value, label); if (!Number.isInteger(result)) return fail(`${label} must be an integer.`, 'INVALID_INPUT'); return result }
const phase = (value: unknown): string => { if (typeof value !== 'string' || !value.trim()) return fail('phaseId is required.', 'INVALID_INPUT'); return value.trim() }

export const validatePhaseTelemetry = (value: unknown): PhaseTelemetry => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('Phase telemetry must be an object.', 'INVALID_INPUT')
  const raw = value as Record<string, unknown>
  const outcome = raw['outcome']
  if (!['pass', 'block', 'escalate', 'cancel', 'unknown'].includes(outcome as string)) return fail('Phase telemetry outcome is invalid.', 'INVALID_INPUT')
  const tokens = raw['tokens'] === undefined ? undefined : raw['tokens'] as PhaseTokenMetrics
  if (tokens) for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) if (tokens[key] !== undefined) finite(tokens[key], `tokens.${key}`)
  const machine = raw['machine'] === undefined ? undefined : raw['machine'] as PhaseMachineMetrics
  if (machine) for (const key of ['cpuPercent', 'memoryUsedPercent', 'peakConcurrency', 'queueWaitMs', 'contentionMs', 'saturationPercent'] as const) if (machine[key] !== undefined) finite(machine[key], `machine.${key}`, ['cpuPercent', 'memoryUsedPercent', 'saturationPercent'].includes(key) ? 100 : undefined)
  return {
    phaseId: phase(raw['phaseId']),
    ...(raw['durationMs'] === undefined ? {} : { durationMs: finite(raw['durationMs'], 'durationMs') }),
    ...(raw['attempts'] === undefined ? {} : { attempts: integer(raw['attempts'], 'attempts') }),
    outcome: outcome as PhaseTelemetry['outcome'],
    ...(raw['failureClass'] === undefined ? {} : { failureClass: phase(raw['failureClass']) }),
    ...(raw['evidenceCoverage'] === undefined ? {} : { evidenceCoverage: finite(raw['evidenceCoverage'], 'evidenceCoverage', 1) }),
    ...(tokens ? { tokens } : {}),
    ...(machine ? { machine } : {}),
  }
}

const average = (values: readonly number[]): number | null => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null
const score = (value: number | null, source: string, baseline: number | null = null): QualityDimensionScore => ({ score: value === null ? null : Math.max(0, Math.min(100, Number(value.toFixed(2)))), status: value === null ? 'unknown' : 'measured', baselineDelta: value === null || baseline === null ? null : Number((value - baseline).toFixed(2)), source })

export const evaluateWatchdog = ({ phases, budget }: { readonly phases: readonly PhaseTelemetry[]; readonly budget: WatchdogBudget }): WatchdogResult => {
  const blockers: WatchdogBlocker[] = []
  const duration = phases.every((phase) => phase.durationMs !== undefined) ? phases.reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0) : undefined
  const totalTokens = phases.every((phase) => phase.tokens?.inputTokens !== undefined && phase.tokens.outputTokens !== undefined) ? phases.reduce((sum, phase) => sum + (phase.tokens?.inputTokens ?? 0) + (phase.tokens?.outputTokens ?? 0), 0) : undefined
  if (budget.maxDurationMs !== undefined && duration !== undefined && duration > budget.maxDurationMs) blockers.push({ class: 'budget', reason: `Duration budget exceeded: ${duration}ms > ${budget.maxDurationMs}ms.` })
  if (budget.maxTotalTokens !== undefined && totalTokens !== undefined && totalTokens > budget.maxTotalTokens) blockers.push({ class: 'budget', reason: `Token budget exceeded: ${totalTokens} > ${budget.maxTotalTokens}.` })
  for (const phase of phases) {
    if (budget.maxMemoryUsedPercent !== undefined && phase.machine?.memoryUsedPercent !== undefined && phase.machine.memoryUsedPercent > budget.maxMemoryUsedPercent) blockers.push({ class: 'resource', phaseId: phase.phaseId, reason: `Memory saturation exceeded: ${phase.machine.memoryUsedPercent}% > ${budget.maxMemoryUsedPercent}%.` })
    if (budget.maxSaturationPercent !== undefined && phase.machine?.saturationPercent !== undefined && phase.machine.saturationPercent > budget.maxSaturationPercent) blockers.push({ class: 'contention', phaseId: phase.phaseId, reason: `Saturation exceeded: ${phase.machine.saturationPercent}% > ${budget.maxSaturationPercent}%.` })
  }
  return { status: blockers.length ? 'blocked' : 'ok', blockers }
}

export const createQualityMatrix = ({ phases, baseline, budget = {} }: { readonly phases: readonly PhaseTelemetry[]; readonly baseline?: readonly PhaseTelemetry[]; readonly budget?: WatchdogBudget }): QualityMatrix => {
  const current = phases.map(validatePhaseTelemetry)
  const prior = baseline?.map(validatePhaseTelemetry) ?? []
  const currentDurations = current.flatMap((phase) => phase.durationMs === undefined ? [] : [phase.durationMs])
  const priorDurations = prior.flatMap((phase) => phase.durationMs === undefined ? [] : [phase.durationMs])
  const currentTokens = current.flatMap((phase) => phase.tokens?.inputTokens !== undefined && phase.tokens.outputTokens !== undefined ? [phase.tokens.inputTokens + phase.tokens.outputTokens] : [])
  const priorTokens = prior.flatMap((phase) => phase.tokens?.inputTokens !== undefined && phase.tokens.outputTokens !== undefined ? [phase.tokens.inputTokens + phase.tokens.outputTokens] : [])
  const correctness = score(average(current.map((phase) => phase.evidenceCoverage === undefined ? 0 : phase.evidenceCoverage * 100)), 'mean evidence coverage')
  const completeness = score(current.length ? current.filter((phase) => phase.outcome === 'pass').length / current.length * 100 : null, 'passed phases / total phases')
  const speed = score(currentDurations.length && priorDurations.length ? average(priorDurations)! / Math.max(1, average(currentDurations)!) * 100 : null, 'baseline duration / current duration', 100)
  const cost = score(currentTokens.length && priorTokens.length ? average(priorTokens)! / Math.max(1, average(currentTokens)!) * 100 : null, 'baseline tokens / current tokens', 100)
  const resourceValues = current.flatMap((phase) => phase.machine?.cpuPercent !== undefined && phase.machine.memoryUsedPercent !== undefined ? [100 - Math.max(phase.machine.cpuPercent, phase.machine.memoryUsedPercent)] : [])
  const resource = score(average(resourceValues), '100 - max(cpu%, memory%)')
  const reliability = score(current.length ? current.filter((phase) => phase.outcome === 'pass').length / current.length * 100 : null, 'passed phases / total phases')
  const dimensions = { correctness, completeness, speed, cost, resource, reliability }
  const measured = Object.values(dimensions).filter((item) => item.score !== null).map((item) => item.score!)
  const overall = score(average(measured), 'mean of measured dimensions')
  const unknownMetricCount = Object.values(dimensions).filter((item) => item.status === 'unknown').length + current.filter((phase) => phase.durationMs === undefined || phase.tokens === undefined || phase.machine === undefined).length
  const blockers = evaluateWatchdog({ phases: current, budget }).blockers
  const body = { type: 'agentskit-harness-quality-matrix' as const, schemaVersion: 1 as const, dimensions, overall, phaseCount: current.length, unknownMetricCount, blockers }
  return { ...body, digest: hashJson(body) }
}
