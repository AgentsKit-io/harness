import { fail } from './errors.js'
import { runWorkflow } from './workflow.js'

export const PHASE_MODES = ['safe', 'yolo', 'dry-run'] as const
export type PhaseMode = typeof PHASE_MODES[number]
export const PHASE_EFFECTS = ['read', 'write', 'external'] as const
export type PhaseEffect = typeof PHASE_EFFECTS[number]
export const PHASE_EFFECT_ACTIONS = ['allow', 'preview', 'block', 'escalate'] as const
export type PhaseEffectAction = typeof PHASE_EFFECT_ACTIONS[number]
export const PHASE_DECISIONS = ['pass', 'block', 'escalate', 'retry', 'cancel', 'resume'] as const
export type PhaseDecision = typeof PHASE_DECISIONS[number]

export interface PhaseRetryPolicy {
  readonly maxAttempts: number
}

export interface PhaseDefinition {
  readonly id: string
  readonly inputs?: readonly string[]
  readonly outputs?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly gates?: readonly string[]
  readonly retries?: PhaseRetryPolicy
  readonly budgetMs?: number
  readonly effect: PhaseEffect
}

export interface PhaseEffectPolicy {
  readonly read: PhaseEffectAction
  readonly write: PhaseEffectAction
  readonly external: PhaseEffectAction
}

export interface PhaseProfile {
  readonly id: string
  readonly mode: PhaseMode
  readonly phases: readonly PhaseDefinition[]
  readonly effectPolicy?: Partial<PhaseEffectPolicy>
  readonly maxConcurrency?: number
  readonly budgetMs?: number
}

export interface NormalizedPhaseProfile extends Omit<PhaseProfile, 'effectPolicy' | 'maxConcurrency'> {
  readonly effectPolicy: PhaseEffectPolicy
  readonly maxConcurrency: number
}

export interface PhaseRoutePlan {
  readonly profileId: string
  readonly mode: PhaseMode
  readonly levels: readonly (readonly string[])[]
  readonly phases: readonly PhaseDefinition[]
  readonly effectPolicy: PhaseEffectPolicy
  readonly maxConcurrency: number
  readonly budgetMs?: number
}

export interface PhaseAmbiguity {
  readonly id: string
  readonly question: string
  readonly options?: readonly string[]
  readonly suggestion?: string
}

export interface PhaseDecisionPacket {
  readonly id: 'phase-preflight'
  readonly phaseIds: readonly string[]
  readonly ambiguities: readonly PhaseAmbiguity[]
}

export interface PhaseContext {
  readonly phase: PhaseDefinition
  readonly attempt: number
  readonly mode: PhaseMode
  readonly inputs: Readonly<Record<string, unknown>>
  readonly outputs: Readonly<Record<string, unknown>>
  readonly dryRun: boolean
}

export interface PhaseHandlerResult {
  readonly decision: PhaseDecision
  readonly outputs?: Readonly<Record<string, unknown>>
  readonly reason?: string
}

export type PhaseHandler = (context: PhaseContext) => PhaseHandlerResult | Promise<PhaseHandlerResult>
export type PhaseGateResult = boolean | { readonly decision: Exclude<PhaseDecision, 'retry' | 'cancel' | 'resume' | 'pass'> | 'pass'; readonly reason?: string }
export type PhaseGateEvaluator = (context: PhaseContext) => PhaseGateResult | Promise<PhaseGateResult>
export interface PhasePreflightResult {
  readonly decision?: 'pass' | 'block' | 'escalate'
  readonly reason?: string
  readonly ambiguities?: readonly PhaseAmbiguity[]
}
export type PhasePreflight = (context: PhaseContext) => PhasePreflightResult | Promise<PhasePreflightResult>

export interface PhaseExecution {
  readonly id: string
  readonly effect: PhaseEffect
  readonly decision: PhaseDecision
  readonly attempts: number
  readonly skipped: boolean
  readonly reason?: string
  readonly outputs?: Readonly<Record<string, unknown>>
}

export interface PhaseResumeState {
  readonly completed: Readonly<Record<string, Pick<PhaseExecution, 'decision' | 'outputs'>>>
  readonly outputs?: Readonly<Record<string, unknown>>
}

export interface ExecutePhaseProfileOptions {
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly handlers?: Readonly<Record<string, PhaseHandler>>
  readonly gates?: Readonly<Record<string, PhaseGateEvaluator>>
  readonly preflight?: PhasePreflight
  readonly resume?: PhaseResumeState
  readonly now?: () => number
}

export interface PhaseExecutionReport {
  readonly status: 'passed' | 'blocked' | 'escalated' | 'cancelled' | 'dry-run'
  readonly plan: PhaseRoutePlan
  readonly phases: readonly PhaseExecution[]
  readonly order: readonly string[]
  readonly outputs: Readonly<Record<string, unknown>>
  readonly resumed: boolean
  readonly decisionPacket?: PhaseDecisionPacket
  readonly durationMs: number
}

const requiredId = (value: unknown, label: string): string => {
  if (typeof value !== 'string') return fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
  if (!value.trim()) return fail(`${label} must be a non-empty string.`, 'INVALID_INPUT')
  return value.trim()
}

const names = (values: readonly string[] | undefined, label: string): readonly string[] => {
  if (values === undefined) return []
  if (!Array.isArray(values)) fail(`${label} must be an array.`, 'INVALID_INPUT')
  const normalized = values.map((value, index) => requiredId(value, `${label}[${index}]`))
  if (new Set(normalized).size !== normalized.length) fail(`${label} must contain unique names.`, 'INVALID_INPUT')
  return normalized
}

const boundedPositive = (value: number | undefined, label: string, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1 || result > 100) fail(`${label} must be a bounded positive integer (1-100).`, 'INVALID_INPUT')
  return result
}

const duration = (value: number | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer.`, 'INVALID_INPUT')
  return value
}

const defaultEffects = (mode: PhaseMode): PhaseEffectPolicy => mode === 'dry-run'
  ? { read: 'allow', write: 'preview', external: 'preview' }
  : mode === 'safe'
    ? { read: 'allow', write: 'allow', external: 'escalate' }
    : { read: 'allow', write: 'allow', external: 'allow' }

const normalize = (profile: PhaseProfile): NormalizedPhaseProfile => {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return fail('profile must be an object.', 'INVALID_INPUT')
  const id = requiredId(profile.id, 'profile.id')
  if (!PHASE_MODES.includes(profile.mode)) fail('profile.mode is invalid.', 'INVALID_INPUT')
  if (!Array.isArray(profile.phases) || !profile.phases.length) fail('profile.phases must be non-empty.', 'INVALID_INPUT')
  const ids = profile.phases.map((phase, index) => requiredId(phase.id, `phases[${index}].id`))
  if (new Set(ids).size !== ids.length) fail('Phase ids must be unique.', 'INVALID_INPUT')
  const known = new Set(ids)
  const outputOwners = new Map<string, string>()
  const phases = profile.phases.map((phase, index) => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) return fail(`phases[${index}] must be an object.`, 'INVALID_INPUT')
    if (!PHASE_EFFECTS.includes(phase.effect)) fail(`phases[${index}].effect is invalid.`, 'INVALID_INPUT')
    const dependsOn = names(phase.dependsOn, `phases[${index}].dependsOn`)
    if (dependsOn.includes(ids[index]!)) fail(`phases[${index}] cannot depend on itself.`, 'INVALID_INPUT')
    if (dependsOn.some((dependency) => !known.has(dependency))) fail(`phases[${index}] has an unknown dependency.`, 'INVALID_INPUT')
    const inputs = names(phase.inputs, `phases[${index}].inputs`)
    const outputs = names(phase.outputs, `phases[${index}].outputs`)
    for (const output of outputs) {
      const owner = outputOwners.get(output)
      if (owner) fail(`Output ${output} is declared by both ${owner} and ${ids[index]}.`, 'INVALID_INPUT')
      outputOwners.set(output, ids[index]!)
    }
    const gates = names(phase.gates, `phases[${index}].gates`)
    const maxAttempts = boundedPositive(phase.retries?.maxAttempts, `phases[${index}].retries.maxAttempts`, 1)
    return { id: ids[index]!, effect: phase.effect, inputs, outputs, dependsOn, gates, ...(maxAttempts > 1 ? { retries: { maxAttempts } } : {}), ...(duration(phase.budgetMs, `phases[${index}].budgetMs`) ? { budgetMs: phase.budgetMs } : {}) }
  })
  const defaults = defaultEffects(profile.mode)
  const effectPolicy = { ...defaults, ...(profile.effectPolicy ?? {}) }
  for (const effect of PHASE_EFFECTS) if (!PHASE_EFFECT_ACTIONS.includes(effectPolicy[effect])) fail(`effectPolicy.${effect} is invalid.`, 'INVALID_INPUT')
  const maxConcurrency = boundedPositive(profile.maxConcurrency, 'profile.maxConcurrency', 1)
  const budgetMs = duration(profile.budgetMs, 'profile.budgetMs')
  calculateLevels(phases)
  return { id, mode: profile.mode, phases, effectPolicy, maxConcurrency, ...(budgetMs ? { budgetMs } : {}) }
}

const calculateLevels = (phases: readonly PhaseDefinition[]): readonly (readonly string[])[] => {
  const byId = new Map(phases.map((phase) => [phase.id, phase]))
  const remaining = new Set(byId.keys())
  const completed = new Set<string>()
  const levels: string[][] = []
  while (remaining.size) {
    const ready = [...remaining].sort().filter((id) => (byId.get(id)?.dependsOn ?? []).every((dependency) => completed.has(dependency)))
    if (!ready.length) fail('Phase profile contains an unknown dependency or cycle.', 'INVALID_INPUT')
    levels.push(ready)
    ready.forEach((id) => { remaining.delete(id); completed.add(id) })
  }
  return levels
}

export const createPhaseProfile = (profile: PhaseProfile): NormalizedPhaseProfile => normalize(profile)

export const planPhaseProfile = (profile: PhaseProfile): PhaseRoutePlan => {
  const normalized = normalize(profile)
  return { profileId: normalized.id, mode: normalized.mode, levels: calculateLevels(normalized.phases), phases: normalized.phases, effectPolicy: normalized.effectPolicy, maxConcurrency: normalized.maxConcurrency, ...(normalized.budgetMs ? { budgetMs: normalized.budgetMs } : {}) }
}

const resultDecision = (value: unknown): PhaseHandlerResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Phase handler must return a decision object.', 'INVALID_INPUT')
  const result = value as Partial<PhaseHandlerResult>
  if (!PHASE_DECISIONS.includes(result.decision as PhaseDecision)) fail('Phase handler returned an invalid decision.', 'INVALID_INPUT')
  if (result.outputs !== undefined && (typeof result.outputs !== 'object' || result.outputs === null || Array.isArray(result.outputs))) fail('Phase outputs must be an object.', 'INVALID_INPUT')
  return result as PhaseHandlerResult
}

const gateDecision = (value: PhaseGateResult): { readonly decision: 'pass' | 'block' | 'escalate'; readonly reason?: string } => typeof value === 'boolean' ? { decision: value ? 'pass' : 'block' } : value

const packet = (phaseIds: readonly string[], ambiguities: readonly PhaseAmbiguity[]): PhaseDecisionPacket | undefined => ambiguities.length ? { id: 'phase-preflight', phaseIds: [...phaseIds].sort(), ambiguities } : undefined

const timeout = async <T>(operation: Promise<T>, budgetMs: number | undefined): Promise<T> => {
  if (budgetMs === undefined) return operation
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`phase budget exceeded after ${budgetMs}ms`)), budgetMs) })
  try { return await Promise.race([operation, limit]) } finally { if (timer) clearTimeout(timer) }
}

interface StepResult { readonly execution: PhaseExecution; readonly outputs: Readonly<Record<string, unknown>> }

export const executePhaseProfile = async (profile: PhaseProfile, options: ExecutePhaseProfileOptions = {}): Promise<PhaseExecutionReport> => {
  const plan = planPhaseProfile(profile)
  const started = (options.now ?? Date.now)()
  const inputValues = { ...(options.inputs ?? {}) }
  const outputValues: Record<string, unknown> = { ...(options.resume?.outputs ?? {}) }
  const completed = options.resume?.completed ?? {}
  const phasesById = new Map(plan.phases.map((phase) => [phase.id, phase]))
  const mutating = plan.phases.filter((phase) => phase.effect !== 'read')
  const preflightAmbiguities: PhaseAmbiguity[] = []
  const preflightAmbiguityPhaseIds = new Set<string>()
  const preflightBlocked: PhaseExecution[] = []
  const preflightEscalated: PhaseExecution[] = []
  for (const phase of mutating) {
    const action = plan.effectPolicy[phase.effect]
    if (action === 'block') { preflightBlocked.push({ id: phase.id, effect: phase.effect, decision: 'block', attempts: 0, skipped: true, reason: `Effect ${phase.effect} is blocked by profile policy.` }); continue }
    if (action === 'escalate') { preflightEscalated.push({ id: phase.id, effect: phase.effect, decision: 'escalate', attempts: 0, skipped: true, reason: `Effect ${phase.effect} requires escalation in ${plan.mode} mode.` }); continue }
    if (!options.preflight && action === 'allow') { preflightBlocked.push({ id: phase.id, effect: phase.effect, decision: 'block', attempts: 0, skipped: true, reason: `Preflight is required before ${phase.effect} effects.` }); continue }
    if (!options.preflight) continue
    const context: PhaseContext = { phase, attempt: 0, mode: plan.mode, inputs: inputValues, outputs: outputValues, dryRun: action === 'preview' }
    const check = await options.preflight(context)
    if (check.ambiguities?.length) { preflightAmbiguityPhaseIds.add(phase.id); preflightAmbiguities.push(...check.ambiguities) }
    if (check.decision === 'block') preflightBlocked.push({ id: phase.id, effect: phase.effect, decision: 'block', attempts: 0, skipped: true, ...(check.reason ? { reason: check.reason } : {}) })
    if (check.decision === 'escalate') preflightEscalated.push({ id: phase.id, effect: phase.effect, decision: 'escalate', attempts: 0, skipped: true, ...(check.reason ? { reason: check.reason } : {}) })
  }
  const decisionPacket = packet([...preflightAmbiguityPhaseIds, ...preflightEscalated.map((phase) => phase.id)], preflightAmbiguities)
  if (decisionPacket || preflightEscalated.length) return { status: 'escalated', plan, phases: [...preflightBlocked, ...preflightEscalated], order: [], outputs: outputValues, resumed: false, ...(decisionPacket ? { decisionPacket } : {}), durationMs: (options.now ?? Date.now)() - started }
  if (preflightBlocked.length) return { status: 'blocked', plan, phases: preflightBlocked, order: [], outputs: outputValues, resumed: false, durationMs: (options.now ?? Date.now)() - started }

  const executions: PhaseExecution[] = []
  let resumed = false
  let dryRun = false
  const statusOf = (phase: PhaseDefinition, decision: PhaseDecision, attempts: number, skipped: boolean, reason?: string, outputs?: Readonly<Record<string, unknown>>): PhaseExecution => ({ id: phase.id, effect: phase.effect, decision, attempts, skipped, ...(reason ? { reason } : {}), ...(outputs ? { outputs } : {}) })
  const runPhase = async (phase: PhaseDefinition, levelOutputs: Readonly<Record<string, unknown>>): Promise<StepResult> => {
    const prior = completed[phase.id]
    if (prior && (prior.decision === 'pass' || prior.decision === 'resume')) { resumed = true; const restored = prior.outputs ?? {}; return { execution: statusOf(phase, 'resume', 0, true, 'Resumed from a completed phase.', restored), outputs: restored } }
    const action = plan.effectPolicy[phase.effect]
    if (action === 'block') return { execution: statusOf(phase, 'block', 0, true, `Effect ${phase.effect} is blocked by profile policy.`), outputs: {} }
    if (action === 'escalate') return { execution: statusOf(phase, 'escalate', 0, true, `Effect ${phase.effect} requires escalation in ${plan.mode} mode.`), outputs: {} }
    if (action === 'preview') { dryRun = true; return { execution: statusOf(phase, 'pass', 0, true, 'Effect previewed; handler was not invoked.'), outputs: {} } }
    const values = { ...inputValues, ...levelOutputs }
    const inputs: Record<string, unknown> = {}
    for (const name of phase.inputs ?? []) {
      if (!(name in values)) return { execution: statusOf(phase, 'block', 0, true, `Missing phase input: ${name}.`), outputs: {} }
      inputs[name] = values[name]
    }
    const handler = options.handlers?.[phase.id]
    if (!handler) return { execution: statusOf(phase, 'block', 0, true, `No handler registered for phase ${phase.id}.`), outputs: {} }
    const gateContext = (attempt: number): PhaseContext => ({ phase, attempt, mode: plan.mode, inputs, outputs: levelOutputs, dryRun: false })
    for (const gateId of phase.gates ?? []) {
      const evaluator = options.gates?.[gateId]
      if (!evaluator) return { execution: statusOf(phase, 'block', 0, true, `No evaluator registered for gate ${gateId}.`), outputs: {} }
      const gate = gateDecision(await evaluator(gateContext(0)))
      if (gate.decision !== 'pass') return { execution: statusOf(phase, gate.decision, 0, true, gate.reason ?? `Gate ${gateId} did not pass.`), outputs: {} }
    }
    const maxAttempts = phase.retries?.maxAttempts ?? 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: PhaseHandlerResult
      try { result = resultDecision(await timeout(Promise.resolve(handler(gateContext(attempt))), phase.budgetMs)) } catch (error) { return { execution: statusOf(phase, 'block', attempt, false, error instanceof Error ? error.message : String(error)), outputs: {} } }
      if (result.decision === 'retry') { if (attempt < maxAttempts) continue; return { execution: statusOf(phase, 'block', attempt, false, result.reason ?? 'Phase retry budget exhausted.'), outputs: {} } }
      if (result.decision === 'pass' || result.decision === 'resume') {
        const produced = { ...(result.outputs ?? {}) }
        const declared = new Set(phase.outputs ?? [])
        if ([...Object.keys(produced)].some((name) => !declared.has(name))) return { execution: statusOf(phase, 'block', attempt, false, 'Phase returned an undeclared output.'), outputs: {} }
        if ([...(phase.outputs ?? [])].some((name) => !(name in produced))) return { execution: statusOf(phase, 'block', attempt, false, 'Phase did not produce every declared output.'), outputs: {} }
        return { execution: statusOf(phase, result.decision, attempt, false, result.reason, produced), outputs: produced }
      }
      return { execution: statusOf(phase, result.decision, attempt, false, result.reason), outputs: {} }
    }
    return { execution: statusOf(phase, 'block', maxAttempts, false, 'Phase did not resolve.'), outputs: {} }
  }

  for (const level of plan.levels) {
    if (plan.budgetMs !== undefined && (options.now ?? Date.now)() - started > plan.budgetMs) {
      const phase = phasesById.get(level[0]!)!
      executions.push(statusOf(phase, 'block', 0, true, `Profile budget exceeded after ${plan.budgetMs}ms.`))
      break
    }
    const levelSnapshot = { ...outputValues }
    const workflow = await runWorkflow(level.map((id) => ({ id, run: () => runPhase(phasesById.get(id)!, levelSnapshot) })), { maxConcurrency: plan.maxConcurrency })
    let stop = false
    for (const id of level) {
      const step = workflow.results[id]!
      executions.push(step.execution)
      if (step.execution.decision === 'pass' || step.execution.decision === 'resume') Object.assign(outputValues, step.outputs)
      else stop = true
    }
    if (stop) break
  }
  const failed = executions.find((execution) => execution.decision === 'block' || execution.decision === 'escalate' || execution.decision === 'cancel')
  const status = failed?.decision === 'cancel' ? 'cancelled' : failed?.decision === 'escalate' ? 'escalated' : failed ? 'blocked' : dryRun ? 'dry-run' : 'passed'
  return { status, plan, phases: executions, order: executions.map((execution) => execution.id), outputs: outputValues, resumed, durationMs: (options.now ?? Date.now)() - started }
}
