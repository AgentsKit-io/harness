import type { CommandRunner } from '../../adapters/command.js'
import { orcaTerminalClose, orcaWorktreeRemove } from '../../adapters/orca-cli.js'
import { createDispatchLedger, readActiveClaims } from '../../execution/coordination.js'
import { ensureBaseView } from '../../loop/base-view.js'
import type { LoadedLoopConfig, ModelReference } from '../../loop/config.js'
import { resolveConnectors } from '../../loop/connectors.js'
import { assessContract, contractIsFresh, generateContract, readStoredContract, writeStoredContract, type StoredContract } from '../../loop/contract.js'
import { listDispatched, markDispatchCancelled, readDeliveryState } from '../../loop/deliver.js'
import { runLoopDoctor } from '../../loop/doctor.js'
import { createHitlStore } from '../../loop/hitl.js'
import { createIssueQueue } from '../../loop/queue.js'
import { resumeIssue as clearPause } from '../../loop/resilience-state.js'
import { rankModels } from '../../loop/routing.js'
import { appendLoopEvent } from '../../loop/tick.js'
import type { Drift } from './contract.js'
import { syncProjection } from './store.js'

/**
 * The whole write surface of the control plane, narrowed to what the approved rewrite plan keeps in scope:
 * the wizard's contract step, enqueue/cancel/retry/archive/restore, resuming a resilience-paused issue, and
 * answering a pending decision. `plan.*`, `release.*`, manual tracker edits and the doctor/status/debrief/
 * observability/timeline/precheck surface stay CLI-only — nothing in the live UI ever exposed them, and the CLI
 * already covers them.
 *
 * `queue.ts` and `hitl.ts` are called directly here, not reimplemented — they are real engine integration
 * points (`tick.ts`'s `queue.mode: explicit` and `deliver.ts`'s worker-HITL relay both read them back), and
 * their own validation (queue's status machine, hitl's digest/anchor rules) is reused rather than duplicated.
 */

export interface ActionContext {
  readonly loaded: LoadedLoopConfig
  readonly runner: CommandRunner
}

const cleanupAlreadyGone = (error: unknown): boolean => (error instanceof Error ? error.message : String(error)).includes('selector_not_found')
const nowIso = (): string => new Date().toISOString()

// ---- contract (wizard step) -------------------------------------------------------------------------------

export interface ContractResult {
  readonly status: 'valid' | 'needs-input' | 'blocked'
  readonly contract: StoredContract
}

/** Ranked orchestrator candidates + the detached base-view checkout contract generation reads from. */
const contractDeps = async (context: ActionContext) => {
  const doctor = await runLoopDoctor({ loaded: context.loaded, runner: context.runner, probe: false })
  const view = await ensureBaseView(context.runner, context.loaded)
  return { root: view.path, candidates: rankModels(context.loaded.config, 'orchestrator', doctor.providers) }
}

/**
 * Generate or reuse a frozen contract for the wizard. A blocking ambiguity, or an explicit `contract.hitl[]`
 * request, becomes a `human.hitl-requested` event — the same event the tick-stage escalation path emits — so
 * there is one way a stage asks a human something, not a bespoke store per caller.
 */
export const generateOrReuseContract = async (context: ActionContext, issueId: string, options: { readonly refresh?: boolean } = {}): Promise<ContractResult> => {
  const { loaded, runner } = context
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  const issueDetail = await tracker.issue(issueId)
  const cached = options.refresh ? null : readStoredContract(loaded.stateDir, issueId)
  if (cached && contractIsFresh(cached, issueDetail, loaded.config.contract.reuseHours, new Date())) {
    return { status: assessContract(cached.contract).dispatchable ? 'valid' : 'needs-input', contract: cached }
  }

  const deps = await contractDeps(context)
  // Every HITL answer already on record for this issue, regardless of which contract digest asked it — reads
  // `hitl.ts` directly (the same store the motor's own materialize/answer flow uses) rather than a UI-side copy.
  const humanDecisions = createHitlStore(loaded.stateDir).list({ issue: issueId, status: 'answered' })
  const contractIssue = humanDecisions.length
    ? { ...issueDetail, description: `${issueDetail.description}\n\nHuman decisions from an earlier round:\n${humanDecisions.map((request) => `- ${request.question}: ${request.answer?.optionId}${request.answer?.freeText ? ` — ${request.answer.freeText}` : ''}`).join('\n')}` }
    : issueDetail

  const stored = await generateContract({ runner, config: loaded.config, root: deps.root, issue: contractIssue, candidates: deps.candidates })
  writeStoredContract(loaded.stateDir, stored)

  const ambiguities = stored.contract.ambiguities.filter((item) => item.blocking).map((item, index) => ({
    question: item.question,
    context: 'The contract marked this as a blocking ambiguity; the run resumes once you answer.',
    options: [
      { id: `proceed-${index}`, title: 'Proceed with the current reading', description: 'Use what the contract already assumed and continue.' },
      { id: `clarify-${index}`, title: 'Wait for more detail', description: 'Revise the issue before letting the run continue.' },
      { id: `example-${index}`, title: 'Give a concrete example', description: 'Add a real case to the issue to guide the next attempt.' },
    ],
    recommendedOptionId: `clarify-${index}`,
  }))
  const requests = stored.contract.hitl?.length ? stored.contract.hitl : ambiguities
  if (!requests.length) return { status: assessContract(stored.contract).dispatchable ? 'valid' : 'blocked', contract: stored }

  const hitl = createHitlStore(loaded.stateDir)
  const batchId = `contract:${issueId}:${stored.digest}`
  for (const [index, request] of requests.entries()) {
    const created = hitl.create({
      requestId: `${batchId}:${index}`, batchId, issue: issueId, role: 'orchestrator', stage: 'contract',
      question: request.question, context: request.context, options: request.options,
      recommendedOptionId: request.recommendedOptionId, digest: `${stored.digest}:hitl:${index}`,
      metadata: { contractDigest: stored.digest },
    })
    appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'human.hitl-requested', issue: issueId, requestId: created.requestId, batchId: created.batchId, role: created.role, stage: created.stage, question: created.question, context: created.context, options: created.options, recommendedOptionId: created.recommendedOptionId, digest: created.digest })
  }
  return { status: 'needs-input', contract: stored }
}

// ---- cancellation cleanup -----------------------------------------------------------------------------------

/**
 * Terminal, worktree, lease, tracker state — the real side effects of cancelling a run. Ported from the old
 * `cleanupActiveRun` near-unchanged: this logic was never the source of the instability, only its outcome was
 * lost across five reconciled stores. Now the outcome is one event (`ui.cleanup-completed`/`-failed`), so the
 * projection can never show "cancelled" while a worktree is still sitting there.
 */
export const cleanupRun = async (context: ActionContext, issue: string, runId: string): Promise<void> => {
  const { loaded, runner } = context
  const dispatch = listDispatched(loaded.stateDir).find((candidate) => candidate.issue === issue)
  const ledger = createDispatchLedger(loaded.stateDir)
  try {
    if (!dispatch) {
      if (!ledger.active().some((candidate) => candidate.issue === issue)) {
        appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'ui.cleanup-completed', issue, runId })
        return
      }
      throw new Error(`No dispatch record for ${issue}; cleanup cannot be confirmed.`)
    }
    const orca = { bin: loaded.config.orca.bin, timeoutMs: 60_000 }
    if (dispatch.terminal) {
      try { await orcaTerminalClose(runner, { terminal: dispatch.terminal }, orca) }
      catch (error) { if (!cleanupAlreadyGone(error)) throw new Error(`terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    try { await orcaWorktreeRemove(runner, { worktree: `id:${dispatch.worktreeId}`, force: true }, orca) }
    catch (error) { if (!cleanupAlreadyGone(error)) throw new Error(`worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`) }
    const lease = ledger.active().find((candidate) => candidate.leaseId === dispatch.leaseId)
    if (lease) ledger.release(lease, 'ui cancellation')
    const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
    await tracker.setState({ issue, to: loaded.config.delivery?.returnState ?? 'Todo', reason: 'UI cleanup completed' })
    markDispatchCancelled(loaded.stateDir, issue)
    appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'ui.cleanup-completed', issue, runId })
  } catch (error) {
    appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'ui.cleanup-failed', issue, runId, detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

// ---- run lifecycle (wizard confirm, cancel, retry, archive, restore) ---------------------------------------

export interface EnqueueRunInput {
  readonly issue: string
  readonly title?: string | null
  readonly url?: string | null
  readonly configHash: string
  readonly flow: string | null
  readonly builder: ModelReference
  readonly contractDigest: string
  readonly maxFixRounds: number
  readonly perIssueTokens: number
}

/** The wizard's confirmation step: `queue.ts` owns the run record (id, status machine, duplicate-active-run
 * check — the same store `tick.ts` reads for `queue.mode: explicit`); `ui.run-enqueued` only carries the phase
 * signal nothing else emits before a dispatch happens. */
export const enqueueRun = (context: ActionContext, input: EnqueueRunInput): { readonly runId: string } => {
  const { loaded } = context
  const at = new Date().toISOString()
  const run = createIssueQueue({ stateDir: loaded.stateDir }).enqueue({
    issue: input.issue, title: input.title ?? null, url: input.url ?? null,
    config: { configHash: input.configHash, flow: input.flow, builder: input.builder, maxFixRounds: input.maxFixRounds, perIssueTokens: input.perIssueTokens, roles: { orchestrator: 'project', reviewer: 'project', watcher: 'project', delivery: 'snapshot' } },
    contract: { digest: input.contractDigest, status: 'valid', frozenAt: at },
    preflight: { status: 'passed', checkedAt: at },
  })
  appendLoopEvent(loaded.stateDir, { at, type: 'ui.run-enqueued', issue: input.issue })
  syncProjection(loaded.stateDir)
  return { runId: run.id }
}

export const cancelRun = async (context: ActionContext, issue: string, runId: string): Promise<void> => {
  const { loaded } = context
  createIssueQueue({ stateDir: loaded.stateDir }).cancel(runId, { confirmActive: true, cleanupConfirmed: true })
  await cleanupRun(context, issue, runId)
  syncProjection(loaded.stateDir)
}

/** `queue.ts`'s own `retry` issues a fresh run id for the new attempt (its own attempt-chain bookkeeping);
 * `ui.run-enqueued` is re-emitted for the same reason a fresh confirm emits it — a new attempt is queued. */
export const retryRun = (context: ActionContext, issue: string, runId: string): { readonly runId: string } => {
  const { loaded } = context
  const run = createIssueQueue({ stateDir: loaded.stateDir }).retry(runId)
  appendLoopEvent(loaded.stateDir, { at: new Date().toISOString(), type: 'ui.run-enqueued', issue })
  syncProjection(loaded.stateDir)
  return { runId: run.id }
}

export const archiveRun = (context: ActionContext, runId: string): void => { createIssueQueue({ stateDir: context.loaded.stateDir }).archive(runId) }
export const restoreRun = (context: ActionContext, runId: string): void => { createIssueQueue({ stateDir: context.loaded.stateDir }).restore(runId) }

// ---- resolving a `needs-decision` issue (a PR closed without merge) -----------------------------------------

export type IssueDecision = 'close-issue' | 'reopen'

/** Only legal from `needs-decision` — a PR closed without merge, with nothing left to retry automatically.
 * `close-issue` sets the tracker to done; `reopen` returns it to the entry state for a fresh wizard run. */
export const decideIssue = async (context: ActionContext, issue: string, decision: IssueDecision): Promise<void> => {
  const { loaded, runner } = context
  const record = syncProjection(loaded.stateDir).issues[issue]
  if (record?.phase !== 'needs-decision') throw new Error(`${issue} is not waiting on a close-or-reopen decision.`)
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  const target = decision === 'close-issue' ? loaded.config.linear.doneState : loaded.config.delivery.returnState
  await tracker.setState({ issue, to: target, reason: decision === 'close-issue' ? 'PR closed without merge; human closed the issue' : 'PR closed without merge; human reopened for a fresh run' })
  appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'ui.issue-decided', issue, action: decision })
  syncProjection(loaded.stateDir)
}

// ---- resilience pause (distinct from a run failure: this clears the `issue.paused` label/counter) ----------

/** Removes `resilience.pausedLabel` on the tracker and clears the local consecutive-failure counter — the same
 * two things `ak-harness loop resume <issue>` does from the CLI. Not the same as retrying a run: a paused issue
 * never got as far as a dispatch attempt to retry. */
export const resumePausedIssue = async (context: ActionContext, issue: string): Promise<void> => {
  const { loaded, runner } = context
  clearPause(loaded.stateDir, issue)
  try {
    const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
    await tracker.removeLabels(issue, [loaded.config.resilience.pausedLabel])
  } catch { /* local pause recovery remains authoritative, whether the tracker call or its construction failed */ }
}

// ---- HITL decisions -------------------------------------------------------------------------------------

export interface AnswerDecisionInput {
  readonly requestId: string
  readonly optionId: string
  readonly freeText?: string
  readonly actor: string
}

export interface AnswerDecisionResult {
  /** True once every sibling request in the same batch has an answer — the caller's cue to actually resume the
   * stage that asked (a fresh tick for a pre-dispatch batch, a delivery pass for a review-stage one). */
  readonly batchReady: boolean
  readonly stage: string
}

/**
 * A thin wrapper over `hitl.ts`'s own `answer` (digest match against stale answers, the "None of the above"
 * anchor requiring free text, idempotency for a repeat answer) — reused rather than reimplemented, because
 * `deliver.ts`'s worker-HITL relay reads `hitl.ts`'s own file state back to learn an answer landed. Duplicating
 * that validation here would let the two drift.
 */
export const answerDecision = (context: ActionContext, issue: string, expectedDigest: string, input: AnswerDecisionInput): AnswerDecisionResult => {
  const { loaded } = context
  const hitl = createHitlStore(loaded.stateDir)
  const answered = hitl.answer(input.requestId, { optionId: input.optionId, ...(input.freeText ? { freeText: input.freeText } : {}), actor: input.actor, expectedDigest })
  appendLoopEvent(loaded.stateDir, {
    at: nowIso(), type: 'human.hitl-answered', issue, requestId: answered.requestId, batchId: answered.batchId,
    role: answered.role, stage: answered.stage, optionId: input.optionId, ...(answered.answer?.freeText ? { freeText: answered.answer.freeText } : {}),
    digest: expectedDigest, actor: input.actor,
  })
  const batchReady = hitl.batchReady(answered.batchId)
  if (batchReady) appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'human.hitl-batch-ready', issue, batchId: answered.batchId, requestId: input.requestId })
  syncProjection(loaded.stateDir)
  return { batchReady, stage: answered.stage }
}

// ---- reconciliation (loop vs tracker/Orca drift) ----------------------------------------------------------

/**
 * Settle an issue's drift locally, and only locally: release its dispatch lease, mark an unfinished dispatch
 * finished (frees the slot, keeps the record as evidence) and cancel an active queue run. No Orca call and no
 * tracker write — the tracker is the side that is right in every drift this settles, and a live worktree is left
 * for a human to inspect. Refuses when the issue has no drift, so it can never be used as a blind "force cancel".
 */
export const reconcileIssue = (context: ActionContext, issue: string, drift: readonly Drift[]): { readonly actions: readonly string[] } => {
  const { loaded } = context
  const mine = drift.filter((item) => item.issue === issue)
  if (!mine.length) throw new Error(`${issue} has no drift to reconcile.`)
  const actions: string[] = []
  const ledger = createDispatchLedger(loaded.stateDir)
  for (const lease of readActiveClaims(loaded.stateDir).filter((claim) => claim.issue === issue)) {
    ledger.release(lease, `ui reconcile: ${mine.map((item) => item.kind).join(', ')}`)
    actions.push('lease released')
  }
  const dispatched = listDispatched(loaded.stateDir).some((dispatch) => dispatch.issue === issue)
  if (dispatched && !readDeliveryState(loaded.stateDir, issue).finishedAt) { markDispatchCancelled(loaded.stateDir, issue); actions.push('dispatch marked finished') }
  const queue = createIssueQueue({ stateDir: loaded.stateDir })
  const run = queue.getLatestByIssue(issue)
  if (run && ['queued', 'dispatching', 'running', 'needs-input', 'blocked'].includes(run.status)) {
    queue.cancel(run.id, { confirmActive: true, cleanupConfirmed: true })
    actions.push(`run ${run.id} cancelled`)
  }
  appendLoopEvent(loaded.stateDir, { at: nowIso(), type: 'ui.cleanup-completed', issue, runId: run?.id ?? 'reconcile', reason: 'reconcile', kinds: mine.map((item) => item.kind) })
  syncProjection(loaded.stateDir)
  return { actions }
}
