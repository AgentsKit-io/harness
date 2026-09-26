import type { ServerResponse } from 'node:http'
import { detectProviders } from '../../adapters/providers.js'
import { HarnessError } from '../../kernel/errors.js'
import { promoteLearnings } from '../../kernel/learning.js'
import { parseModelRef, type LoadedLoopConfig, type ModelReference } from '../../loop/config.js'
import { activeCooldowns, readCooldowns } from '../../loop/cooldown.js'
import { approveHeldDelivery, runDeliver } from '../../loop/deliver.js'
import { providerSpecs } from '../../loop/doctor.js'
import { documentRoot, readCheckoutState, writeDesignDocument, writePrdDocument } from '../../loop/documents.js'
import { openLoopMemory, promoteLearningsToMemory, readLearningsLedger, writeLearningsLedger } from '../../loop/memory.js'
import { approveDesign, approvePlan, readPlanState, writePlanState } from '../../loop/plan-stage.js'
import { approveRelease, readReleaseBatch } from '../../loop/release.js'
import { isStagePaused, pauseStage, recordStageRunResult, resumeStage, type LoopStageName } from '../../loop/resilience-state.js'
import { rankModels } from '../../loop/routing.js'
import { acquireStageLock } from '../../loop/stage-lock.js'
import { appendLoopEvent, runTick } from '../../loop/tick.js'
import { enqueueRun, generateOrReuseContract, type ActionContext, type ContractResult } from './actions.js'
import type { BatchRunSettings } from './contract.js'
import { readRequestBody, recordOf, SAFE_IDENTIFIER, sendJson, stringOf } from './http.js'
import { UiJobConflictError, type UiJobRecord } from './jobs.js'
import type { RouteContext, RouteModule } from './routes.js'

/**
 * Human gates and operator actions — each one the exact kernel call its `ak-harness loop …` command makes, never a
 * reimplementation. The actor on a gate is the configured person (`linear.person`) or `operator`: the UI is only
 * ever driven by the human at this machine, never by an agent.
 */

export interface ActionRouteDeps {
  readonly contract: (context: ActionContext, issue: string) => Promise<ContractResult>
  readonly tick: typeof runTick
  readonly deliver: typeof runDeliver
}

const STAGES: readonly LoopStageName[] = ['tick', 'deliver']
const HEAD = /^[0-9a-f]{7,64}$/i
const MAX_BATCH = 50
const MAX_IDS = 200

export const humanActor = (loaded: LoadedLoopConfig): string => (loaded.config.linear as { readonly person?: string } | undefined)?.person?.trim() || 'operator'

/** Kernel refusals keep their meaning on the wire: a stale or wrong-state gate is a 409, not a malformed request. */
const sendFailure = (response: ServerResponse, error: unknown): true => {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof HarnessError ? error.code : null
  sendJson(response, code && ['STALE', 'INVALID_STATE', 'HUMAN_APPROVAL_REQUIRED', 'ACTIVE_RUN'].includes(code) ? 409 : 400, { error: message, ...(code ? { code } : {}) })
  return true
}

const idsOf = (body: Record<string, unknown>): readonly string[] => {
  const ids = Array.isArray(body['ids']) ? body['ids'].map(stringOf).filter((id): id is string => id !== null) : []
  if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !SAFE_IDENTIFIER.test(id))) throw new Error(`ids must list 1–${MAX_IDS} learning ids.`)
  return ids
}

const reply = (response: ServerResponse, status: number, body: unknown): true => { sendJson(response, status, body); return true }
/** Ids that become path segments under the state dir: no separators, no parent references. */
const safeName = (value: string | undefined): value is string => value !== undefined && SAFE_IDENTIFIER.test(value) && !value.includes('/') && !value.includes('..')

const stageOf = (value: string | undefined): LoopStageName | null => STAGES.find((stage) => stage === value) ?? null

// ---- batch enqueue ---------------------------------------------------------------------------------------------

interface BatchItem { readonly issue: string; readonly flow: string | null; readonly builder: ModelReference; readonly maxFixRounds: number; readonly perIssueTokens: number }

/** A declared builder candidate whose provider is configured — the same rule the wizard's enqueue applies. */
const configuredBuilder = (loaded: LoadedLoopConfig, value: string): ModelReference => {
  const configured = loaded.config.models.builder.flat().find((candidate) => candidate === value && loaded.config.models.providers[candidate.slice(0, candidate.indexOf('/'))])
  if (!configured) throw new Error(`Builder ${value} is not a declared, routable builder candidate.`)
  return parseModelRef(configured)
}

/** First ranked builder right now — local detection only (PATH, env, cooldowns); no provider or Orca call. */
const firstRankedBuilder = async (loaded: LoadedLoopConfig): Promise<string | null> => {
  const { config } = loaded
  const availability = await detectProviders({ providers: providerSpecs(config), accountList: {}, agentHooks: {}, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(readCooldowns(loaded.stateDir)) })
  const top = rankModels(config, 'builder', availability)[0]
  return top ? `${top.provider}/${top.model}` : null
}

/** The same caps as the wizard's `POST /runs`: nothing a batch sets can exceed what the project allows. */
const batchItem = (loaded: LoadedLoopConfig, issue: string, settings: BatchRunSettings, defaultBuilder: string | null): BatchItem => {
  const { config } = loaded
  const flow = stringOf(settings.flow)
  if (flow && !Object.prototype.hasOwnProperty.call(config.flows?.profiles ?? {}, flow)) throw new Error(`${issue}: unknown flow ${flow}.`)
  const maxFixRounds = settings.maxFixRounds ?? config.delivery.maxFixRounds
  const perIssueTokens = settings.perIssueTokens ?? config.budget.perIssueTokens
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0 || maxFixRounds > config.delivery.maxFixRounds) throw new Error(`${issue}: maxFixRounds cannot exceed the project ceiling (${config.delivery.maxFixRounds}).`)
  if (!Number.isInteger(perIssueTokens) || perIssueTokens < 0 || (config.budget.perIssueTokens > 0 && perIssueTokens > config.budget.perIssueTokens)) throw new Error(`${issue}: perIssueTokens cannot exceed the project cap.`)
  const builder = stringOf(settings.builder) ?? defaultBuilder
  if (!builder) throw new Error(`${issue}: no builder model is routable right now.`)
  return { issue, flow, builder: configuredBuilder(loaded, builder), maxFixRounds, perIssueTokens }
}

const settingsOf = (value: unknown): BatchRunSettings => {
  const raw = recordOf(value)
  return {
    ...(raw['flow'] === null || typeof raw['flow'] === 'string' ? { flow: raw['flow'] } : {}),
    ...(typeof raw['builder'] === 'string' ? { builder: raw['builder'] } : {}),
    ...(raw['maxFixRounds'] !== undefined ? { maxFixRounds: raw['maxFixRounds'] as number } : {}),
    ...(raw['perIssueTokens'] !== undefined ? { perIssueTokens: raw['perIssueTokens'] as number } : {}),
  }
}

const parseBatch = async (loaded: LoadedLoopConfig, body: unknown): Promise<readonly BatchItem[]> => {
  const raw = recordOf(body)
  const defaults = settingsOf(raw['defaults'])
  const entries = Array.isArray(raw['issues']) ? raw['issues'].map((entry) => ({ issue: stringOf(recordOf(entry)['issue']), settings: { ...defaults, ...settingsOf(entry) } })) : []
  if (!entries.length || entries.length > MAX_BATCH) throw new Error(`A batch lists 1–${MAX_BATCH} issues.`)
  const seen = new Set<string>()
  for (const { issue } of entries) {
    if (issue === null || !safeName(issue)) throw new Error('Every batch entry needs a valid issue identifier.')
    if (seen.has(issue)) throw new Error(`${issue} is listed twice.`)
    seen.add(issue)
  }
  const defaultBuilder = entries.some((entry) => !stringOf(entry.settings.builder)) ? await firstRankedBuilder(loaded) : null
  // Validate the whole batch before a single job starts: a half-queued batch is worse than a refused one.
  return entries.map((entry) => batchItem(loaded, entry.issue as string, entry.settings, defaultBuilder))
}

/** Contract first (reused when fresh). Only a valid, dispatchable contract is queued; an ambiguous one has already
 * filed its HITL requests inside `generateOrReuseContract` and the job lands as `needs-input`. */
const runBatchItem = (context: ActionContext, deps: ActionRouteDeps, item: BatchItem) => async ({ emit }: { readonly emit: (event: { readonly phase: string; readonly detail: string }) => void }): Promise<unknown> => {
  emit({ phase: 'contract', detail: 'Generating or reusing the contract' })
  const result = await deps.contract(context, item.issue)
  if (result.status !== 'valid') return { status: result.status, issue: item.issue, contractDigest: result.contract.digest }
  const { runId } = enqueueRun(context, { issue: item.issue, configHash: context.loaded.configHash, flow: item.flow, builder: item.builder, contractDigest: result.contract.digest, maxFixRounds: item.maxFixRounds, perIssueTokens: item.perIssueTokens })
  return { status: 'queued', issue: item.issue, runId, contractDigest: result.contract.digest }
}

// ---- manual stage runs ------------------------------------------------------------------------------------------

/** What `loop stage tick|deliver` does around the run, minus Orca: the stage lock (so it never overlaps a scheduled
 * run) and the same success/failure bookkeeping, so a manual crash counts toward the automatic pause too. */
const runStage = (context: ActionContext, deps: ActionRouteDeps, stage: LoopStageName) => async (): Promise<unknown> => {
  const { loaded, runner } = context
  const release = acquireStageLock(loaded.stateDir, stage)
  if (!release) throw new Error(`Another ${stage} run is still active.`)
  const threshold = loaded.config.resilience.stagePauseAfterRuns
  const budgetMs = Math.max(60_000, loaded.config.schedule.stageTimeoutSec * 1000 - 60_000)
  try {
    const report = stage === 'tick' ? await deps.tick({ loaded, runner, budgetMs }) : await deps.deliver({ loaded, runner, budgetMs })
    recordStageRunResult(loaded.stateDir, stage, { succeeded: true }, threshold)
    return report
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const entry = recordStageRunResult(loaded.stateDir, stage, { succeeded: false, reason }, threshold)
    if (entry.pausedAt) appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'stage.paused', stage, reason, consecutiveFailures: entry.consecutiveFailures })
    throw error
  } finally { release() }
}

// ---- routes -----------------------------------------------------------------------------------------------------

const submitOr503 = (context: RouteContext, response: ServerResponse, submit: () => UiJobRecord): true => {
  if (!context.jobs) { sendJson(response, 503, { error: 'jobs_unavailable' }); return true }
  try { sendJson(response, 202, { job: submit() }) } catch (error) { sendFailure(response, error) }
  return true
}

export const createActionRoutes = (deps: ActionRouteDeps = { contract: (context, issue) => generateOrReuseContract(context, issue), tick: runTick, deliver: runDeliver }): RouteModule => async (context, request, response, url) => {
  if (request.method !== 'POST') return false
  const parts = url.pathname.split('/').filter(Boolean).slice(2).map((part) => decodeURIComponent(part))
  const [area, id, operation] = parts
  const { loaded } = context
  const actor = humanActor(loaded)

  try {
    if (area === 'issues' && operation === 'approve' && parts.length === 3) {
      if (!safeName(id)) return reply(response, 400, { error: 'invalid_issue' })
      const head = stringOf(recordOf(await readRequestBody(request))['head'])
      if (!head || !HEAD.test(head)) return reply(response, 400, { error: 'An approval names the exact head commit it reviewed (7+ hex characters).' })
      const state = approveHeldDelivery(loaded, id, { head, by: actor })
      return reply(response, 200, { issue: id, head: state.humanApproval?.head ?? head, by: actor })
    }

    if (area === 'plans' && (operation === 'approve' || operation === 'approve-design') && parts.length === 3) {
      if (!safeName(id)) return reply(response, 400, { error: 'invalid_plan' })
      const current = readPlanState(loaded.stateDir, id)
      if (!current) return reply(response, 404, { error: 'plan_not_found' })
      const body = recordOf(await readRequestBody(request))
      const now = new Date()
      const next = operation === 'approve' ? approvePlan(current, actor, now) : approveDesign(current, actor, now, loaded.config, { acceptObjections: body['acceptObjections'] === true })
      writePlanState(loaded.stateDir, next)
      // Same as the CLI: an approved document lands in the repo only when the checkout is the clean base branch.
      const target = documentRoot(loaded, await readCheckoutState(context.runner, loaded.root))
      const document = operation === 'approve' ? writePrdDocument(loaded, next, target) : writeDesignDocument(loaded, next, target)
      return reply(response, 200, { id, phase: next.phase, by: actor, ...(document ? { wrote: document.path, ...(document.note ? { note: document.note } : {}) } : {}) })
    }

    if (area === 'release' && id === 'approve' && parts.length === 2) {
      // Approval only. There is deliberately no endpoint for `release run`: deploys never start from the UI.
      const batch = await readReleaseBatch({ loaded, runner: context.runner })
      return reply(response, 200, { status: 'approved', ...approveRelease({ loaded, batch, actor }) })
    }

    if (area === 'learnings' && (id === 'promote' || id === 'reject') && parts.length === 2) {
      const ids = idsOf(recordOf(await readRequestBody(request)))
      // `promoteLearnings` only accepts the literal `human` actor (ADR-0019) — the CLI's default, and the truth here.
      if (id === 'promote') {
        const result = await promoteLearningsToMemory({ stateDir: loaded.stateDir, config: loaded.config, adapter: openLoopMemory(loaded), ids, actor: 'human', sourceRevision: 'unknown' })
        return reply(response, 200, { status: 'ok', promoted: ids, remembered: result.remembered })
      }
      const records = promoteLearnings(readLearningsLedger(loaded.stateDir).records, { actor: 'human', ids, status: 'rejected' })
      writeLearningsLedger(loaded.stateDir, { records })
      return reply(response, 200, { status: 'ok', rejected: ids })
    }

    if (area === 'stages' && parts.length === 3) {
      const stage = stageOf(id)
      if (!stage) return reply(response, 400, { error: 'unknown_stage' })
      if (operation === 'pause') {
        const reason = stringOf(recordOf(await readRequestBody(request))['reason'])
        if (!reason) return reply(response, 400, { error: 'A pause needs a reason.' })
        const entry = pauseStage(loaded.stateDir, stage, `${reason} (${actor})`)
        appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'stage.paused', stage, reason: entry.pausedReason, consecutiveFailures: entry.consecutiveFailures, by: actor })
        return reply(response, 200, { stage, paused: true, pausedAt: entry.pausedAt, pausedReason: entry.pausedReason })
      }
      if (operation === 'resume') { resumeStage(loaded.stateDir, stage); return reply(response, 200, { stage, paused: false }) }
      if (operation === 'run') {
        if (isStagePaused(loaded.stateDir, stage)) return reply(response, 409, { error: `The ${stage} stage is paused; resume it first.` })
        return submitOr503(context, response, () => context.jobs!.submit({ kind: `stage:${stage}`, issue: null, actor, reason: `Run ${stage} now`, run: runStage(context, deps, stage) }))
      }
      return false
    }

    if (area === 'batch' && parts.length === 1) {
      if (!context.jobs) return reply(response, 503, { error: 'jobs_unavailable' })
      const items = await parseBatch(loaded, await readRequestBody(request))
      const jobs: UiJobRecord[] = []
      const rejected: { readonly issue: string; readonly error: string }[] = []
      for (const item of items) {
        try { jobs.push(context.jobs.submit({ kind: `batch:${item.issue}`, issue: item.issue, actor, reason: 'Batch enqueue', run: runBatchItem(context, deps, item) })) }
        catch (error) { if (error instanceof UiJobConflictError) rejected.push({ issue: item.issue, error: error.message }); else throw error }
      }
      return reply(response, 202, { jobs, rejected })
    }
  } catch (error) { return sendFailure(response, error) }
  return false
}

export const actionRoutes: RouteModule = createActionRoutes()
