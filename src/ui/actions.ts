import { z } from 'zod'
import { precheckTick, runTick } from '../loop/tick.js'
import { ensureBaseView } from '../loop/base-view.js'
import { precheckDeliver, runDeliver, approveHeldDelivery } from '../loop/deliver.js'
import { runLoopDoctor } from '../loop/doctor.js'
import { loopStatus } from '../loop/install.js'
import { buildDebriefReport } from '../loop/debrief.js'
import { buildIssueTimeline } from '../loop/issue-timeline.js'
import { runObservability } from '../loop/observability.js'
import { runRetroStage } from '../loop/retro.js'
import { runObserveStage } from '../loop/observe-stage.js'
import { runIntakeStage, runMaintainStage } from '../loop/intake.js'
import { approveRelease, readReleaseBatch, readReleaseState, runReleaseStage } from '../loop/release.js'
import { fail } from '../kernel/errors.js'
import {
  answerRound, approveDesign, approvePlan, architectRound, createPlannedIssues, decomposeRound, designApproved,
  interviewRound, readPlanState, startPlan, writePlanState, type PlanStageDeps,
} from '../loop/plan-stage.js'
import { rankModels } from '../loop/routing.js'
import { writeDesignDocument, writePrdDocument, documentRoot, readCheckoutState } from '../loop/documents.js'
import { requireWritableTracker, resolveConnectors } from '../loop/connectors.js'
import { generateContract, readStoredContract, writeStoredContract } from '../loop/contract.js'
import { acquireStageLock } from '../loop/stage-lock.js'
import { isStagePaused, recordStageRunResult, resumeIssue, resumeStage, stageEntry, type LoopStageName } from '../loop/resilience-state.js'
import type { LoadedLoopConfig } from '../loop/config.js'
import type { CommandRunner } from '../adapters/command.js'

const actor = z.string().trim().min(1)
const reason = z.string().trim().min(1)
const mutation = { actor, reason, confirm: z.literal(true) }
const stage = z.enum(['tick', 'deliver', 'retro', 'observe', 'release', 'intake', 'maintain'])

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('loop.doctor'), probe: z.boolean().default(false), actor: actor.optional(), reason: reason.optional() }),
  z.object({ type: z.literal('loop.validate') }),
  z.object({ type: z.literal('loop.status') }),
  z.object({ type: z.literal('loop.debrief'), issue: z.string().trim().min(1).optional(), since: z.string().trim().min(1).default('24h') }),
  z.object({ type: z.literal('loop.timeline'), issue: z.string().trim().min(1), since: z.string().trim().min(1).default('30d') }),
  z.object({ type: z.literal('loop.observability'), since: z.string().trim().min(1).default('24h') }),
  z.object({ type: z.literal('loop.precheck'), stage: z.enum(['tick', 'deliver']), issue: z.string().trim().min(1).optional(), actor: actor.optional(), reason: reason.optional() }),
  z.object({ type: z.literal('loop.tick'), issue: z.string().trim().min(1).optional(), max: z.number().int().positive().optional(), skipContract: z.boolean().default(false), dryRun: z.boolean().default(false), ...mutation }),
  z.object({ type: z.literal('loop.deliver'), issue: z.string().trim().min(1).optional(), dryRun: z.boolean().default(false), ...mutation }),
  z.object({ type: z.literal('loop.stage'), stage, dryRun: z.boolean().default(false), confirmRelease: z.boolean().default(false), ...mutation }),
  z.object({ type: z.literal('loop.contract'), identifier: z.string().trim().min(1), refresh: z.boolean().default(false), dryRun: z.boolean().default(false), ...mutation }),
  z.object({ type: z.literal('loop.approve-delivery'), issue: z.string().trim().min(1), head: z.string().trim().min(7), ...mutation }),
  z.object({ type: z.literal('loop.resume'), issue: z.string().trim().min(1).optional(), stage: z.enum(['tick', 'deliver']).optional(), ...mutation }),
  z.object({ type: z.literal('plan.start'), objective: z.string().trim().min(1), ...mutation }),
  z.object({ type: z.literal('plan.answer'), id: z.string().trim().min(1), answer: z.string().trim().min(1), ...mutation }),
  z.object({ type: z.literal('plan.approve'), id: z.string().trim().min(1), ...mutation }),
  z.object({ type: z.literal('plan.architect'), id: z.string().trim().min(1), ...mutation }),
  z.object({ type: z.literal('plan.approve-design'), id: z.string().trim().min(1), acceptObjections: z.boolean().default(false), ...mutation }),
  z.object({ type: z.literal('plan.decompose'), id: z.string().trim().min(1), create: z.boolean().default(false), refresh: z.boolean().default(false), parent: z.string().trim().min(1).optional(), project: z.string().trim().min(1).optional(), ...mutation }),
  z.object({ type: z.literal('release.status'), actor: actor.optional(), reason: reason.optional() }),
  z.object({ type: z.literal('release.approve'), confirmRelease: z.literal(true), ...mutation }),
  z.object({ type: z.literal('release.run'), dryRun: z.boolean().default(false), confirmRelease: z.literal(true), ...mutation }),
  z.object({ type: z.literal('issue.transition'), issue: z.string().trim().min(1), state: z.string().trim().min(1), ...mutation }),
  z.object({ type: z.literal('issue.comment'), issue: z.string().trim().min(1), body: z.string().trim().min(1), dedupeKey: z.string().trim().min(1).optional(), ...mutation }),
  z.object({ type: z.literal('issue.labels'), issue: z.string().trim().min(1), add: z.array(z.string().trim().min(1)).default([]), remove: z.array(z.string().trim().min(1)).default([]), ...mutation }),
])

export type UiAction = z.infer<typeof actionSchema>

const mutatingTypes = new Set<UiAction['type']>([
  'loop.tick', 'loop.deliver', 'loop.stage', 'loop.contract', 'loop.approve-delivery', 'loop.resume',
  'plan.start', 'plan.answer', 'plan.approve', 'plan.architect', 'plan.approve-design', 'plan.decompose',
  'release.approve', 'release.run', 'issue.transition', 'issue.comment', 'issue.labels',
])

export const parseUiAction = (value: unknown): UiAction => {
  const parsed = actionSchema.safeParse(value)
  if (!parsed.success) {
    const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    if (typeof raw['type'] === 'string' && mutatingTypes.has(raw['type'] as UiAction['type']) && (typeof raw['actor'] !== 'string' || typeof raw['reason'] !== 'string' || raw['confirm'] !== true)) return fail(`UI action ${raw['type']} requires actor, reason and explicit confirmation.`, 'INVALID_INPUT')
    return fail(`Invalid UI action: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 'INVALID_INPUT')
  }
  if (parsed.data.type === 'loop.stage' && parsed.data.stage === 'release' && parsed.data.confirmRelease !== true) return fail('UI release stage requires the additional release confirmation.', 'INVALID_INPUT')
  if (mutatingTypes.has(parsed.data.type) && (!('actor' in parsed.data) || !('reason' in parsed.data) || !('confirm' in parsed.data))) return fail(`UI action ${parsed.data.type} requires actor, reason and explicit confirmation.`, 'INVALID_INPUT')
  return parsed.data
}

export interface UiActionEvent {
  readonly phase: string
  readonly detail: string
  readonly output?: string
}

export interface UiActionContext {
  readonly loaded: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly emit: (event: UiActionEvent) => void
  readonly cancelled: () => boolean
}

const checkCancelled = (context: UiActionContext): void => { if (context.cancelled()) fail('UI job cancellation requested.', 'INVALID_STATE') }

const requiresTrackerPreflight = (action: UiAction): boolean => {
  if (action.type === 'loop.tick' || action.type === 'loop.deliver' || action.type === 'issue.transition' || action.type === 'issue.comment' || action.type === 'issue.labels') return true
  if (action.type === 'loop.resume') return Boolean(action.issue)
  if (action.type === 'plan.decompose') return action.create
  return action.type === 'loop.stage' && ['tick', 'deliver', 'intake', 'maintain'].includes(action.stage)
}

const preflightTracker = async (context: UiActionContext, action: UiAction): Promise<void> => {
  if (!requiresTrackerPreflight(action)) return
  const tracker = resolveConnectors({ runner: context.runner, config: context.loaded.config }).tracker
  if (tracker.preflight) await tracker.preflight()
}

/** UI jobs share the scheduler's stage lock and pause circuit with CLI stage runs. */
const runLockedStage = async (context: UiActionContext, stage: LoopStageName, run: () => Promise<unknown>): Promise<unknown> => {
  if (isStagePaused(context.loaded.stateDir, stage)) {
    const entry = stageEntry(context.loaded.stateDir, stage)
    return { status: 'paused', stage, pausedAt: entry.pausedAt, pausedReason: entry.pausedReason, consecutiveFailures: entry.consecutiveFailures }
  }
  const release = acquireStageLock(context.loaded.stateDir, stage) ?? fail(`Stage "${stage}" is already running; wait for the active run to finish.`, 'ACTIVE_RUN')
  try {
    const result = await run()
    recordStageRunResult(context.loaded.stateDir, stage, { succeeded: true }, context.loaded.config.resilience.stagePauseAfterRuns)
    return result
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    recordStageRunResult(context.loaded.stateDir, stage, { succeeded: false, reason }, context.loaded.config.resilience.stagePauseAfterRuns)
    throw error
  } finally {
    release()
  }
}

const planDeps = async (context: UiActionContext): Promise<PlanStageDeps> => {
  const doctor = await runLoopDoctor({ loaded: context.loaded, runner: context.runner, probe: false })
  const view = await ensureBaseView(context.runner, context.loaded)
  return { loaded: context.loaded, runner: context.runner, readRoot: view.path, candidates: rankModels(context.loaded.config, 'orchestrator', doctor.providers), voters: rankModels(context.loaded.config, 'reviewer', doctor.providers) }
}

const planOrFail = (context: UiActionContext, id: string) => readPlanState(context.loaded.stateDir, id) ?? fail(`No plan "${id}" under ${context.loaded.stateDir}/plans.`, 'INVALID_INPUT')

export const executeUiAction = async (context: UiActionContext, action: UiAction): Promise<unknown> => {
  const { loaded, runner } = context
  checkCancelled(context)
  context.emit({ phase: action.type, detail: 'started' })
  await preflightTracker(context, action)
  if (action.type === 'loop.doctor') return runLoopDoctor({ loaded, runner, probe: action.probe })
  if (action.type === 'loop.validate') return { status: 'passed', criteria: ['loop-config'], configHash: loaded.configHash, unknownKeys: loaded.unknownKeys, config: loaded.config }
  if (action.type === 'loop.status') return loopStatus({ loaded, runner })
  if (action.type === 'loop.debrief') return buildDebriefReport({ loaded, issue: action.issue, since: action.since })
  if (action.type === 'loop.timeline') return buildIssueTimeline(loaded.stateDir, action.issue, { since: action.since })
  if (action.type === 'loop.observability') return runObservability({ loaded, runner, since: action.since })
  if (action.type === 'loop.precheck') return action.stage === 'tick' ? precheckTick({ loaded, runner, onlyIssue: action.issue }) : precheckDeliver(loaded.stateDir)
  if (action.type === 'loop.tick') return runLockedStage(context, 'tick', () => runTick({ loaded, runner, dryRun: action.dryRun, maxDispatch: action.max, onlyIssue: action.issue, skipContractGeneration: action.skipContract }))
  if (action.type === 'loop.deliver') return runLockedStage(context, 'deliver', () => runDeliver({ loaded, runner, dryRun: action.dryRun, onlyIssue: action.issue }))
  if (action.type === 'loop.stage') {
    if (action.stage === 'tick') return runLockedStage(context, 'tick', () => runTick({ loaded, runner, dryRun: action.dryRun }))
    if (action.stage === 'deliver') return runLockedStage(context, 'deliver', () => runDeliver({ loaded, runner, dryRun: action.dryRun }))
    if (action.stage === 'retro') return runRetroStage({ loaded, runner, dryRun: action.dryRun })
    if (action.stage === 'observe') return runObserveStage({ loaded, runner })
    if (action.stage === 'intake') return runIntakeStage({ loaded, runner, dryRun: action.dryRun })
    if (action.stage === 'maintain') return runMaintainStage({ loaded, runner, dryRun: action.dryRun })
    return runReleaseStage({ loaded, runner, dryRun: action.dryRun })
  }
  if (action.type === 'loop.contract') {
    const cached = action.refresh ? null : readStoredContract(loaded.stateDir, action.identifier)
    if (cached) return cached
    const deps = await planDeps(context)
    const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
    const issue = await tracker.issue(action.identifier)
    const stored = await generateContract({ runner, config: loaded.config, root: deps.readRoot ?? loaded.root, issue, candidates: deps.candidates })
    if (!action.dryRun) writeStoredContract(loaded.stateDir, stored)
    return stored
  }
  if (action.type === 'loop.approve-delivery') return approveHeldDelivery(loaded, action.issue, { head: action.head, by: action.actor })
  if (action.type === 'loop.resume') {
    if (action.stage) { resumeStage(loaded.stateDir, action.stage as LoopStageName); return { status: 'resumed', stage: action.stage } }
    if (!action.issue) return fail('Provide issue or stage to resume.', 'INVALID_INPUT')
    const before = resumeIssue(loaded.stateDir, action.issue)
    const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
    try { await tracker.removeLabels(action.issue, [loaded.config.resilience.pausedLabel]) } catch { /* local pause recovery remains authoritative */ }
    return { status: 'resumed', issue: action.issue, wasPaused: before.pausedAt !== null, previousConsecutive: before.consecutive }
  }
  if (action.type === 'plan.start') {
    const deps = await planDeps(context)
    const next = await interviewRound(deps, startPlan(action.objective, new Date()))
    writePlanState(loaded.stateDir, next)
    return { id: next.id, phase: next.phase, pending: next.pending }
  }
  if (action.type === 'plan.answer') {
    const deps = await planDeps(context)
    const next = await interviewRound(deps, answerRound(planOrFail(context, action.id), action.answer, new Date()))
    writePlanState(loaded.stateDir, next)
    return { id: next.id, phase: next.phase, pending: next.pending }
  }
  if (action.type === 'plan.approve') {
    const next = approvePlan(planOrFail(context, action.id), action.actor, new Date())
    writePlanState(loaded.stateDir, next)
    const document = writePrdDocument(loaded, next, documentRoot(loaded, await readCheckoutState(runner, loaded.root)))
    return { id: action.id, phase: next.phase, ...(document ? { wrote: document.path } : {}) }
  }
  if (action.type === 'plan.architect') {
    const next = await architectRound(await planDeps(context), planOrFail(context, action.id))
    writePlanState(loaded.stateDir, next)
    return { id: action.id, consensus: designApproved(next, loaded.config), cycles: next.designCycles, votes: next.designVotes }
  }
  if (action.type === 'plan.approve-design') {
    const next = approveDesign(planOrFail(context, action.id), action.actor, new Date(), loaded.config, { acceptObjections: action.acceptObjections })
    writePlanState(loaded.stateDir, next)
    const document = writeDesignDocument(loaded, next, documentRoot(loaded, await readCheckoutState(runner, loaded.root)))
    return { id: action.id, phase: next.phase, ...(document ? { wrote: document.path } : {}) }
  }
  if (action.type === 'plan.decompose') {
    const deps = await planDeps(context)
    const current = planOrFail(context, action.id)
    const reuse = action.create && !action.refresh && current.phase === 'decompose' && current.issues.length > 0
    const decomposed = reuse ? current : await decomposeRound(deps, current)
    if (!reuse) writePlanState(loaded.stateDir, decomposed)
    if (!action.create) return { id: action.id, phase: decomposed.phase, issues: decomposed.issues }
    requireWritableTracker(loaded.config)
    const created = await createPlannedIssues(deps, decomposed, { ...(action.parent ? { parent: action.parent } : {}), ...(action.project ? { project: action.project } : {}) })
    writePlanState(loaded.stateDir, created)
    return { id: action.id, phase: created.phase, issues: created.issues }
  }
  if (action.type === 'release.status') {
    const batch = await readReleaseBatch({ loaded, runner })
    return { ...batch, approval: readReleaseState(loaded.stateDir).approval }
  }
  if (action.type === 'release.approve') {
    const batch = await readReleaseBatch({ loaded, runner })
    return approveRelease({ loaded, batch, actor: action.actor })
  }
  if (action.type === 'release.run') return runReleaseStage({ loaded, runner, dryRun: action.dryRun })
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  if (action.type === 'issue.transition') { await tracker.setState({ issue: action.issue, to: action.state, reason: action.reason }); return { status: 'transitioned', issue: action.issue, state: action.state } }
  if (action.type === 'issue.comment') { await tracker.comment({ issue: action.issue, body: action.body, ...(action.dedupeKey ? { dedupeKey: action.dedupeKey } : {}) }); return { status: 'commented', issue: action.issue } }
  await tracker.addLabels(action.issue, action.add)
  await tracker.removeLabels(action.issue, action.remove)
  return { status: 'updated', issue: action.issue, added: action.add, removed: action.remove }
}
