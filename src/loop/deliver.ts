import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { dirname, join, relative, sep } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { atLeast, parseReviewResult, renderFindingsForWorker, runCodeReview, type CodeReviewOutcome } from '../adapters/code-review.js'
import { assessChecks, githubComment, githubCommentExists, githubCompare, githubLabelRemove, githubMerge, githubOpenPullRequests, githubPullRequest, githubPullRequestsForBranch, touchesProtectedPaths, type PullRequestSnapshot } from '../adapters/github-cli.js'
import { requireWritableTracker, resolveConnectors, type ScmConnector, type TrackerConnector } from './connectors.js'
import { issueBudget, modelForChange } from './budget.js'
import { assessBoundary, verifyCommandFor } from './layers.js'
import { installWorkerGuard } from './worker-guard.js'
import { orcaAccountList, orcaAgentHooks, orcaTerminalClose, orcaTerminalList, orcaWorktrees, orcaTerminalScreen, orcaTerminalSend, orcaTerminalWait, orcaWorktreeRemove, orcaWorktreeSet } from '../adapters/orca-cli.js'
import { detectProviders, remainingUsagePercent, type ProviderAvailability } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError, fail } from '../kernel/errors.js'
import { renderHandoffBrief } from './brief.js'
import { renderSkillsForHandoff } from './skills.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { loadLoopConfig, providerIdentity, resolveReviewSettings, type LoadedLoopConfig, type LoopConfig, type ModelReference } from './config.js'
import { classifyProviderFailure, extractResetsAt, readStoredContract } from './contract.js'
import { activeCooldowns, markProviderExhausted, readCooldowns } from './cooldown.js'
import { providerSpecs } from './doctor.js'
import { resolveCatalogCandidates } from './model-catalog/index.js'
import { rankModels, type RankedModel } from './routing.js'
import { appendLoopEvent, BRIEF_POINTER_PROMPT, briefPath, dispatchRecordPath, launchWorkerTerminal, readDispatchRecord, writeDispatchRecord, type DispatchRecordFile } from './tick.js'
import { intakeIssueId, discoverIntake, listIntake } from './github-intake.js'
import { createLoopEventBus, loadLoopPlugins, type LoopEventBus, type LoopEventPayload } from './event-bus.js'
import { attachNotifier } from './notify.js'
import { applyRoleSettings, resolveFlowSettings, resolveRoleSettings, workerPhaseEnabled, type EffectiveFlowSettings } from './flows.js'
import { assessDod, readDodEvidence, renderDodMarkdown } from './dod.js'
import { missingArtifacts, readPhaseArtifacts, readVerifyArtifact, verifyProofs, type PhaseArtifactName } from './artifacts.js'
import { readJsonFile } from '../kernel/json-file.js'
import { createIssueQueue } from './queue.js'
import { createInboxStore } from './inbox.js'
import { createLifecycleStore, type LifecyclePullRequest } from './lifecycle.js'

export type DeliverOutcome = 'waiting' | 'reviewed' | 'fix-round' | 'nudged' | 'handed-off' | 'merged' | 'held' | 'blocked' | 'stuck' | 'abandoned' | 'failed' | 'dry-run'

export interface DeliverResult {
  readonly issue: string
  readonly outcome: DeliverOutcome
  readonly reason: string
  readonly pr?: number
  readonly head?: string
  readonly review?: Pick<CodeReviewOutcome, 'status' | 'summary' | 'provider' | 'model'>
  readonly actions: readonly string[]
}

export interface DeliverReport {
  readonly status: 'ok' | 'idle'
  readonly generatedAt: string
  readonly dryRun: boolean
  readonly reviewer: string | null
  readonly results: readonly DeliverResult[]
  readonly notes: readonly string[]
}

export interface DeliveryHandoff {
  readonly at: string
  readonly fromProvider: string
  readonly fromModel: string
  readonly toProvider: string
  readonly toModel: string
  readonly reason: string
  readonly terminal: string | null
}

export interface DeliveryState {
  readonly issue: string
  readonly prNumber: number | null
  readonly reviews: Readonly<Record<string, { readonly status: CodeReviewOutcome['status']; readonly at: string; readonly provider: string; readonly model: string | null; readonly blocking: number; readonly attempts: number; readonly reason?: string }>>
  readonly fixRounds: number
  readonly nudges: readonly { readonly kind: 'idle' | 'conflict' | 'ci' | 'review' | 'handoff' | 'permission' | 'brief'; readonly at: string; readonly head: string | null }[]
  readonly handoffs: readonly DeliveryHandoff[]
  readonly heldFor: string | null
  /** A person's attested approval of a PR held for protected paths — valid only for this exact head. */
  readonly humanApproval?: { readonly head: string; readonly by: string; readonly at: string } | null
  readonly finishedAt: string | null
  readonly finalOutcome: DeliverOutcome | null
  /** Cancellation is a UI/control-plane terminal marker, not a delivery outcome. */
  readonly cancelledAt?: string | null
}

export interface DeliverInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  readonly dryRun?: boolean
  readonly onlyIssue?: string
  /** Test seam: skip the `terminal wait --for tui-idle` probe and assume this idleness. */
  readonly assumeIdle?: boolean
  /** Wall-clock budget for this deliver run; the review deadline is capped to fit inside it. */
  readonly budgetMs?: number
  /** An externally-owned event bus (e.g. `loop stage`, unifying every stage's events on one bus for that
   * invocation). When set, this call neither loads plugins nor attaches the notifier on it — the owner already
   * did, and the owner is the one who flushes it once the whole invocation is done. Omit to keep this call
   * self-sufficient, as every direct caller (`loop deliver`, tests, library use) needs it to be. */
  readonly bus?: LoopEventBus
}

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
const isMissingOrcaWorktree = (error: unknown): boolean => message(error).includes('selector_not_found')

export const deliveryStatePath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'delivery.json')
export const readDeliveryState = (stateDir: string, identifier: string): DeliveryState => {
  const path = deliveryStatePath(stateDir, identifier)
  const empty: DeliveryState = { issue: identifier, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null, cancelledAt: null }
  if (!existsSync(path)) return empty
  const parsed = readJsonFile(path, z.object({}).loose()) as Partial<DeliveryState> | null
  if (!parsed) return empty
  return { ...empty, ...parsed, handoffs: parsed.handoffs ?? [], nudges: parsed.nudges ?? [] }
}

/** Keep a cancelled dispatch visible as historical evidence without letting it consume a worker slot. */
export const markDispatchCancelled = (stateDir: string, identifier: string, at = new Date()): DeliveryState => {
  const state = readDeliveryState(stateDir, identifier)
  const next: DeliveryState = { ...state, finishedAt: state.finishedAt ?? at.toISOString(), heldFor: null, cancelledAt: state.cancelledAt ?? at.toISOString() }
  writeJsonAtomic(deliveryStatePath(stateDir, identifier), next)
  return next
}

/**
 * Record that a person reviewed a PR the loop held for protected paths, bound to the head they reviewed.
 *
 * The loop's own review and merge gates then run as for any PR; a new push changes the head and the approval no
 * longer applies. It is an attestation in the audit trail, not a secret: anything with a shell on this machine can
 * run it, so `by` is recorded in the event log and the approval says who vouched for which commit — never
 * a label on the PR, which a worker holding the same credentials could add to its own pull request.
 */
export const approveHeldDelivery = (loaded: LoadedLoopConfig, issue: string, input: { readonly head: string; readonly by: string; readonly now?: Date }): DeliveryState => {
  const state = readDeliveryState(loaded.stateDir, issue)
  const by = input.by.trim()
  if (!by) return fail('An approval names who approves (--by).', 'INVALID_INPUT')
  if (!state.heldFor) return fail(`${issue} is not held for a human; nothing to approve.`, 'INVALID_STATE')
  if (!state.heldFor.startsWith(input.head) || input.head.length < 7) return fail(`${issue} is held at ${state.heldFor.slice(0, 12)}, not ${input.head}; review that head (or wait for the loop to see the new one) and approve it by its SHA.`, 'STALE')
  const at = (input.now ?? new Date()).toISOString()
  const next: DeliveryState = { ...state, humanApproval: { head: state.heldFor, by, at } }
  writeJsonAtomic(deliveryStatePath(loaded.stateDir, issue), next)
  appendLoopEvent(loaded.stateDir, { at, type: 'pr.human-approved', issue, head: state.heldFor, by, pr: state.prNumber })
  return next
}

/**
 * Why a review came back incomplete, kept with the review. Without it "incomplete twice; needs a human look" sends
 * the human to re-run the reviewer by hand only to learn it was, say, one lens returning invalid structured output.
 */
const incompleteReason = (review: CodeReviewOutcome): { readonly reason?: string } => review.status === 'incomplete' ? { reason: review.summary } : {}

const resumableOutcomes = new Set<DeliverOutcome>(['blocked', 'stuck', 'abandoned', 'held'])
const lastReviewHead = (state: DeliveryState): string | null => {
  const heads = Object.keys(state.reviews)
  return heads.at(-1) ?? state.heldFor
}

/** Every issue the loop ever dispatched (finished or not) — callers that only care about in-flight work must filter on `readDeliveryState(...).finishedAt` themselves. */
export const listDispatched = (stateDir: string): readonly DispatchRecordFile[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  const paths: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'dispatch.json') paths.push(path)
    }
  }
  visit(dir)
  return paths.map((path) => {
    // Provider identifiers such as `owner/repository#217` are stored as nested folders.
    // Reconstruct the identifier before using the canonical dispatch reader.
    const identifier = relative(dir, dirname(path)).split(sep).join('/')
    return readDispatchRecord(stateDir, identifier)
  }).filter((record): record is DispatchRecordFile => record !== null && existsSync(dispatchRecordPath(stateDir, record.issue)))
}

const minutesBetween = (later: Date, earlier: string | number | null): number => earlier === null ? Number.POSITIVE_INFINITY : (later.getTime() - (typeof earlier === 'number' ? earlier : Date.parse(earlier))) / 60_000

interface Context {
  readonly loaded: LoadedLoopConfig
  readonly config: LoopConfig
  readonly runner: CommandRunner
  readonly now: () => Date
  readonly dryRun: boolean
  readonly reviewer: RankedModel | null
  readonly builder: RankedModel | null
  readonly providers: readonly ProviderAvailability[]
  readonly env: NodeJS.ProcessEnv
  readonly assumeIdle?: boolean
  readonly notes: string[]
  readonly reviewDeadlineMs: number
  readonly bus: LoopEventBus
  /** The tracker and code host this project selected. The engine never names Linear or GitHub. */
  /** Every reviewer candidate in order, so a small change can be routed to a cheaper one (cost lever 3). */
  readonly reviewerCandidates: readonly RankedModel[]
  readonly tracker: TrackerConnector
  readonly scm: ScmConnector
  /** Catalog-discovered builder candidates (`models.routing.mode: catalog`), already resolved once for the initial `builder` pick — reused by `pickHandoffBuilder` so a stuck-worker handoff considers the same pool instead of only YAML tiers. */
  readonly builderExtras: readonly ModelReference[]
}

const orcaOptions = (config: LoopConfig) => ({ bin: config.orca.bin, timeoutMs: config.orca.timeoutMs })

const saveState = (ctx: Context, state: DeliveryState): void => { if (!ctx.dryRun) writeJsonAtomic(deliveryStatePath(ctx.loaded.stateDir, state.issue), state) }
const event = (ctx: Context, payload: LoopEventPayload): void => { if (!ctx.dryRun) appendLoopEvent(ctx.loaded.stateDir, { at: ctx.now().toISOString(), ...payload }, ctx.bus) }

/** Recover a merge recorded by this loop when GitHub no longer lists the deleted head branch. */
const readMergedEvent = (stateDir: string, issue: string): { readonly pr: number; readonly head?: string; readonly sha?: string } | null => {
  const path = join(stateDir, 'events.ndjson')
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const line of lines.reverse()) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const pr = typeof record['pr'] === 'number' ? record['pr'] : null
      if (record['type'] !== 'pr.merged' || record['issue'] !== issue || pr === null || pr < 1) continue
      return {
        pr,
        ...(typeof record['head'] === 'string' ? { head: record['head'] } : {}),
        ...(typeof record['sha'] === 'string' ? { sha: record['sha'] } : {}),
      }
    } catch { /* ignore malformed historical lines */ }
  }
  return null
}

const readBlockingReviewFindings = (stateDir: string, issue: string, head: string, floor: CodeReviewOutcome['blocking'][number]['severity']): readonly CodeReviewOutcome['blocking'][number][] => {
  try {
    const path = join(stateDir, 'issues', issue, `review-${head.slice(0, 12)}.json`)
    if (!existsSync(path)) return []
    const parsed = parseReviewResult(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.findings.filter((finding) => atLeast(finding.severity, floor))
  } catch { return [] }
}

/** What a tool-permission prompt looks like on screen, across the agent CLIs the loop drives. */
const PERMISSION_PROMPT = /Permission required|Allow once|Allow always|Do you want to (?:proceed|allow|run)|approve this (?:command|action)/i

/**
 * Whether the worker is stopped at a tool-permission prompt — a question for a human, not idleness.
 *
 * Typing into it is not a nudge: the text lands in a dialog whose default is "allow", so the next Enter approves
 * whatever the agent asked for — typically the one command its own config marks as dangerous (`rm -rf`,
 * `git reset --hard`). Orca's `worktree ps` reports it as `permission`; the screen is the fallback.
 */
export const workerAwaitingPermission = async (ctx: Pick<Context, 'runner' | 'config'>, record: Pick<DispatchRecordFile, 'worktreeId' | 'terminal'>): Promise<string | null> => {
  try {
    const own = (await orcaWorktrees(ctx.runner, orcaOptions(ctx.config))).find((item) => item.id === record.worktreeId)
    if (own?.activity === 'permission') return 'Orca reports the worktree at a permission prompt'
  } catch { /* fall back to the screen */ }
  if (!record.terminal) return null
  try {
    const screen = (await orcaTerminalScreen(ctx.runner, { terminal: record.terminal }, orcaOptions(ctx.config))).split('\n').slice(-25).join('\n')
    const match = PERMISSION_PROMPT.exec(screen)
    if (match) return `the worker screen shows a permission prompt ("${match[0]}")`
  } catch { /* unknown is not a prompt */ }
  return null
}

/** How a coding-agent CLI says it ran out of usage on its own screen (opencode: "5 hour usage limit reached. It will reset in …"). */
const USAGE_LIMIT_ON_SCREEN = /usage limit reached|hit your (?:session|weekly|monthly|usage)?\s?limit|rate limit(?:ed| reached| exceeded)|quota exceeded|out of (?:credits|quota)/i

/**
 * The line on the worker's screen saying its provider is out of usage, or null.
 *
 * A worker in that state is not idle — its TUI keeps redrawing "retrying in 3h 45m" — so the idle path never saw
 * it, and a provider whose usage Orca does not report (opencode) was never marked exhausted: the issue sat until
 * the provider came back. The screen is the only place the CLI says it.
 */
export const workerAtUsageLimit = async (ctx: Pick<Context, 'runner' | 'config'>, record: Pick<DispatchRecordFile, 'terminal'>): Promise<string | null> => {
  if (!record.terminal) return null
  try {
    const screen = (await orcaTerminalScreen(ctx.runner, { terminal: record.terminal }, orcaOptions(ctx.config))).split('\n').slice(-12)
    return screen.find((line) => USAGE_LIMIT_ON_SCREEN.test(line))?.trim() ?? null
  } catch { return null }
}

const sendToWorker = async (ctx: Context, record: DispatchRecordFile, text: string, actions: string[]): Promise<boolean> => {
  if (!record.terminal) { actions.push('no terminal handle recorded; cannot nudge'); return false }
  const permission = ctx.dryRun ? null : await workerAwaitingPermission(ctx, record)
  if (permission) { actions.push(`not typing into ${record.terminal}: ${permission} — the text would answer it`); return false }
  if (ctx.dryRun) { actions.push(`would send to ${record.terminal}: ${text.split('\n')[0]?.slice(0, 80)}`); return true }
  const send = async (terminal: string) => orcaTerminalSend(ctx.runner, { terminal, text, enter: true, waitSubmitSeconds: 10 }, orcaOptions(ctx.config))
  let staleShell = false
  try {
    const terminal = (await orcaTerminalList(ctx.runner, { worktree: `id:${record.worktreeId}` }, orcaOptions(ctx.config))).find((item) => item.handle === record.terminal)
    // ponytail: a live Orca shell with no recorded agent command cannot make progress; reactivate it once.
    staleShell = Boolean(terminal && !terminal.command && (/git:\(|➜\s|\$\s/.test(terminal.preview) || (!terminal.preview.trim() && terminal.lastOutputAt === null)))
    if (staleShell) actions.push(`worker terminal ${record.terminal} is stale or a shell, not an active agent; reactivating`)
  } catch { /* send below remains the fallback when terminal metadata is unavailable */ }
  if (!staleShell) {
    try {
      const receipt = await send(record.terminal)
      if (receipt.accepted) { actions.push(`sent to worker terminal ${record.terminal}`); return true }
      actions.push(`terminal ${record.terminal} did not accept input`)
    } catch (error) { actions.push(`terminal send failed: ${message(error)}`) }
  }
  if (!ctx.builder) return false
  try {
    let brief: string
    try { brief = readFileSync(briefPath(ctx.loaded.stateDir, record.issue), 'utf8') }
    catch {
      const stored = readStoredContract(ctx.loaded.stateDir, record.issue)
      const frozen = stored
        ? `\n\n## Frozen contract (inline coordinator copy; digest ${stored.digest.slice(0, 12)})\n${JSON.stringify(stored.contract, null, 2)}\n`
        : ''
      brief = `Resume ${record.issue} on branch ${record.branch}. The coordinator has already frozen and validated the contract; the coordinator state directory is outside this isolated worktree, so do not block on a missing ${ctx.config.project.stateDir} file. Address the review findings, run \`${verifyCommandFor(ctx.config, record.labels ?? []).command}\`, commit and push, then report LOOP_WORKER_DONE ${record.issue}.${frozen}`
      actions.push(stored ? 'brief missing; generated recovery brief with inline contract' : 'brief missing; generated recovery brief')
    }
    const relaunched = await launchWorkerTerminal({ runner: ctx.runner, config: ctx.config, worktreeId: record.worktreeId, ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}), command: ctx.builder.tui, title: `loop ${record.issue}`, brief, idleTimeoutMs: 10_000 })
    if (!relaunched.accepted) { actions.push(`worker reactivation did not accept the brief in ${relaunched.terminal}`); return false }
    const updated = { ...record, terminal: relaunched.terminal }
    writeDispatchRecord(ctx.loaded.stateDir, updated)
    event(ctx, { type: 'worker.reactivated', issue: record.issue, terminal: relaunched.terminal, previousTerminal: record.terminal })
    const retry = await send(relaunched.terminal)
    actions.push(retry.accepted ? `sent to reactivated worker terminal ${relaunched.terminal}` : `reactivated terminal ${relaunched.terminal} did not accept input`)
    return retry.accepted
  } catch (error) { actions.push(`worker reactivation failed: ${message(error)}`); return false }
}

/**
 * The worker's own terminal often already explains the blocker in plain language (e.g. "BLOCKED: Orca runtime
 * unavailable" or a sandboxed `index.lock` error) — reading it is a plain `terminal read`, no orchestration
 * mutation involved, so it works from this headless process. Best-effort: a capture failure must never block the
 * escalation itself.
 */
const captureWorkerOutput = async (ctx: Context, terminal: string | null): Promise<string | null> => {
  if (!terminal) return null
  try {
    const screen = (await orcaTerminalScreen(ctx.runner, { terminal }, orcaOptions(ctx.config))).trim()
    return screen ? screen.slice(-2000) : null
  } catch { return null }
}

const escalateTracker = async (ctx: Context, record: DispatchRecordFile, kind: 'stuck' | 'blocked' | 'abandoned', body: string, actions: string[]): Promise<void> => {
  if (ctx.dryRun) { actions.push(`would mark ${kind} in ${ctx.tracker.id} and Orca`); return }
  const workerOutput = await captureWorkerOutput(ctx, record.terminal)
  const fullBody = workerOutput ? `${body}\n\n<details><summary>Worker's last terminal output</summary>\n\n\`\`\`\n${workerOutput}\n\`\`\`\n\n</details>` : body
  if (workerOutput) actions.push('captured worker terminal output for the escalation')
  try {
    await ctx.tracker.comment({ issue: record.issue, body: `${fullBody}\n\n<!-- loop:${kind}:${record.leaseId} -->`, dedupeKey: `${kind}:${record.issue}:${record.leaseId}` })
    if (ctx.tracker.id === 'github') await ctx.tracker.transitions.transition({ tracker: ctx.tracker.id, issue: record.issue, to: ctx.config.linear.blockedLabel, reason: `loop ${kind}` })
    else {
      await ctx.tracker.addLabels(record.issue, [ctx.config.linear.blockedLabel])
      await ctx.tracker.transitions.transition({ tracker: ctx.tracker.id, issue: record.issue, to: ctx.config.delivery.returnState, reason: `loop ${kind}` })
    }
    // Release the claim, under `queueOwnership: 'unassigned'`. Returning an issue to the queue state
    // while it still carries this machine's assignee would make it invisible to the queue — which
    // filters on "no assignee" — so it would sit in `Ready` forever, owned by a worker that is gone.
    if (ctx.config.linear.queueOwnership === 'unassigned') {
      await ctx.tracker.release(record.issue)
      actions.push(`${ctx.tracker.id}: assignee cleared (claim released)`)
    }
    actions.push(ctx.tracker.id === 'github' ? `${ctx.tracker.id}: comment + blocked lifecycle state` : `${ctx.tracker.id}: comment + ${ctx.config.linear.blockedLabel} + ${ctx.config.delivery.returnState}`)
  } catch (error) {
    const detail = message(error)
    actions.push(`${ctx.tracker.id} escalation failed: ${detail}`)
    event(ctx, { type: 'tracker.sync-failed', issue: record.issue, operation: `escalate:${kind}`, error: detail })
    createInboxStore(ctx.loaded.stateDir).upsert({ issue: record.issue, gate: 'sync.failed', title: 'Sincronização remota pendente', message: `${ctx.tracker.id} não aceitou a atualização de lifecycle: ${detail}`, fingerprint: `tracker:${ctx.tracker.id}:escalate:${kind}:${detail}`, actions: ['retry', 'respond'] })
  }
  try { await orcaWorktreeSet(ctx.runner, { worktree: `id:${record.worktreeId}`, comment: `LOOP ${kind.toUpperCase()}: ${body.split('\n')[0]?.slice(0, 120)}` }, orcaOptions(ctx.config)); actions.push('Orca worktree comment set') } catch (error) { actions.push(`Orca comment failed: ${message(error)}`) }
}

const reopenFinishedIssue = async (ctx: Context, record: DispatchRecordFile, state: DeliveryState, pr: PullRequestSnapshot): Promise<DeliveryState> => {
  const previousHead = lastReviewHead(state)
  if (!state.finishedAt || !state.finalOutcome || !resumableOutcomes.has(state.finalOutcome) || !previousHead || previousHead === pr.headSha) return state
  const next: DeliveryState = { ...state, finishedAt: null, finalOutcome: null, fixRounds: 0, heldFor: null, nudges: [] }
  saveState(ctx, next)
  event(ctx, { type: 'worker.reopened', issue: record.issue, pr: pr.number, previousHead, head: pr.headSha, previousOutcome: state.finalOutcome })
  ctx.notes.push(`${record.issue}: reopened after a new PR head (${pr.headSha.slice(0, 7)})`)
  if (!ctx.dryRun) {
    try {
      await ctx.tracker.removeLabels(record.issue, [ctx.tracker.id === 'github' ? ctx.config.github.issues.labels.blocked : ctx.config.linear.blockedLabel])
      await ctx.tracker.transitions.transition({ tracker: ctx.tracker.id, issue: record.issue, to: ctx.config.linear.inProgressState, reason: `new PR head ${pr.headSha.slice(0, 7)}` })
    } catch (error) { ctx.notes.push(`${record.issue}: ${ctx.tracker.id} reopen update failed: ${message(error)}`) }
  }
  return next
}

/** `dry-run` is not an outcome anything finishes on: this function returns before writing, so the type says so. */
const finish = (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, outcome: Exclude<DeliverOutcome, 'dry-run'>, reason: string): void => {
  if (ctx.dryRun) return
  if (lease) { try { createDispatchLedger(ctx.loaded.stateDir).release(lease, `${outcome}: ${reason}`) } catch (error) { ctx.notes.push(`lease release for ${record.issue} failed: ${message(error)}`) } }
  saveState(ctx, { ...state, finishedAt: ctx.now().toISOString(), finalOutcome: outcome })
  event(ctx, { type: `worker.${outcome}`, issue: record.issue, reason, worktreeId: record.worktreeId })
}

/**
 * Stop delivering an issue whose dispatch tripped a resource ceiling (`delivery.maxDispatchMinutes` or
 * `resilience.maxUsageDeltaPercent`) instead of letting a runaway worker keep spending. There is no way to count
 * a worker CLI's own model/tool calls (it is opaque), so this is the loop's cost/time circuit breaker: same
 * escalation shape as a stuck worker (Linear comment + label + `returnState`, worktree preserved for inspection,
 * lease released) so a human can look at what the worker was doing.
 */
const tripCircuitBreaker = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, kind: 'cost-guard' | 'max-duration', reason: string): Promise<DeliverResult> => {
  const actions: string[] = []
  await escalateTracker(ctx, record, 'blocked', `**Loop: stopped (${kind})** — ${reason}. The worktree was preserved for inspection; the slot was released and the issue returned to ${ctx.config.delivery.returnState}.`, actions)
  event(ctx, { type: `${kind}.tripped`, issue: record.issue, reason })
  finish(ctx, record, lease, state, 'blocked', reason)
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'blocked', reason, actions }
}

const providerUnavailable = (ctx: Context, providerId: string): boolean => {
  const match = ctx.providers.find((provider) => provider.id === providerId)
  return !match || !match.available
}

const pickHandoffBuilder = (ctx: Context, record: DispatchRecordFile): RankedModel | null => {
  const ranked = rankModels(ctx.config, 'builder', ctx.providers, ctx.builderExtras)
  const different = ranked.find((candidate) => candidate.provider !== record.provider || candidate.model !== record.model)
  return different ?? null
}

const canHandoff = (ctx: Context, record: DispatchRecordFile, state: DeliveryState, next: RankedModel | null): next is RankedModel => {
  const cfg = ctx.config.delivery.handoff
  if (!cfg.enabled || !next) return false
  if (state.handoffs.length >= cfg.maxHandoffs) return false
  if (cfg.onlyWhenProviderUnavailable && !providerUnavailable(ctx, record.provider)) return false
  return true
}

const performHandoff = async (
  ctx: Context,
  record: DispatchRecordFile,
  state: DeliveryState,
  next: RankedModel,
  reason: string,
  actions: string[],
): Promise<DeliverResult> => {
  // What the previous worker was given, told to the next one as cheaply as it can be told: a pointer where the
  // file on disk still hashes to the record, the whole file where it does not.
  const skillsBlock = renderSkillsForHandoff(ctx.loaded.root, record.skills ?? [], ctx.config.brief.maxSkillChars)
  if (skillsBlock.referenced.length) actions.push(`skills referenced by digest: ${skillsBlock.referenced.join(', ')}`)
  if (skillsBlock.resent.length) actions.push(`skills re-sent in full (changed or missing): ${skillsBlock.resent.join(', ')}`)
  const brief = renderHandoffBrief({
    issue: record.issue,
    issueUrl: record.url,
    config: ctx.config,
    branch: record.branch,
    worktree: record.worktree,
    previousProvider: record.provider,
    previousModel: record.model,
    provider: next.provider,
    model: next.model,
    contractDigest: record.contractDigest,
    reason,
    ...(record.briefDigest ? { briefDigest: record.briefDigest } : {}),
    ...(skillsBlock.text ? { skillsBlock: skillsBlock.text } : {}),
  })
  if (ctx.dryRun) {
    actions.push(`would hand off ${record.provider}/${record.model} → ${next.provider}/${next.model} on ${record.branch}`)
    return { issue: record.issue, outcome: 'dry-run', reason: `handoff ready: ${reason}`, actions }
  }
  const title = `loop-handoff ${record.issue} ${next.provider}`
  // The new provider gets its own real-time enforcement installed before its terminal opens — a handoff changes
  // which hook format (or none, for codex) applies, so this cannot just carry over from the previous provider.
  const workerGuard = installWorkerGuard({ worktreePath: record.worktreePath, provider: next.provider, config: ctx.config })
  const launched = await launchWorkerTerminal({
    runner: ctx.runner,
    config: ctx.config,
    worktreeId: record.worktreeId,
    ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
    command: next.tui,
    title,
    brief,
  })
  actions.push(`handed off to ${next.provider}/${next.model} on terminal ${launched.terminal}${launched.accepted ? '' : ' (brief not confirmed)'}`)
  const updated: DispatchRecordFile = {
    ...record,
    terminal: launched.terminal,
    provider: next.provider,
    model: next.model,
    workerGuardInstalled: workerGuard.installed,
    briefAccepted: launched.accepted,
  }
  writeDispatchRecord(ctx.loaded.stateDir, updated)
  const handoff: DeliveryHandoff = {
    at: ctx.now().toISOString(),
    fromProvider: record.provider,
    fromModel: record.model,
    toProvider: next.provider,
    toModel: next.model,
    reason,
    terminal: launched.terminal,
  }
  const nextState: DeliveryState = {
    ...state,
    handoffs: [...state.handoffs, handoff],
    nudges: [...state.nudges, { kind: 'handoff', at: handoff.at, head: null }],
  }
  saveState(ctx, nextState)
  event(ctx, {
    type: 'worker.handed-off',
    issue: record.issue,
    from: `${record.provider}/${record.model}`,
    to: `${next.provider}/${next.model}`,
    worktreeId: record.worktreeId,
    branch: record.branch,
    reason,
    briefAccepted: launched.accepted,
  })
  try {
    await orcaWorktreeSet(ctx.runner, {
      worktree: `id:${record.worktreeId}`,
      comment: `LOOP HANDOFF: ${record.provider}/${record.model} → ${next.provider}/${next.model} (${reason})`,
    }, orcaOptions(ctx.config))
  } catch (error) { actions.push(`Orca comment failed: ${message(error)}`) }
  return { issue: record.issue, outcome: 'handed-off', reason: `handed off to ${next.provider}/${next.model}: ${reason}`, actions }
}

const handleNoPullRequest = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState): Promise<DeliverResult> => {
  const actions: string[] = []
  const now = ctx.now()
  let terminalAlive = false
  let lastOutputAt: number | null = null
  try {
    const terminals = await orcaTerminalList(ctx.runner, { worktree: `id:${record.worktreeId}` }, orcaOptions(ctx.config))
    const own = terminals.find((terminal) => terminal.handle === record.terminal) ?? terminals[0]
    terminalAlive = Boolean(own && own.status !== 'orphaned' && own.status !== 'disconnected')
    lastOutputAt = own?.lastOutputAt ?? null
  } catch (error) { actions.push(`terminal list failed: ${message(error)}`) }
  const sinceDispatch = minutesBetween(now, record.dispatchedAt)
  const sinceOutput = Math.min(sinceDispatch, minutesBetween(now, lastOutputAt))
  const idleTimeout = ctx.config.delivery.workerIdleTimeoutMin
  const nextBuilder = pickHandoffBuilder(ctx, record)
  const unavailable = providerUnavailable(ctx, record.provider)

  if (!terminalAlive) {
    if (sinceDispatch < 5) return { issue: record.issue, outcome: 'waiting', reason: 'worker terminal not visible yet', actions }
    if (canHandoff(ctx, record, state, nextBuilder)) {
      return performHandoff(ctx, record, state, nextBuilder, unavailable ? 'previous terminal gone and provider unavailable' : 'previous terminal gone', actions)
    }
    await escalateTracker(ctx, record, 'stuck', `**Loop: worker stuck** — the worker terminal for \`${record.worktree}\` is gone and no pull request was opened. The worktree was preserved for inspection; the slot was released.`, actions)
    finish(ctx, record, lease, state, 'stuck', 'terminal gone before PR')
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'stuck', reason: 'worker terminal gone before a PR was opened', actions }
  }

  // A worker at a permission prompt is waiting for a person, whatever the idle clock says. Hold it — no nudge, no
  // handoff, no relaunch — and keep the lease: once someone answers, the same worker carries on.
  const permission = await workerAwaitingPermission(ctx, record)
  if (permission) {
    if (!state.nudges.some((nudge) => nudge.kind === 'permission' && minutesBetween(now, nudge.at) < idleTimeout)) {
      event(ctx, { type: 'worker.permission-wait', issue: record.issue, terminal: record.terminal, reason: permission })
      if (!ctx.dryRun) saveState(ctx, { ...state, nudges: [...state.nudges, { kind: 'permission', at: now.toISOString(), head: null }] })
    }
    actions.push(`${permission}; left for a human to answer in terminal ${record.terminal}`)
    return { issue: record.issue, outcome: 'held', reason: `worker waiting at a permission prompt (${permission}) — answer it in Orca`, actions }
  }

  // Out of usage: mark the provider exhausted (its reset time when the CLI printed one) and hand the task to a
  // builder from ANOTHER provider in the same worktree. The exhausted TUI is closed first — left alone it resumes at
  // the reset and two agents would share one worktree; if it cannot be closed, nothing is handed off.
  const limitLine = await workerAtUsageLimit(ctx, record)
  if (limitLine) {
    const resetsAt = extractResetsAt(limitLine, now)
    if (!ctx.dryRun) {
      const entry = markProviderExhausted(ctx.loaded.stateDir, record.provider, { initialMin: ctx.config.models.cooldown.initialMin, maxMin: ctx.config.models.cooldown.maxMin, reason: `quota: ${limitLine.slice(0, 200)}`, resetsAt, now })
      event(ctx, { type: 'provider.cooldown', provider: record.provider, kind: 'quota', until: entry.until, source: 'worker-screen' })
      actions.push(`${record.provider} marked cooling down until ${entry.until} (worker screen: ${limitLine.slice(0, 80)})`)
    }
    const other = rankModels(ctx.config, 'builder', ctx.providers, ctx.builderExtras).find((candidate) => candidate.provider !== record.provider) ?? null
    const cfg = ctx.config.delivery.handoff
    if (!cfg.enabled || !other || state.handoffs.length >= cfg.maxHandoffs) return { issue: record.issue, outcome: 'waiting', reason: `${record.provider} is out of usage and no other builder can take over`, actions }
    if (!ctx.dryRun) {
      try { await orcaTerminalClose(ctx.runner, { terminal: record.terminal as string }, orcaOptions(ctx.config)) } catch (error) {
        return { issue: record.issue, outcome: 'held', reason: `${record.provider} is out of usage, but its terminal could not be closed (${message(error)}); not handing off into a shared worktree`, actions }
      }
    }
    return performHandoff(ctx, record, state, other, `${record.provider} out of usage (${limitLine.slice(0, 80)})`, actions)
  }

  let idle = ctx.assumeIdle ?? false
  if (ctx.assumeIdle === undefined && record.terminal) {
    try { idle = (await orcaTerminalWait(ctx.runner, { terminal: record.terminal, for: 'tui-idle', timeoutMs: 1_500 }, orcaOptions(ctx.config))).satisfied } catch { idle = false }
  }
  // The terminal never confirmed the brief and sits idle: it most likely never received it (observed, a prompt typed
  // while the shell was still starting the agent). Waiting out the idle timeout would burn it doing nothing — send
  // the pointer once, now.
  if (idle && record.briefAccepted === false && !state.nudges.some((nudge) => nudge.kind === 'brief')) {
    const sent = await sendToWorker(ctx, record, BRIEF_POINTER_PROMPT, actions)
    if (!ctx.dryRun) saveState(ctx, { ...state, nudges: [...state.nudges, { kind: 'brief', at: now.toISOString(), head: null }] })
    event(ctx, { type: 'worker.nudged', issue: record.issue, kind: 'brief' })
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'nudged' : 'waiting', reason: 'brief never confirmed; sent again', actions }
  }
  if (!idle || sinceOutput < idleTimeout) {
    return { issue: record.issue, outcome: 'waiting', reason: idle ? `worker idle for ${Math.round(sinceOutput)} min (< ${idleTimeout})` : 'worker active', actions }
  }

  // Idle past timeout: prefer handoff when the current provider cannot continue.
  if (canHandoff(ctx, record, state, nextBuilder) && unavailable) {
    return performHandoff(ctx, record, state, nextBuilder, `idle ${Math.round(sinceOutput)} min and ${record.provider} unavailable (usage/cooldown)`, actions)
  }

  const idleNudges = state.nudges.filter((nudge) => nudge.kind === 'idle')
  const lastNudge = idleNudges.at(-1)
  if (!lastNudge || minutesBetween(now, lastNudge.at) < idleTimeout) {
    if (lastNudge) return { issue: record.issue, outcome: 'waiting', reason: 'nudged recently; waiting for the worker to open the PR', actions }
    const sent = await sendToWorker(ctx, record, `Loop check-in: the terminal has been idle for ${Math.round(sinceOutput)} minutes and no pull request exists for branch ${record.branch}. Your task brief is in .ak-loop/brief.md at the root of this worktree — read it first if you have not. Continue from \`git status\`: finish the contract outcomes, run the project verification, push, open the PR exactly as the brief describes, then print LOOP_WORKER_DONE ${record.issue}. If you are blocked, run \`orca worktree set --worktree active --comment "BLOCKED: <reason>" --json\` and stop.`, actions)
    saveState(ctx, { ...state, nudges: [...state.nudges, { kind: 'idle', at: now.toISOString(), head: null }] })
    event(ctx, { type: 'worker.nudged', issue: record.issue, kind: 'idle' })
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'nudged' : 'waiting', reason: 'idle without PR; nudged once', actions }
  }

  // After a failed nudge window: hand off only when the current provider cannot continue.
  if (canHandoff(ctx, record, state, nextBuilder)) {
    return performHandoff(ctx, record, state, nextBuilder, `idle after nudge and ${record.provider} unavailable`, actions)
  }

  await escalateTracker(ctx, record, 'stuck', `**Loop: worker stuck** — idle for ${Math.round(sinceOutput)} minutes after a check-in, no pull request on \`${record.branch}\`. Worktree \`${record.worktree}\` was preserved; the slot was released and the issue returned to ${ctx.config.delivery.returnState}.`, actions)
  finish(ctx, record, lease, state, 'stuck', 'idle after nudge without PR')
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'stuck', reason: 'idle after nudge without PR', actions }
}

const complete = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot, mergeSha: string | null, actions: string[], mergedBy: 'loop' | 'outside' = 'loop'): Promise<DeliverResult> => {
  if (!ctx.dryRun) {
    try {
      await ctx.tracker.attach({ issue: record.issue, url: pr.url, title: `PR #${pr.number}`, dedupeKey: `attach:${record.issue}:${pr.number}` })
      // Say who merged: "after a clean review and green checks" is only true when the loop made the call.
      const how = mergedBy === 'loop' ? 'after a clean review and green checks' : 'by a person, outside the loop — the loop\'s own review and checks did not decide it'
      await ctx.tracker.comment({ issue: record.issue, body: `**Loop: merged** — ${pr.url}${mergeSha ? ` as \`${mergeSha.slice(0, 12)}\`` : ''} ${how}. Worker: \`${record.provider}/${record.model}\`.\n\n<!-- loop:merged:${pr.number} -->`, dedupeKey: `merged:${record.issue}:${pr.number}` })
      await ctx.tracker.transitions.transition({ tracker: ctx.tracker.id, issue: record.issue, to: ctx.config.linear.doneState, reason: `PR #${pr.number} merged` })
      actions.push(`${ctx.tracker.id}: attached PR, commented, → ${ctx.config.linear.doneState}`)
      // A merged issue is no longer blocked or waiting for information — clear the flags the loop itself set on the way.
      try { await ctx.tracker.removeLabels(record.issue, [ctx.tracker.id === 'github' ? ctx.config.github.issues.labels.blocked : ctx.config.linear.blockedLabel, ctx.config.linear.needsInfoLabel]) } catch (error) { actions.push(`clearing blocked/needs-info labels failed: ${message(error)}`) }
    } catch (error) {
      const detail = message(error)
      actions.push(`${ctx.tracker.id} completion failed: ${detail}`)
      event(ctx, { type: 'tracker.sync-failed', issue: record.issue, operation: 'completion', error: detail })
      createInboxStore(ctx.loaded.stateDir).upsert({ issue: record.issue, gate: 'sync.failed', title: 'Sincronização remota pendente', message: `${ctx.tracker.id} não sincronizou a conclusão: ${detail}`, fingerprint: `tracker:${ctx.tracker.id}:completion:${detail}`, actions: ['retry', 'respond'], data: { pr: pr.number, runId: record.queueRunId ?? null } })
    }
    try { await orcaWorktreeSet(ctx.runner, { worktree: `id:${record.worktreeId}`, comment: `LOOP MERGED: PR #${pr.number}` }, orcaOptions(ctx.config)) } catch (error) {
      if (isMissingOrcaWorktree(error)) actions.push('Orca worktree already absent; comment skipped')
      else actions.push(`Orca comment failed: ${message(error)}`)
    }
    if (ctx.config.delivery.cleanupWorktree) {
      try { await orcaWorktreeRemove(ctx.runner, { worktree: `id:${record.worktreeId}`, force: true }, orcaOptions(ctx.config)); actions.push('worktree removed') } catch (error) {
        if (isMissingOrcaWorktree(error)) actions.push('worktree already absent; cleanup reconciled')
        else actions.push(`worktree removal failed (kept): ${message(error)}`)
      }
    }
  } else actions.push('would attach PR, comment, move to Done, and clean the worktree')
  finish(ctx, record, lease, { ...state, prNumber: pr.number }, 'merged', `PR #${pr.number}`)
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'merged', reason: `PR #${pr.number} merged`, pr: pr.number, head: pr.headSha, actions }
}

const blockAfterRounds = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot, why: string, actions: string[]): Promise<DeliverResult> => {
  await escalateTracker(ctx, record, 'blocked', `**Loop: blocked after ${state.fixRounds} fix round(s)** — ${why}. PR: ${pr.url}. The worktree and PR stay open for a human; the slot was released.`, actions)
  if (!ctx.dryRun) { try { await githubComment(ctx.runner, { repo: ctx.config.project.repo, number: pr.number, body: `**Loop: blocked** — ${why}. Fix rounds exhausted (${state.fixRounds}/${flowFor(ctx, record).maxFixRounds}); a human needs to take over.\n\n<!-- loop:blocked:${pr.headSha} -->` }) } catch (error) { actions.push(`PR comment failed: ${message(error)}`) } }
  finish(ctx, record, lease, { ...state, prNumber: pr.number }, 'blocked', why)
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'blocked', reason: why, pr: pr.number, head: pr.headSha, actions }
}

/** What makes two review findings the same finding across heads: the file and the title, not the line (code moves). */
const findingKey = (finding: Pick<CodeReviewOutcome['blocking'][number], 'file' | 'title'>): string => `${finding.file ?? ''}::${finding.title.trim().toLowerCase()}`

/**
 * Whether this review round only DISCOVERED problems — none of its findings was raised at an earlier head.
 *
 * A review re-reads the whole change at every head, so a worker that fixes everything it was told can still get a
 * fresh finding each round. Observed: three rounds, three different findings, all fixed, and the issue blocked at
 * `maxFixRounds` — the limit was spent on the reviewer's discovery, not on a worker failing to fix. Such rounds do
 * not count against `maxFixRounds`; a finding that persists across heads still does, and a hard ceiling of twice
 * the limit in total review rounds keeps the cost bounded.
 */
const discoveryOnly = (ctx: Context, record: DispatchRecordFile, state: DeliveryState, findings: readonly CodeReviewOutcome['blocking'][number][]): boolean => {
  const earlierHeads = [...new Set(state.nudges.filter((nudge) => nudge.kind === 'review' && nudge.head).map((nudge) => nudge.head as string))]
  if (!earlierHeads.length || !findings.length) return false
  const earlier = new Set(earlierHeads.flatMap((head) => readBlockingReviewFindings(ctx.loaded.stateDir, record.issue, head, 'nit').map(findingKey)))
  return findings.every((finding) => !earlier.has(findingKey(finding)))
}

const fixRound = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot, kind: 'ci' | 'review' | 'conflict', text: string, why: string, actions: string[], findings: readonly CodeReviewOutcome['blocking'][number][] = []): Promise<DeliverResult> => {
  const already = state.nudges.some((nudge) => nudge.kind === kind && nudge.head === pr.headSha)
  if (already) return { issue: record.issue, outcome: 'waiting', reason: `${kind} nudge already sent for head ${pr.headSha.slice(0, 7)}; waiting for a new push`, pr: pr.number, head: pr.headSha, actions }
  const limit = flowFor(ctx, record).maxFixRounds
  const reviewRounds = state.nudges.filter((nudge) => nudge.kind === 'review').length
  const discovery = kind === 'review' && reviewRounds < limit * 2 && discoveryOnly(ctx, record, state, findings)
  if (discovery) actions.push(`review round ${reviewRounds + 1}: every finding is new at this head (discovery), not counted against maxFixRounds (${state.fixRounds}/${limit})`)
  const counts = kind !== 'conflict' && !discovery
  if (kind === 'review' && reviewRounds >= limit * 2) return blockAfterRounds(ctx, record, lease, state, pr, `${why} — ${reviewRounds} review rounds, the ceiling of twice maxFixRounds`, actions)
  if (counts && state.fixRounds >= limit) return blockAfterRounds(ctx, record, lease, state, pr, why, actions)
  // The worker already has its brief; the round points back at it by digest instead of re-sending what it holds.
  // Delta, not repetition — and the anchor is what lets a worker that lost the thread find it again.
  const anchor = record.briefDigest ? `\n\nContext: contract \`${record.contractDigest.slice(0, 12)}\` · brief \`${record.briefDigest.slice(0, 12)}\`${record.skills?.length ? ` · pinned skills: ${record.skills.map((skill) => `\`${skill.path}\``).join(', ')} — re-read them in the worktree, they are unchanged for this run` : ''}.` : ''
  const sent = await sendToWorker(ctx, record, `${text}${anchor}`, actions)
  const next: DeliveryState = { ...state, prNumber: pr.number, fixRounds: sent && counts ? state.fixRounds + 1 : state.fixRounds, nudges: sent ? [...state.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] : state.nudges }
  saveState(ctx, next)
  if (sent) event(ctx, { type: `worker.${kind}-round`, issue: record.issue, pr: pr.number, head: pr.headSha, round: next.fixRounds })
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'fix-round' : 'waiting', reason: why, pr: pr.number, head: pr.headSha, actions }
}

/**
 * The flow in force for one dispatched item, from the labels, project and priority frozen at dispatch time. A gate
 * must be decided by what the issue looked like when it entered, never by what someone edited while it ran.
 */
const flowFor = (ctx: Context, record: DispatchRecordFile): EffectiveFlowSettings => {
  const resolved = resolveFlowSettings(ctx.config, {
    labels: record.labels ?? [],
    project: record.project ?? null,
    priorityLabel: record.priorityLabel ?? null,
  })
  // Queue-confirmed limits are frozen at dispatch. Legacy records keep resolving their historical flow settings.
  if (record.frozenFlow === undefined && record.frozenMaxFixRounds === undefined) return resolved
  const flow = record.frozenFlow === undefined ? resolved.flow : { name: record.frozenFlow, source: record.frozenFlow === null ? 'none' as const : 'default' as const, matched: null, profile: record.frozenFlow ? ctx.config.flows.profiles[record.frozenFlow] ?? null : null }
  return {
    ...resolved,
    flow,
    review: { ...resolveReviewSettings(ctx.config, record.labels ?? []), ...(flow.profile?.review ?? {}) },
    merge: { ...ctx.config.delivery.merge, ...(flow.profile?.merge ?? {}) },
    maxFixRounds: record.frozenMaxFixRounds ?? flow.profile?.maxFixRounds ?? ctx.config.delivery.maxFixRounds,
  }
}

const syncReviewTracker = async (ctx: Context, record: DispatchRecordFile, pr: PullRequestSnapshot, actions: string[]): Promise<void> => {
  if (ctx.dryRun) { actions.push(`would move ${ctx.tracker.id} issue to ${ctx.config.linear.reviewState}`); return }
  try {
    await ctx.tracker.setState({ issue: record.issue, to: ctx.config.linear.reviewState, reason: `PR #${pr.number} opened; review lifecycle is now remote-authoritative` })
    actions.push(`${ctx.tracker.id}: → ${ctx.config.linear.reviewState}`)
  } catch (error) {
    const detail = message(error)
    actions.push(`${ctx.tracker.id} review sync failed: ${detail}`)
    event(ctx, { type: 'tracker.sync-failed', issue: record.issue, operation: 'review-state', error: detail })
    createInboxStore(ctx.loaded.stateDir).upsert({ issue: record.issue, gate: 'sync.failed', title: 'Sincronização remota pendente', message: `${ctx.tracker.id} não atualizou a issue para revisão: ${detail}`, fingerprint: `tracker:${ctx.tracker.id}:review-state:${detail}`, actions: ['retry', 'respond'], data: { pr: pr.number, runId: record.queueRunId ?? null } })
  }
}

const handlePullRequest = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot): Promise<DeliverResult> => {
  const actions: string[] = []
  const { config } = ctx
  const flow = flowFor(ctx, record)
  // scope: what closes THIS task, not the whole contract. `verifyCommandFor` resolves the layer's own verify from
  // the labels frozen at dispatch, falling back to the project command when no layer claims it — so a project with
  // no layers configured sees no change, and one with them stops paying for the monorepo suite on every fix round.
  const closes = verifyCommandFor(config, record.labels ?? []).command
  if (flow.flow.name && flow.flow.source !== 'none') actions.push(`flow \`${flow.flow.name}\` (${flow.flow.source}${flow.flow.matched ? ` ${flow.flow.matched}` : ''})${flow.flow.profile?.reason ? `: ${flow.flow.profile.reason}` : ''}`)
  if (pr.isDraft) return { issue: record.issue, outcome: 'waiting', reason: 'PR is a draft', pr: pr.number, head: pr.headSha, actions }
  const protectedFiles = touchesProtectedPaths(pr.files, config.delivery.selfEditPaths)
  const approvedHere = state.humanApproval?.head === pr.headSha
  if (protectedFiles.length && approvedHere) actions.push(`protected paths approved by ${state.humanApproval?.by} for ${pr.headSha.slice(0, 12)}; reviewing and merging as usual`)
  if (protectedFiles.length && !approvedHere) {
    if (!ctx.dryRun && state.heldFor !== pr.headSha) {
      const marker = `<!-- loop:self-edit:${pr.headSha} -->`
      try { if (!(await githubCommentExists(ctx.runner, { repo: config.project.repo, number: pr.number, marker }))) await githubComment(ctx.runner, { repo: config.project.repo, number: pr.number, body: `**Loop: held for a human** — this PR touches protected paths (${protectedFiles.join(', ')}), so the loop will not review or merge it until a person approves this head: \`ak-harness loop approve ${record.issue} --head ${pr.headSha.slice(0, 12)} --by <you>\`. A new push needs a new approval.\n\n${marker}` }); actions.push('self-edit hold commented') } catch (error) { actions.push(`PR comment failed: ${message(error)}`) }
      saveState(ctx, { ...state, prNumber: pr.number, heldFor: pr.headSha })
    }
    return { issue: record.issue, outcome: 'held', reason: `touches protected paths: ${protectedFiles.join(', ')}`, pr: pr.number, head: pr.headSha, actions }
  }
  const secretShapedFiles = touchesProtectedPaths(pr.files, config.delivery.secretFilePatterns)
  if (secretShapedFiles.length) {
    if (!ctx.dryRun && state.heldFor !== pr.headSha) {
      const marker = `<!-- loop:secret-file:${pr.headSha} -->`
      try { if (!(await githubCommentExists(ctx.runner, { repo: config.project.repo, number: pr.number, marker }))) await githubComment(ctx.runner, { repo: config.project.repo, number: pr.number, body: `**Loop: held for a human** — this PR touches file(s) shaped like a secret (${secretShapedFiles.join(', ')}). The loop cannot inspect diff content, only filenames, so it will not review or merge this automatically even if the content is innocuous. Remove the file or rename it, or ask a human to review.

${marker}` }); actions.push('secret-file hold commented') } catch (error) { actions.push(`PR comment failed: ${message(error)}`) }
      saveState(ctx, { ...state, prNumber: pr.number, heldFor: pr.headSha })
    }
    return { issue: record.issue, outcome: 'held', reason: `touches secret-shaped file(s): ${secretShapedFiles.join(', ')}`, pr: pr.number, head: pr.headSha, actions }
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return fixRound(ctx, record, lease, state, pr, 'conflict', `Loop: PR #${pr.number} conflicts with ${config.project.baseBranch}. In this worktree run \`git fetch origin ${config.project.baseBranch} && git rebase origin/${config.project.baseBranch}\`, resolve conflicts keeping the contract's behaviour, re-run \`${closes}\`, then \`git push --force-with-lease\` (the only force allowed, on your own branch). Reply here when pushed.`, `conflicts with ${config.project.baseBranch}`, actions)
  // What actually examined this diff. A flow may turn any single gate off — that is the point of flows — but the
  // list being empty at merge time means nothing did, and that is where it stops being an auto-merge.
  const vouchedBy: string[] = []
  const checks = assessChecks(pr.checks, config.delivery.requiredChecks, config.delivery.ignoreChecks)
  // CI babysitting is a flow switch. With `merge.requireChecks` off, the review is the gate and a red or pending
  // check never costs a fix round — the shape a POC or an incident wants, and the reason a runner bill is optional.
  if (flow.merge.requireChecks && checks.status === 'green') vouchedBy.push('CI')
  if (!flow.merge.requireChecks && checks.status !== 'green') actions.push(`checks ${checks.status}; not gating (merge.requireChecks is off for this flow)`)
  else if (checks.status === 'red') return fixRound(ctx, record, lease, state, pr, 'ci', `Loop: CI is red on PR #${pr.number} (head ${pr.headSha.slice(0, 7)}). Failing checks: ${checks.failing.join(', ')}. Inspect them with \`gh pr checks ${pr.number} --repo ${config.project.repo}\` and \`gh run view --log-failed\`, fix the root cause (never skip or disable a check), re-run \`${closes}\`, commit and push. Reply here when pushed.`, `CI red: ${checks.failing.join(', ')}`, actions)
  else if (checks.status !== 'green') return { issue: record.issue, outcome: 'waiting', reason: checks.status === 'missing' ? `required checks not reported yet: ${checks.missingRequired.join(', ')}` : `checks pending: ${checks.pending.join(', ')}`, pr: pr.number, head: pr.headSha, actions }

  const prior = state.reviews[pr.headSha]
  // The phases of this issue, as its flow declared them. Turning the review off is a deliberate, recorded choice —
  // an incident flow that wants the fix in now. The other gates are switches too (CI via `merge.requireChecks`,
  // verify and DoD via `stages`, and `requireHumanApproval` is off by default), so this does not claim they still
  // run: what it guarantees is the floor at merge time — at least one of them examined the diff, or nothing merges.
  const reviewPhase = workerPhaseEnabled(config, flow.flow, 'review', true)
  if (!reviewPhase) actions.push('review phase off for this flow')
  let review: CodeReviewOutcome | null = null
  if (reviewPhase && (!prior || prior.status === 'incomplete')) {
    if (!ctx.reviewer) return { issue: record.issue, outcome: 'waiting', reason: 'no reviewer provider available', pr: pr.number, head: pr.headSha, actions }
    // Who reviews on this flow, before the change's own shape gets a say: a profile that pins the role narrows the
    // candidate list, and the size heuristic then chooses inside what the flow allowed.
    const roleSettings = resolveRoleSettings(config, flow.flow, 'review')
    const candidates = applyRoleSettings(ctx.reviewerCandidates, roleSettings)
    const reviewer = candidates[0] ?? ctx.reviewer
    if (roleSettings.source === 'flow' && (reviewer.provider !== ctx.reviewer.provider || reviewer.model !== ctx.reviewer.model)) actions.push(`reviewer ${reviewer.provider}/${reviewer.model} named by flow \`${flow.flow.name ?? 'default'}\``)
    // Cost lever: the model is chosen from the size and the shape of the change, not from the role alone. On a
    // fix round, that means what changed since the last reviewed head — not the whole PR's cumulative diff —
    // while criticalPaths still checks every file the PR touches (modelForChange's `allFiles`), so an earlier
    // round's critical-path change is never forgotten just because this round's diff does not repeat it.
    const lastReviewedHead = Object.entries(state.reviews).sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))[0]?.[0] ?? null
    const roundDiff = lastReviewedHead ? await githubCompare(ctx.runner, { repo: config.project.repo, base: lastReviewedHead, head: pr.headSha }).catch(() => null) : null
    const sized = config.delivery.review.smallChangeLines > 0
      ? modelForChange({ candidates, files: roundDiff?.files ?? pr.files, allFiles: pr.files, changedLines: roundDiff?.changedLines ?? pr.changedLines, smallChangeLines: config.delivery.review.smallChangeLines, criticalPaths: config.delivery.review.criticalPaths })
      : { model: reviewer, reason: '' }
    const chosen = sized.model ?? reviewer
    if (sized.reason && (chosen.provider !== reviewer.provider || chosen.model !== reviewer.model)) actions.push(`reviewer ${chosen.provider}/${chosen.model} chosen: ${sized.reason}`)
    const { settings } = providerIdentity(config, chosen.provider)
    const reviewProvider = settings.reviewProvider ?? `${chosen.provider}-cli`
    // As labels que o item carregava no despacho decidem o rigor da revisão (`reviewOverrides`). Vêm do
    // registro de despacho, não de uma leitura nova do Linear: editar um label com o item em voo não
    // pode trocar o gate pelo qual ele está sendo julgado.
    const reviewSettings = flow.review
    if (prior && prior.attempts >= 2 && prior.provider === reviewProvider && prior.model === chosen.model) {
      const known = readBlockingReviewFindings(ctx.loaded.stateDir, record.issue, pr.headSha, reviewSettings.minSeverity)
      if (known.length && !state.nudges.some((nudge) => nudge.kind === 'review' && nudge.head === pr.headSha)) return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the last review was incomplete after ${prior.attempts} attempts, but it recorded ${known.length} blocking issue(s). Address the findings below, re-run \`${closes}\`, commit and push; a complete review is still required before merge. Findings:\n${renderFindingsForWorker(known)}\nThe full review is on the PR.`, `replaying ${known.length} blocking finding(s) from incomplete review`, actions)
      return { issue: record.issue, outcome: 'held', reason: `review incomplete twice at this head; needs a human look${prior.reason ? ` (${prior.reason})` : ''}`, pr: pr.number, head: pr.headSha, actions }
    }
    // Cost lever: the cheap verifier runs before the expensive one. A build that does not compile does not
    // deserve a two-vote review, and `delivery.verify.argv` is the project's own check, not a guess.
    if (config.delivery.verify.argv.length && workerPhaseEnabled(config, flow.flow, 'verify', true) && !ctx.dryRun) {
      const verify = await ctx.runner.run(config.delivery.verify.argv, { timeoutMs: 600_000, cwd: ctx.loaded.root })
      if (verify.code !== 0) {
        actions.push(`local verify failed before review: ${(verify.stderr || verify.stdout).trim().slice(0, 200)}`)
        return fixRound(ctx, record, lease, state, pr, 'ci', `Loop: the project verification failed on PR #${pr.number} before the review was even requested: \`${config.delivery.verify.argv.join(' ')}\`. Fix it, re-run it locally, commit and push. No review is spent on a build that does not pass.`, 'local verify failed before review', actions)
      }
      actions.push('local verify passed before review')
      vouchedBy.push('the project verify')
      event(ctx, { type: 'verify.passed', issue: record.issue, pr: pr.number, head: pr.headSha })
    }
    if (prior && prior.attempts >= 2) actions.push(`retrying incomplete review with ${reviewProvider}/${chosen.model}`)
    if (ctx.dryRun) { actions.push(`would review with ${chosen.provider}/${chosen.model}`); return { issue: record.issue, outcome: 'dry-run', reason: 'review pending', pr: pr.number, head: pr.headSha, actions } }
    const beforeReview = await ctx.bus.runHook('beforeReview', { issue: record.issue, pr: pr.number, head: pr.headSha, provider: chosen.provider, model: chosen.model })
    if (beforeReview.block) return { issue: record.issue, outcome: 'waiting', reason: `review blocked by plugin: ${beforeReview.reason}`, pr: pr.number, head: pr.headSha, actions }
    const resultFile = join(ctx.loaded.stateDir, 'issues', record.issue, `review-${pr.headSha.slice(0, 12)}.json`)
    mkdirSync(dirname(resultFile), { recursive: true })
    if (reviewSettings.overriddenBy) actions.push(`review reinforced by \`${reviewSettings.overriddenBy}\`: ${reviewSettings.votes} vote(s), min severity ${reviewSettings.minSeverity}`)
    review = await runCodeReview(ctx.runner, { cli: reviewSettings.cli, repo: config.project.repo, number: pr.number, provider: reviewProvider, model: chosen.model, mode: reviewSettings.mode, ...(reviewSettings.transport ? { transport: reviewSettings.transport } : {}), profile: reviewSettings.profile, votes: reviewSettings.votes, concurrency: reviewSettings.concurrency, minSeverity: reviewSettings.minSeverity, deadlineMs: Math.min(ctx.reviewDeadlineMs, roleSettings.timeoutMs ?? ctx.reviewDeadlineMs), maxCalls: reviewSettings.maxCalls, post: reviewSettings.post, resultFile, cwd: ctx.loaded.root, env: ctx.env })
    actions.push(`review ${review.status}: ${review.summary}`)
    const attempts = (prior?.attempts ?? 0) + 1
    state = { ...state, prNumber: pr.number, reviews: { ...state.reviews, [pr.headSha]: { status: review.status, at: ctx.now().toISOString(), provider: review.provider, model: review.model, blocking: review.blocking.length, attempts, ...incompleteReason(review) } } }
    saveState(ctx, state)
    // windowed/cost visibility: agentskit-review already tracks provider calls and tokens per invocation
    // (`review.usage`); recording it here is what lets issueBudget/issueSpend see review spend at all.
    event(ctx, { type: 'pr.reviewed', issue: record.issue, pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, provider: review.provider, model: review.model, profile: reviewSettings.profile, votes: reviewSettings.votes, minSeverity: reviewSettings.minSeverity, calls: review.usage.providerCalls, inputTokens: review.usage.inputTokens, outputTokens: review.usage.outputTokens, totalTokens: review.usage.totalTokens, ...incompleteReason(review) })
    await ctx.bus.runHook('afterReview', { issue: record.issue, pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length })
    if (review.status === 'incomplete') {
      const failureKind = classifyProviderFailure(review.rawTail)
      // Cooldown keys off the internal provider id (ctx.reviewer.provider, e.g. "codex"), not the review-CLI transport id
      // (review.provider, e.g. "codex-cli") — those differ and detectProviders()/rankModels() only look up the former.
      if (!ctx.dryRun && ctx.reviewer && (failureKind === 'quota' || failureKind === 'auth')) {
        const reviewerProviderId = ctx.reviewer.provider
        const resetsAt = extractResetsAt(review.rawTail, ctx.now())
        const entry = markProviderExhausted(ctx.loaded.stateDir, reviewerProviderId, { initialMin: config.models.cooldown.initialMin, maxMin: config.models.cooldown.maxMin, reason: `${failureKind}: ${review.rawTail.split('\n').slice(-1)[0]?.slice(0, 200) ?? review.summary}`, resetsAt, now: ctx.now() })
        actions.push(`reviewer ${reviewerProviderId} marked cooling down until ${entry.until} (${failureKind})`)
        event(ctx, { type: 'provider.cooldown', provider: reviewerProviderId, kind: failureKind, until: entry.until, source: 'review' })
      }
      if (review.blocking.length) return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the review of PR #${pr.number} is incomplete, but it found ${review.blocking.length} blocking issue(s). Address the findings below, re-run \`${closes}\`, commit and push; the loop will require a complete review before merge. Findings:\n${renderFindingsForWorker(review.blocking)}\nThe full (incomplete) review is on the PR.`, `review incomplete with ${review.blocking.length} blocking finding(s)`, actions, review.blocking)
      return { issue: record.issue, outcome: 'waiting', reason: review.summary, pr: pr.number, head: pr.headSha, review, actions }
    }
    if (review.status === 'findings') return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the code review of PR #${pr.number} (head ${pr.headSha.slice(0, 7)}) found ${review.blocking.length} issue(s) at or above "${reviewSettings.minSeverity}". Address each one (or explain in the PR why it is not applicable), re-run \`${closes}\`, commit and push. Findings:\n${renderFindingsForWorker(review.blocking)}\nThe full review is on the PR. Reply here when pushed.`, `review found ${review.blocking.length} blocking finding(s)`, actions, review.blocking)
  } else if (reviewPhase && prior?.status === 'findings') return { issue: record.issue, outcome: 'waiting', reason: `review findings pending a new push (head ${pr.headSha.slice(0, 7)})`, pr: pr.number, head: pr.headSha, actions }

  // The phase artifacts are the contract between the worker and the harness: the machine advances on files it can
  // check, never on what a terminal said. A missing one comes back as a fix round **naming the file** — "which
  // file?" is the only question the worker needs answered — and an unparseable one is called out as worse than
  // absent, because it looks like evidence. `plan.md` is only asked for where a plan was approved to depart from.
  // A record with no worktree path predates the worktree or lost it: the harness cannot read anything there, and
  // blaming the worker for a file nobody can look for is how a loop invents work.
  const artifacts = record.worktreePath ? readPhaseArtifacts(record.worktreePath, config) : []
  // Same source as `tick` used when it decided whether to run the planner at all (`tick.ts:554`). Reading
  // `worker.plan.enabled` directly here meant a flow that turned the planner off still had deliver demand a
  // `plan.md` the worker was never asked to write, and send it back a fix round for the omission.
  const requiredArtifacts: readonly PhaseArtifactName[] = workerPhaseEnabled(config, flow.flow, 'planner', config.worker.plan.enabled) ? ['plan', 'verify'] : ['verify']
  const absentArtifacts = missingArtifacts(artifacts, requiredArtifacts)
  if (absentArtifacts.length) {
    const detail = absentArtifacts.map((artifact) => `\`${artifact.file}\` — ${artifact.detail}`).join('; ')
    return fixRound(ctx, record, lease, state, pr, 'review', `Loop: PR #${pr.number} cannot be checked because the phase artifact(s) the loop reads are not there: ${detail}. Write each file at the root of this worktree, commit and push. \`verify.json\` is \`{ "ranAt": "<iso>", "command": "<what you ran>", "exitCode": 0, "outcomes": [{ "id": "<outcome id>", "status": "passed", "evidence": "<the line that proves it>" }] }\`.`, `missing phase artifact(s): ${absentArtifacts.map((artifact) => artifact.file).join(', ')}`, actions)
  }

  // Both DoD lists, proven, before anything merges: the project's (`dod.items`) and the issue's (the frozen
  // contract's outcomes). The evidence goes on the PR either way, so a human reading it sees proof, not a promise.
  if (workerPhaseEnabled(config, flow.flow, 'dod', true) && (config.dod.items.length || readStoredContract(ctx.loaded.stateDir, record.issue))) {
    const stored = readStoredContract(ctx.loaded.stateDir, record.issue)
    // `verify.json` counts as evidence for an outcome the DoD file left unproven — the worker ran the check once;
    // asking it to transcribe the same result into a second file only invents a way to be inconsistent. The
    // explicit DoD proof still wins where both exist: it is the more specific statement.
    const evidence = readDodEvidence(record.worktreePath, config)
    const fromVerify = verifyProofs(readVerifyArtifact(record.worktreePath)).filter((proof) => !evidence.outcomes.some((recorded) => recorded.id === proof.id))
    const dod = assessDod({ config, contract: stored?.contract ?? null, evidence: { ...evidence, outcomes: [...evidence.outcomes, ...fromVerify] }, prFiles: pr.files })
    if (fromVerify.length) actions.push(`verify.json supplied ${fromVerify.length} outcome proof(s)`)
    if (dod.lines.length) {
      event(ctx, { type: 'dod.assessed', issue: record.issue, pr: pr.number, head: pr.headSha, complete: dod.complete, proven: dod.lines.filter((line) => line.status === 'proven').length, missing: dod.missing.length, failed: dod.failed.length })
      if (!ctx.dryRun) { try { const marker = `<!-- loop:dod:${pr.headSha}:${dod.complete ? 'complete' : `${dod.missing.length}-${dod.failed.length}`} -->`; if (!(await githubCommentExists(ctx.runner, { repo: config.project.repo, number: pr.number, marker }))) await githubComment(ctx.runner, { repo: config.project.repo, number: pr.number, body: `${renderDodMarkdown(dod)}\n\n${marker}` }) } catch (error) { actions.push(`DoD comment failed: ${message(error)}`) } }
      if (!dod.complete) {
        const why = `definition of done not proven — missing: ${dod.missing.join(', ') || 'none'}; failing: ${dod.failed.join(', ') || 'none'}`
        return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the definition of done is not proven for PR #${pr.number}. ${dod.missing.length ? `No proof recorded for: ${dod.missing.join(', ')}.` : ''} ${dod.failed.length ? `Failing: ${dod.failed.join(', ')}.` : ''} Run each item, record the result in \`${config.dod.evidenceFile}\` at the root of this worktree (\`{"project": [{"id":"…","status":"passed","evidence":"…"}], "outcomes": [...]}\`), commit and push. The loop writes the table onto the PR.`, why, actions)
      }
      actions.push(`definition of done proven (${dod.lines.length} item(s))`)
      vouchedBy.push('the definition of done')
    }
  }
  // A layer is a boundary, not a suggestion: crossing it is always reported, and held only where the project said
  // the boundary is real (`layers[].enforce`). Reporting first is what lets a team draw the line before it bites.
  const boundary = assessBoundary(config, record.labels ?? [], pr.files)
  if (boundary.detail) {
    actions.push(`layer boundary: ${boundary.detail}`)
    if (boundary.enforced) return { issue: record.issue, outcome: 'held', reason: `outside its layer boundary — ${boundary.detail}`, pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }
  }
  if (review) vouchedBy.push('the review')
  // The floor under auto-merge. Each of CI gating, the review, the project verify and the definition of done is a
  // deliberate per-flow switch — an incident flow turning the review off to get a fix in is the feature. All of
  // them off at once is not a faster flow, it is an unattended push: nothing read this diff, and no human was
  // asked to. A flow that wants exactly that says so with `merge.auto: false` and merges by hand.
  if (!vouchedBy.length) return { issue: record.issue, outcome: 'held', reason: 'nothing examined this change — CI gating, review, verify and the definition of done are all off for this flow; auto-merge needs at least one', pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }
  actions.push(`vouched for by: ${vouchedBy.join(', ')}`)
  if (!flow.merge.auto) return { issue: record.issue, outcome: 'held', reason: 'review clean; auto-merge disabled', pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }
  if (flow.merge.requireHumanApproval && pr.reviewDecision !== 'APPROVED') return { issue: record.issue, outcome: 'held', reason: `review clean and checks green, but delivery.merge.requireHumanApproval is set and no human has approved PR #${pr.number} on GitHub yet`, pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }

  const smoke = config.delivery.smoke
  if (smoke.enabled && smoke.kind === 'verify-argv') {
    if (!smoke.argv.length) return { issue: record.issue, outcome: 'held', reason: 'delivery.smoke.enabled but argv is empty', pr: pr.number, head: pr.headSha, actions }
    if (ctx.dryRun) { actions.push(`would run smoke: ${smoke.argv.join(' ')}`); return { issue: record.issue, outcome: 'dry-run', reason: 'smoke pending', pr: pr.number, head: pr.headSha, actions } }
    const smokeOutcome = await ctx.runner.run([...smoke.argv], { timeoutMs: smoke.timeoutMs, cwd: ctx.loaded.root, env: ctx.env })
    if (smokeOutcome.timedOut || smokeOutcome.code !== 0) {
      const detail = `${smokeOutcome.stderr}\n${smokeOutcome.stdout}`.trim().slice(0, 400)
      actions.push(`smoke failed: exit ${smokeOutcome.timedOut ? 'timeout' : smokeOutcome.code ?? 'null'}`)
      event(ctx, { type: 'pr.smoke-failed', issue: record.issue, pr: pr.number, head: pr.headSha, detail })
      return fixRound(ctx, record, lease, state, pr, 'ci', `Loop: optional deliver smoke failed (\`${smoke.argv.join(' ')}\`). Fix the failure, re-run \`${closes}\`, push, and the loop will retry.\n\n${detail}`, `smoke failed: ${detail.split('\n')[0] ?? 'non-zero exit'}`, actions)
    }
    actions.push('smoke passed')
  }

  if (ctx.dryRun) { actions.push('would squash-merge'); return { issue: record.issue, outcome: 'dry-run', reason: 'ready to merge', pr: pr.number, head: pr.headSha, actions } }
  const beforeMerge = await ctx.bus.runHook('beforeMerge', { issue: record.issue, pr: pr.number, head: pr.headSha })
  if (beforeMerge.block) return { issue: record.issue, outcome: 'held', reason: `merge blocked by plugin: ${beforeMerge.reason}`, pr: pr.number, head: pr.headSha, actions }
  const merged = await githubMerge(ctx.runner, { repo: config.project.repo, number: pr.number, headSha: pr.headSha, method: config.delivery.merge.method, title: `${pr.title} (#${pr.number})` })
  if (!merged.merged) { actions.push(`merge refused: ${merged.message}`); event(ctx, { type: 'pr.merge-refused', issue: record.issue, pr: pr.number, head: pr.headSha, message: merged.message }); return { issue: record.issue, outcome: 'waiting', reason: `merge refused: ${merged.message}`, pr: pr.number, head: pr.headSha, actions } }
  actions.push(`merged as ${merged.sha ?? 'unknown sha'}`)
  event(ctx, { type: 'pr.merged', issue: record.issue, pr: pr.number, head: pr.headSha, sha: merged.sha })
  await ctx.bus.runHook('afterMerge', { issue: record.issue, pr: pr.number, head: pr.headSha, sha: merged.sha })
  return complete(ctx, record, lease, state, pr, merged.sha, actions)
}

const commentOnIntakePr = async (ctx: Context, pr: PullRequestSnapshot, body: string, actions: string[]): Promise<boolean> => {
  if (ctx.dryRun) { actions.push(`would comment on PR #${pr.number}: ${body.split('\n')[0]?.slice(0, 80)}`); return true }
  try { await githubComment(ctx.runner, { repo: ctx.config.project.repo, number: pr.number, body }); actions.push('commented on PR'); return true }
  catch (error) { actions.push(`PR comment failed: ${message(error)}`); return false }
}

const removeIntakeLabel = async (ctx: Context, pr: PullRequestSnapshot, actions: string[]): Promise<void> => {
  const label = ctx.config.github.intakeLabel
  if (!label || ctx.dryRun) return
  try { await githubLabelRemove(ctx.runner, { repo: ctx.config.project.repo, number: pr.number, label }); actions.push(`label ${label} removed`) }
  catch (error) { actions.push(`label removal failed: ${message(error)}`) }
}

const finishIntake = (ctx: Context, identifier: string, pr: PullRequestSnapshot, state: DeliveryState, outcome: Exclude<DeliverOutcome, 'dry-run'>, reason: string): void => {
  if (ctx.dryRun) return
  saveState(ctx, { ...state, prNumber: pr.number, finishedAt: ctx.now().toISOString(), finalOutcome: outcome })
  event(ctx, { type: `github-intake.${outcome}`, pr: pr.number, reason })
}

/**
 * Review-only path for a PR the loop never dispatched (picked up by `github.intakeLabel`, tracked as `pr-<n>` — no
 * Linear issue, worktree or terminal exists for it). Checks/review/fix-round mirror `handlePullRequest`, but every
 * nudge lands as a PR comment (there is no worker terminal to send to) and `github.reviewOnly` means a clean review
 * always ends in `held`, never a merge — this loop only merges PRs it dispatched itself.
 */
const handleIntakePullRequest = async (ctx: Context, identifier: string, pr: PullRequestSnapshot, state: DeliveryState): Promise<DeliverResult> => {
  const actions: string[] = []
  const { config } = ctx
  if (pr.isDraft) return { issue: identifier, outcome: 'waiting', reason: 'PR is a draft', pr: pr.number, head: pr.headSha, actions }
  const secretShapedFiles = touchesProtectedPaths(pr.files, config.delivery.secretFilePatterns)
  if (secretShapedFiles.length) {
    if (state.heldFor !== pr.headSha) {
      await commentOnIntakePr(ctx, pr, `**Loop review**: this PR touches file(s) shaped like a secret (${secretShapedFiles.join(', ')}). The loop cannot inspect diff content, only filenames, so it will not review this automatically even if the content is innocuous. A human needs to look at this one.`, actions)
      saveState(ctx, { ...state, prNumber: pr.number, heldFor: pr.headSha })
    }
    return { issue: identifier, outcome: 'held', reason: `touches secret-shaped file(s): ${secretShapedFiles.join(', ')}`, pr: pr.number, head: pr.headSha, actions }
  }

  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    const kind = 'conflict'
    const already = state.nudges.some((nudge) => nudge.kind === kind && nudge.head === pr.headSha)
    if (already) return { issue: identifier, outcome: 'waiting', reason: `conflict nudge already sent for head ${pr.headSha.slice(0, 7)}; waiting for a new push`, pr: pr.number, head: pr.headSha, actions }
    await commentOnIntakePr(ctx, pr, `**Loop review**: PR #${pr.number} conflicts with \`${config.project.baseBranch}\`. Rebase and push; the loop will re-review once checks are green.`, actions)
    saveState(ctx, { ...state, prNumber: pr.number, nudges: [...state.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] })
    return { issue: identifier, outcome: ctx.dryRun ? 'dry-run' : 'fix-round', reason: `conflicts with ${config.project.baseBranch}`, pr: pr.number, head: pr.headSha, actions }
  }

  const checks = assessChecks(pr.checks, config.delivery.requiredChecks, config.delivery.ignoreChecks)
  if (checks.status === 'red') {
    const kind = 'ci'
    const already = state.nudges.some((nudge) => nudge.kind === kind && nudge.head === pr.headSha)
    if (already) return { issue: identifier, outcome: 'waiting', reason: `ci nudge already sent for head ${pr.headSha.slice(0, 7)}; waiting for a new push`, pr: pr.number, head: pr.headSha, actions }
    await commentOnIntakePr(ctx, pr, `**Loop review**: CI is red on PR #${pr.number} (failing: ${checks.failing.join(', ')}). Push a fix; the loop will re-review.`, actions)
    saveState(ctx, { ...state, prNumber: pr.number, nudges: [...state.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] })
    return { issue: identifier, outcome: ctx.dryRun ? 'dry-run' : 'fix-round', reason: `CI red: ${checks.failing.join(', ')}`, pr: pr.number, head: pr.headSha, actions }
  }
  if (checks.status !== 'green') return { issue: identifier, outcome: 'waiting', reason: checks.status === 'missing' ? `required checks not reported yet: ${checks.missingRequired.join(', ')}` : `checks pending: ${checks.pending.join(', ')}`, pr: pr.number, head: pr.headSha, actions }

  const prior = state.reviews[pr.headSha]
  if (prior?.status === 'findings') return { issue: identifier, outcome: 'waiting', reason: `review findings pending a new push (head ${pr.headSha.slice(0, 7)})`, pr: pr.number, head: pr.headSha, actions }
  if (!prior || prior.status === 'incomplete') {
    if (prior && prior.attempts >= 2) return { issue: identifier, outcome: 'held', reason: `review incomplete twice at this head; needs a human look${prior.reason ? ` (${prior.reason})` : ''}`, pr: pr.number, head: pr.headSha, actions }
    if (!ctx.reviewer) return { issue: identifier, outcome: 'waiting', reason: 'no reviewer provider available', pr: pr.number, head: pr.headSha, actions }
    if (ctx.dryRun) { actions.push(`would review with ${ctx.reviewer.provider}/${ctx.reviewer.model}`); return { issue: identifier, outcome: 'dry-run', reason: 'review pending', pr: pr.number, head: pr.headSha, actions } }
    const { settings } = providerIdentity(config, ctx.reviewer.provider)
    const beforeReview = await ctx.bus.runHook('beforeReview', { issue: identifier, pr: pr.number, head: pr.headSha, provider: ctx.reviewer.provider, model: ctx.reviewer.model, source: 'github-intake' })
    if (beforeReview.block) return { issue: identifier, outcome: 'waiting', reason: `review blocked by plugin: ${beforeReview.reason}`, pr: pr.number, head: pr.headSha, actions }
    const resultFile = join(ctx.loaded.stateDir, 'issues', identifier, `review-${pr.headSha.slice(0, 12)}.json`)
    mkdirSync(dirname(resultFile), { recursive: true })
    const review = await runCodeReview(ctx.runner, { cli: config.delivery.review.cli, repo: config.project.repo, number: pr.number, provider: settings.reviewProvider ?? `${ctx.reviewer.provider}-cli`, model: ctx.reviewer.model, mode: config.delivery.review.mode, ...(config.delivery.review.transport ? { transport: config.delivery.review.transport } : {}), profile: config.delivery.review.profile, votes: config.delivery.review.votes, concurrency: config.delivery.review.concurrency, minSeverity: config.delivery.review.minSeverity, deadlineMs: ctx.reviewDeadlineMs, maxCalls: config.delivery.review.maxCalls, post: config.delivery.review.post, resultFile, cwd: ctx.loaded.root, env: ctx.env })
    actions.push(`review ${review.status}: ${review.summary}`)
    const attempts = (prior?.attempts ?? 0) + 1
    const next: DeliveryState = { ...state, prNumber: pr.number, reviews: { ...state.reviews, [pr.headSha]: { status: review.status, at: ctx.now().toISOString(), provider: review.provider, model: review.model, blocking: review.blocking.length, attempts, ...incompleteReason(review) } } }
    saveState(ctx, next)
    event(ctx, { type: 'pr.reviewed', pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, provider: review.provider, model: review.model, profile: config.delivery.review.profile, votes: config.delivery.review.votes, minSeverity: config.delivery.review.minSeverity, source: 'github-intake', calls: review.usage.providerCalls, inputTokens: review.usage.inputTokens, outputTokens: review.usage.outputTokens, totalTokens: review.usage.totalTokens, ...incompleteReason(review) })
    await ctx.bus.runHook('afterReview', { issue: identifier, pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, source: 'github-intake' })
    if (review.status === 'incomplete') {
      const failureKind = classifyProviderFailure(review.rawTail)
      if (!ctx.dryRun && (failureKind === 'quota' || failureKind === 'auth')) {
        const reviewerProviderId = ctx.reviewer.provider
        const resetsAt = extractResetsAt(review.rawTail, ctx.now())
        const entry = markProviderExhausted(ctx.loaded.stateDir, reviewerProviderId, { initialMin: config.models.cooldown.initialMin, maxMin: config.models.cooldown.maxMin, reason: `${failureKind}: ${review.rawTail.split('\n').slice(-1)[0]?.slice(0, 200) ?? review.summary}`, resetsAt, now: ctx.now() })
        actions.push(`reviewer ${reviewerProviderId} marked cooling down until ${entry.until} (${failureKind})`)
        event(ctx, { type: 'provider.cooldown', provider: reviewerProviderId, kind: failureKind, until: entry.until, source: 'review' })
      }
      return { issue: identifier, outcome: 'waiting', reason: review.summary, pr: pr.number, head: pr.headSha, review, actions }
    }
    if (review.status === 'findings') {
      const kind = 'review'
      await commentOnIntakePr(ctx, pr, `**Loop review**: found ${review.blocking.length} issue(s) at or above "${config.delivery.review.minSeverity}" on PR #${pr.number} (head ${pr.headSha.slice(0, 7)}). Address each one (or explain why it does not apply) and push.
${renderFindingsForWorker(review.blocking)}`, actions)
      saveState(ctx, { ...next, nudges: [...next.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] })
      return { issue: identifier, outcome: ctx.dryRun ? 'dry-run' : 'fix-round', reason: `review found ${review.blocking.length} blocking finding(s)`, pr: pr.number, head: pr.headSha, review, actions }
    }
    // clean — fall through to the held-for-human ending below with `next` as the state to finish with
    state = next
  }

  // github.reviewOnly is a fixed loop guarantee (see LoopConfigSchema): a review-only intake PR is never merged
  // automatically, however clean the review — merge is always a human decision for a PR this loop did not dispatch.
  await commentOnIntakePr(ctx, pr, `**Loop review**: clean. This PR was picked up via the \`${config.github.intakeLabel}\` label; the loop reviews and comments only — merging is a human decision.`, actions)
  await removeIntakeLabel(ctx, pr, actions)
  finishIntake(ctx, identifier, pr, state, 'held', 'review clean; external PR — merge is human')
  return { issue: identifier, outcome: ctx.dryRun ? 'dry-run' : 'held', reason: 'review clean; external PR — merge is human', pr: pr.number, head: pr.headSha, actions }
}

export const precheckDeliver = (stateDir: string): { readonly work: boolean; readonly reason: string; readonly active: number } => {
  const active = listDispatched(stateDir).filter((record) => !readDeliveryState(stateDir, record.issue).finishedAt).length
  return { work: active > 0, reason: active ? `${active} dispatched issue(s) in flight` : 'nothing dispatched', active }
}

export const runDeliver = async (input: DeliverInput): Promise<DeliverReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  requireWritableTracker(config)
  const now = input.now ?? (() => new Date())
  const dryRun = input.dryRun === true
  const notes: string[] = []
  const orca = orcaOptions(config)
  const [accountList, agentHooks] = await Promise.all([orcaAccountList(input.runner, orca).catch(() => ({})), orcaAgentHooks(input.runner, orca).catch(() => ({}) as Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>>)])
  const providers = await detectProviders({ providers: providerSpecs(config), accountList, agentHooks, env: input.env, platform: input.platform, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(readCooldowns(loaded.stateDir), now()), now })
  const availableIds = providers.filter((provider) => provider.available).map((provider) => provider.id)
  const catalogExtras = async (role: 'reviewer' | 'builder') => config.models.routing.mode === 'catalog'
    ? resolveCatalogCandidates({ config, role, availableProviderIds: availableIds, runner: input.runner, stateDir: loaded.stateDir, env: input.env, now })
    : Promise.resolve([])
  const reviewerCandidates = rankModels(config, 'reviewer', providers, await catalogExtras('reviewer'))
  const reviewer = reviewerCandidates[0] ?? null
  const builderExtras = await catalogExtras('builder')
  const builder = rankModels(config, 'builder', providers, builderExtras)[0] ?? null
  let env = input.env ?? process.env
  if (!env['GITHUB_TOKEN'] && !env['GH_TOKEN']) { try { const token = await input.runner.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 }); if (token.code === 0 && token.stdout.trim()) env = { ...env, GITHUB_TOKEN: token.stdout.trim(), GH_TOKEN: token.stdout.trim() } } catch { /* review runs without a token and reports incomplete */ } }
  const reviewDeadlineMs = input.budgetMs ? Math.max(60_000, Math.min(config.delivery.review.deadlineMs, input.budgetMs - 90_000)) : config.delivery.review.deadlineMs
  if (reviewDeadlineMs < config.delivery.review.deadlineMs) notes.push(`review deadline capped to ${Math.round(reviewDeadlineMs / 1000)}s to fit the stage budget`)
  const ownsBus = !input.bus
  const bus = input.bus ?? createLoopEventBus()
  if (ownsBus && config.plugins.modules.length) {
    const { errors } = await loadLoopPlugins(loaded.root, config.plugins.modules, bus)
    for (const failure of errors) notes.push(`plugin ${failure.path} failed to load: ${failure.error}`)
  }
  // An externally-owned bus (`loop stage`) already has its own notifier attached, and its owner flushes it once
  // for the whole invocation — attaching a second one here would double-send every notification.
  const flushNotifications = ownsBus ? attachNotifier(bus, { config, runner: input.runner, env }) : async () => { /* owner flushes */ }
  const { tracker, scm } = resolveConnectors({ runner: input.runner, config, env, cwd: loaded.root, dryRun })
  const ctx: Context = { loaded, config, runner: input.runner, now, dryRun, reviewer, reviewerCandidates, builder, providers, env, tracker, scm, ...(input.assumeIdle === undefined ? {} : { assumeIdle: input.assumeIdle }), notes, reviewDeadlineMs, bus, builderExtras }
  const ledger = createDispatchLedger(loaded.stateDir)
  const leases = new Map(ledger.active().map((lease) => [lease.issue, lease]))
  const results: DeliverResult[] = []
  for (const record of listDispatched(loaded.stateDir)) {
    if (input.onlyIssue && record.issue !== input.onlyIssue) continue
    let state = readDeliveryState(loaded.stateDir, record.issue)
    // A merged issue is never in `resumableOutcomes` (blocked/stuck/abandoned/held) and can never legitimately
    // come back to life — polling GitHub for it on every future tick, forever, only grows with total historical
    // dispatch count instead of current in-flight work. Every other finished outcome still needs to be re-checked
    // (a human may push a fix, or reopen a closed PR) so this skip is deliberately narrow to `merged` alone.
    if (state.finishedAt && state.finalOutcome === 'merged') continue
    const lease = leases.get(record.issue)
    if (!state.finishedAt) {
      const ageMinutes = minutesBetween(now(), record.dispatchedAt)
      if (config.delivery.maxDispatchMinutes && ageMinutes >= config.delivery.maxDispatchMinutes) {
        results.push(await tripCircuitBreaker(ctx, record, lease, state, 'max-duration', `dispatch has been running ${Math.round(ageMinutes)} min, at or past the ${config.delivery.maxDispatchMinutes} min ceiling (delivery.maxDispatchMinutes)`))
        continue
      }
      // A ceiling reached is an escalation, never another attempt with less headroom.
      const spend = issueBudget(config, ctx.loaded.stateDir, record.issue, record.frozenPerIssueTokens)
      if (spend.exceeded) {
        results.push(await tripCircuitBreaker(ctx, record, lease, state, 'cost-guard', spend.reason ?? 'per-issue budget exhausted'))
        continue
      }
      const initialRemaining = record.initialRemainingPercent
      if (initialRemaining !== null && initialRemaining !== undefined) {
        const currentProvider = ctx.providers.find((provider) => provider.id === record.provider)
        const currentRemaining = currentProvider ? remainingUsagePercent(currentProvider.usage, config.models.routing.usageMetric) : null
        if (currentRemaining !== null) {
          const delta = initialRemaining - currentRemaining
          // windowed visibility: logged every pass regardless of the breaker below, so the trend is visible
          // before it ever trips — this is the same delta the incident that started this work never had.
          event(ctx, { type: 'provider.usage-observed', issue: record.issue, provider: record.provider, initialRemainingPercent: initialRemaining, currentRemainingPercent: currentRemaining, deltaPercent: delta })
          if (config.resilience.maxUsageDeltaPercent && delta >= config.resilience.maxUsageDeltaPercent) {
            results.push(await tripCircuitBreaker(ctx, record, lease, state, 'cost-guard', `provider ${record.provider} remaining usage dropped ${delta.toFixed(1)} points since dispatch (${initialRemaining}% → ${currentRemaining}%), at or past resilience.maxUsageDeltaPercent (${config.resilience.maxUsageDeltaPercent})`))
            continue
          }
        }
      }
    }
    try {
      let open = await githubPullRequestsForBranch(input.runner, { repo: config.project.repo, head: record.branch })
      if (!open.length) {
        // The worker may have pushed the branch Orca assigned (`<git user>/<worktree>`) rather than the recorded one.
        const candidates = (await githubOpenPullRequests(input.runner, { repo: config.project.repo, limit: 100 })).filter((item) => item.headRef === record.branch || item.headRef.endsWith(`/${record.worktree}`) || item.headRef === record.worktree)
        if (candidates.length) { open = candidates; if (!dryRun) writeJsonAtomic(dispatchRecordPath(loaded.stateDir, record.issue), { ...record, branch: candidates[0]!.headRef }); notes.push(`${record.issue}: PR found on branch ${candidates[0]!.headRef}; dispatch record updated`) }
      }
      const pr = open[0]
      if (pr) {
        const wasFinished = Boolean(state.finishedAt)
        state = await reopenFinishedIssue(ctx, record, state, pr)
        if (wasFinished && state.finishedAt) continue
        const reviewActions: string[] = []
        await syncReviewTracker(ctx, record, pr, reviewActions)
        if (reviewActions.length) notes.push(`${record.issue}: ${reviewActions.join('; ')}`)
        results.push(await handlePullRequest(ctx, record, lease, state, pr)); continue
      }
      const recordedMerge = readMergedEvent(loaded.stateDir, record.issue)
      if (recordedMerge) {
        try {
          const merged = await githubPullRequest(input.runner, { repo: config.project.repo, number: recordedMerge.pr })
          if (merged.state === 'MERGED') {
            const actions: string[] = ['reconciled merge recorded before branch deletion']
            results.push(await complete(ctx, record, lease, state, merged, recordedMerge.sha ?? null, actions))
            continue
          }
        } catch (error) { notes.push(`${record.issue}: recorded PR #${recordedMerge.pr} could not be loaded (${message(error)})`) }
      }
      const closed = await githubPullRequestsForBranch(input.runner, { repo: config.project.repo, head: record.branch, state: 'all' })
      const merged = closed.find((item) => item.state === 'MERGED')
      if (merged) { const actions: string[] = ['PR merged outside the loop']; results.push(await complete(ctx, record, lease, state, merged, null, actions, 'outside')); continue }
      const abandoned = closed.find((item) => item.state === 'CLOSED')
      if (abandoned) {
        // A closed PR is a human decision, not a technical block. Keep the issue in review and retain the
        // lease/worktree until the person chooses close or reopen; both decisions use the same cleanup gate.
        if (state.finishedAt && state.finalOutcome === 'abandoned' && state.prNumber === abandoned.number) continue
        const actions: string[] = []
        if (!dryRun) {
          saveState(ctx, { ...state, prNumber: abandoned.number, finishedAt: ctx.now().toISOString(), finalOutcome: 'abandoned' })
          event(ctx, { type: 'pr.closed', issue: record.issue, pr: abandoned.number, head: abandoned.headSha, reason: `PR #${abandoned.number} closed without merge` })
          createInboxStore(ctx.loaded.stateDir).upsert({ issue: record.issue, gate: 'delivery.pr-closed', title: 'PR fechado sem merge', message: `PR #${abandoned.number} foi fechado sem merge. Escolha fechar a issue ou reabrir para uma nova execução.`, fingerprint: `pr:${abandoned.number}:closed:${abandoned.headSha}`, actions: ['close-issue', 'reopen', 'respond'], data: { runId: record.queueRunId ?? null, pr: abandoned.number, head: abandoned.headSha } })
        }
        results.push({ issue: record.issue, outcome: dryRun ? 'dry-run' : 'abandoned', reason: `PR #${abandoned.number} closed without merge`, pr: abandoned.number, actions })
        continue
      }
      if (state.finishedAt) continue
      results.push(await handleNoPullRequest(ctx, record, lease, state))
    } catch (error) {
      const reason = message(error)
      // Common tool/API failures are retryable. Finish the local attempt so its lease and capacity slot are released;
      // the queue projection puts the issue back in Available and keeps this failed attempt in History.
      finish(ctx, record, lease, state, 'failed', reason)
      results.push({ issue: record.issue, outcome: 'failed', reason, actions: [] })
    }
  }

  // The durable queue is the UI/CLI/scheduler seam; delivery only projects its terminal decision into that store.
  if (!dryRun) {
    const queue = createIssueQueue({ stateDir: loaded.stateDir })
    const lifecycle = createLifecycleStore(loaded.stateDir)
    for (const result of results) {
      const run = queue.getLatestByIssue(result.issue)
      if (!run) continue
      const openPullRequest = result.pr !== undefined && result.outcome !== 'merged' && result.outcome !== 'abandoned'
      const stage = result.outcome === 'merged' ? 'merged' : result.outcome === 'abandoned' ? 'pr-closed' : openPullRequest ? 'pr-open' : result.outcome
      const status = openPullRequest || result.outcome === 'merged' || result.outcome === 'abandoned' ? 'completed' : result.outcome === 'failed' ? 'failed' : ['blocked', 'stuck'].includes(result.outcome) ? 'needs-input' : null
      // Once a PR was observed, this run is historical. A later delivery/API failure belongs to the issue's review
      // projection and Inbox, not to rewriting the completed execution attempt into a different terminal run.
      if (status && run.status !== status && !(run.status === 'completed' && status === 'failed')) queue.update(run.id, { status, error: status === 'completed' ? null : result.reason, projection: { stage, pullRequest: result.pr ?? run.projection.pullRequest } })
      const pullRequest: LifecyclePullRequest | null = result.pr === undefined ? null : { number: result.pr, state: result.outcome === 'merged' ? 'MERGED' : result.outcome === 'abandoned' ? 'CLOSED' : 'OPEN', ...(result.head ? { head: result.head } : {}) }
      lifecycle.upsert({ issue: result.issue, runId: run.id, runStatus: status ?? run.status, stage, deliveryOutcome: result.outcome, pullRequest, error: result.outcome === 'failed' ? result.reason : null, finalFailure: ['blocked', 'stuck'].includes(result.outcome), events: [{ type: result.outcome === 'held' ? 'worker.held' : result.outcome === 'waiting' ? 'worker.waiting' : 'worker.reviewed', reason: result.reason }], now: now() })
    }
  }

  const intakeLabel = config.github.intakeLabel
  if (intakeLabel) {
    if (!dryRun) {
      try { await discoverIntake(input.runner, { repo: config.project.repo, label: intakeLabel, stateDir: loaded.stateDir, now }) }
      catch (error) { notes.push(`github intake discovery failed: ${message(error)}`) }
    }
    for (const tracked of listIntake(loaded.stateDir)) {
      const identifier = intakeIssueId(tracked.pr)
      if (input.onlyIssue && identifier !== input.onlyIssue) continue
      const state = readDeliveryState(loaded.stateDir, identifier)
      if (state.finishedAt) continue
      try {
        const pr = await githubPullRequest(input.runner, { repo: config.project.repo, number: tracked.pr })
        if (pr.state !== 'OPEN') {
          finishIntake(ctx, identifier, pr, state, pr.state === 'MERGED' ? 'merged' : 'abandoned', `PR #${pr.number} ${pr.state.toLowerCase()} outside the loop's review`)
          results.push({ issue: identifier, outcome: dryRun ? 'dry-run' : pr.state === 'MERGED' ? 'merged' : 'abandoned', reason: `PR #${pr.number} ${pr.state.toLowerCase()} outside the loop's review`, pr: pr.number, actions: [] })
          continue
        }
        if (!pr.labels.includes(intakeLabel)) {
          finishIntake(ctx, identifier, pr, state, 'held', `${intakeLabel} label removed; loop stopped tracking PR #${pr.number}`)
          results.push({ issue: identifier, outcome: dryRun ? 'dry-run' : 'held', reason: `${intakeLabel} label removed; loop stopped tracking PR #${pr.number}`, pr: pr.number, actions: [] })
          continue
        }
        results.push(await handleIntakePullRequest(ctx, identifier, pr, state))
      } catch (error) {
        results.push({ issue: identifier, outcome: 'failed', reason: message(error), actions: [] })
      }
    }
  }

  await flushNotifications()
  return { status: results.length ? 'ok' : 'idle', generatedAt: now().toISOString(), dryRun, reviewer: reviewer ? `${reviewer.provider}/${reviewer.model}` : null, results, notes }
}
