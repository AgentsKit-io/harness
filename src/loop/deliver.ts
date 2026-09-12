import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { atLeast, parseReviewResult, renderFindingsForWorker, runCodeReview, type CodeReviewOutcome } from '../adapters/code-review.js'
import { assessChecks, githubComment, githubCommentExists, githubLabelRemove, githubMerge, githubOpenPullRequests, githubPullRequest, githubPullRequestsForBranch, touchesProtectedPaths, type PullRequestSnapshot } from '../adapters/github-cli.js'
import { createLinearTrackingAdapter, linearAttach, linearCommentAdd, linearLabelAdd, linearLabelRemove } from '../adapters/linear-orca.js'
import { orcaAccountList, orcaAgentHooks, orcaTerminalList, orcaTerminalSend, orcaTerminalWait, orcaWorktreeRemove, orcaWorktreeSet } from '../adapters/orca-cli.js'
import { detectProviders, remainingUsagePercent, type ProviderAvailability } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError } from '../kernel/errors.js'
import { renderHandoffBrief } from './brief.js'
import { loadLoopConfig, providerIdentity, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { classifyProviderFailure, extractResetsAt, readStoredContract } from './contract.js'
import { activeCooldowns, markProviderExhausted, readCooldowns } from './cooldown.js'
import { providerSpecs } from './doctor.js'
import { resolveCatalogCandidates } from './model-catalog/index.js'
import { rankModels, type RankedModel } from './routing.js'
import { appendLoopEvent, briefPath, dispatchRecordPath, launchWorkerTerminal, readDispatchRecord, writeDispatchRecord, type DispatchRecordFile } from './tick.js'
import { intakeIssueId, discoverIntake, listIntake } from './github-intake.js'
import { createLoopEventBus, loadLoopPlugins, type LoopEventBus } from './event-bus.js'

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
  readonly reviews: Readonly<Record<string, { readonly status: CodeReviewOutcome['status']; readonly at: string; readonly provider: string; readonly model: string | null; readonly blocking: number; readonly attempts: number }>>
  readonly fixRounds: number
  readonly nudges: readonly { readonly kind: 'idle' | 'conflict' | 'ci' | 'review' | 'handoff'; readonly at: string; readonly head: string | null }[]
  readonly handoffs: readonly DeliveryHandoff[]
  readonly heldFor: string | null
  readonly finishedAt: string | null
  readonly finalOutcome: DeliverOutcome | null
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
}

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
const isMissingOrcaWorktree = (error: unknown): boolean => message(error).includes('selector_not_found')
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }

export const deliveryStatePath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'delivery.json')
export const readDeliveryState = (stateDir: string, identifier: string): DeliveryState => {
  const path = deliveryStatePath(stateDir, identifier)
  const empty: DeliveryState = { issue: identifier, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null }
  if (!existsSync(path)) return empty
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeliveryState>
    return { ...empty, ...parsed, handoffs: parsed.handoffs ?? [], nudges: parsed.nudges ?? [] }
  } catch { return empty }
}

const resumableOutcomes = new Set<DeliverOutcome>(['blocked', 'stuck', 'abandoned', 'held'])
const lastReviewHead = (state: DeliveryState): string | null => {
  const heads = Object.keys(state.reviews)
  return heads.at(-1) ?? state.heldFor
}

/** Every issue the loop dispatched and has not finished. */
export const listDispatched = (stateDir: string): readonly DispatchRecordFile[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readDispatchRecord(stateDir, entry.name)).filter((record): record is DispatchRecordFile => record !== null && existsSync(dispatchRecordPath(stateDir, record.issue)))
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
}

const orcaOptions = (config: LoopConfig) => ({ bin: config.orca.bin, timeoutMs: config.orca.timeoutMs })
const linearOptions = (config: LoopConfig) => ({ bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } })

const saveState = (ctx: Context, state: DeliveryState): void => { if (!ctx.dryRun) writeJson(deliveryStatePath(ctx.loaded.stateDir, state.issue), state) }
const event = (ctx: Context, payload: Record<string, unknown>): void => { if (!ctx.dryRun) appendLoopEvent(ctx.loaded.stateDir, { at: ctx.now().toISOString(), ...payload }, ctx.bus) }

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

const sendToWorker = async (ctx: Context, record: DispatchRecordFile, text: string, actions: string[]): Promise<boolean> => {
  if (!record.terminal) { actions.push('no terminal handle recorded; cannot nudge'); return false }
  if (ctx.dryRun) { actions.push(`would send to ${record.terminal}: ${text.split('\n')[0]?.slice(0, 80)}`); return true }
  const send = async (terminal: string) => orcaTerminalSend(ctx.runner, { terminal, text, enter: true, waitSubmitSeconds: 10 }, orcaOptions(ctx.config))
  let staleShell = false
  try {
    const terminal = (await orcaTerminalList(ctx.runner, { worktree: `id:${record.worktreeId}` }, orcaOptions(ctx.config))).find((item) => item.handle === record.terminal)
    // ponytail: a live Orca shell with no recorded agent command cannot make progress; reactivate it once.
    staleShell = Boolean(terminal && !terminal.command && /git:\(|➜\s|\$\s/.test(terminal.preview))
    if (staleShell) actions.push(`worker terminal ${record.terminal} is a shell, not an agent; reactivating`)
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
      brief = `Resume ${record.issue} on branch ${record.branch}. The coordinator has already frozen and validated the contract; the coordinator state directory is outside this isolated worktree, so do not block on a missing .codex/loop file. Address the review findings, run \`${ctx.config.delivery.verifyCommand}\`, commit and push, then report LOOP_WORKER_DONE ${record.issue}.${frozen}`
      actions.push(stored ? 'brief missing; generated recovery brief with inline contract' : 'brief missing; generated recovery brief')
    }
    const relaunched = await launchWorkerTerminal({ runner: ctx.runner, config: ctx.config, worktreeId: record.worktreeId, command: ctx.builder.tui, title: `loop ${record.issue}`, brief, idleTimeoutMs: 10_000 })
    if (!relaunched.accepted) { actions.push(`worker reactivation did not accept the brief in ${relaunched.terminal}`); return false }
    const updated = { ...record, terminal: relaunched.terminal }
    writeDispatchRecord(ctx.loaded.stateDir, updated)
    event(ctx, { type: 'worker.reactivated', issue: record.issue, terminal: relaunched.terminal, previousTerminal: record.terminal })
    const retry = await send(relaunched.terminal)
    actions.push(retry.accepted ? `sent to reactivated worker terminal ${relaunched.terminal}` : `reactivated terminal ${relaunched.terminal} did not accept input`)
    return retry.accepted
  } catch (error) { actions.push(`worker reactivation failed: ${message(error)}`); return false }
}

const escalateLinear = async (ctx: Context, record: DispatchRecordFile, kind: 'stuck' | 'blocked' | 'abandoned', body: string, actions: string[]): Promise<void> => {
  if (ctx.dryRun) { actions.push(`would mark ${kind} in Linear and Orca`); return }
  const linear = linearOptions(ctx.config)
  try {
    await linearCommentAdd(ctx.runner, { issue: record.issue, body: `${body}\n\n<!-- loop:${kind}:${record.leaseId} -->`, dedupeKey: `${kind}:${record.issue}:${record.leaseId}` }, linear)
    await linearLabelAdd(ctx.runner, { issue: record.issue, labels: [ctx.config.linear.blockedLabel] }, linear)
    await createLinearTrackingAdapter(ctx.runner, linear).transition({ tracker: 'linear', issue: record.issue, to: ctx.config.delivery.returnState, reason: `loop ${kind}` })
    actions.push(`Linear: comment + ${ctx.config.linear.blockedLabel} + ${ctx.config.delivery.returnState}`)
  } catch (error) { actions.push(`Linear escalation failed: ${message(error)}`) }
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
    const linear = linearOptions(ctx.config)
    try {
      await linearLabelRemove(ctx.runner, { issue: record.issue, labels: [ctx.config.linear.blockedLabel] }, linear)
      await createLinearTrackingAdapter(ctx.runner, linear).transition({ tracker: 'linear', issue: record.issue, to: ctx.config.linear.inProgressState, reason: `new PR head ${pr.headSha.slice(0, 7)}` })
    } catch (error) { ctx.notes.push(`${record.issue}: Linear reopen update failed: ${message(error)}`) }
  }
  return next
}

const finish = (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, outcome: DeliverOutcome, reason: string): void => {
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
  await escalateLinear(ctx, record, 'blocked', `**Loop: stopped (${kind})** — ${reason}. The worktree was preserved for inspection; the slot was released and the issue returned to ${ctx.config.delivery.returnState}.`, actions)
  event(ctx, { type: `${kind}.tripped`, issue: record.issue, reason })
  finish(ctx, record, lease, state, 'blocked', reason)
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'blocked', reason, actions }
}

const providerUnavailable = (ctx: Context, providerId: string): boolean => {
  const match = ctx.providers.find((provider) => provider.id === providerId)
  return !match || !match.available
}

const pickHandoffBuilder = (ctx: Context, record: DispatchRecordFile): RankedModel | null => {
  const ranked = rankModels(ctx.config, 'builder', ctx.providers)
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
  })
  if (ctx.dryRun) {
    actions.push(`would hand off ${record.provider}/${record.model} → ${next.provider}/${next.model} on ${record.branch}`)
    return { issue: record.issue, outcome: 'dry-run', reason: `handoff ready: ${reason}`, actions }
  }
  const title = `loop-handoff ${record.issue} ${next.provider}`
  const launched = await launchWorkerTerminal({
    runner: ctx.runner,
    config: ctx.config,
    worktreeId: record.worktreeId,
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
    await escalateLinear(ctx, record, 'stuck', `**Loop: worker stuck** — the worker terminal for \`${record.worktree}\` is gone and no pull request was opened. The worktree was preserved for inspection; the slot was released.`, actions)
    finish(ctx, record, lease, state, 'stuck', 'terminal gone before PR')
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'stuck', reason: 'worker terminal gone before a PR was opened', actions }
  }

  let idle = ctx.assumeIdle ?? false
  if (ctx.assumeIdle === undefined && record.terminal) {
    try { idle = (await orcaTerminalWait(ctx.runner, { terminal: record.terminal, for: 'tui-idle', timeoutMs: 1_500 }, orcaOptions(ctx.config))).satisfied } catch { idle = false }
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
    const sent = await sendToWorker(ctx, record, `Loop check-in: the terminal has been idle for ${Math.round(sinceOutput)} minutes and no pull request exists for branch ${record.branch}. Continue from \`git status\`: finish the contract outcomes, run the project verification, push, open the PR exactly as the brief describes, then print LOOP_WORKER_DONE ${record.issue}. If you are blocked, run \`orca worktree set --worktree active --comment "BLOCKED: <reason>" --json\` and stop.`, actions)
    saveState(ctx, { ...state, nudges: [...state.nudges, { kind: 'idle', at: now.toISOString(), head: null }] })
    event(ctx, { type: 'worker.nudged', issue: record.issue, kind: 'idle' })
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'nudged' : 'waiting', reason: 'idle without PR; nudged once', actions }
  }

  // After a failed nudge window: hand off only when the current provider cannot continue.
  if (canHandoff(ctx, record, state, nextBuilder)) {
    return performHandoff(ctx, record, state, nextBuilder, `idle after nudge and ${record.provider} unavailable`, actions)
  }

  await escalateLinear(ctx, record, 'stuck', `**Loop: worker stuck** — idle for ${Math.round(sinceOutput)} minutes after a check-in, no pull request on \`${record.branch}\`. Worktree \`${record.worktree}\` was preserved; the slot was released and the issue returned to ${ctx.config.delivery.returnState}.`, actions)
  finish(ctx, record, lease, state, 'stuck', 'idle after nudge without PR')
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'stuck', reason: 'idle after nudge without PR', actions }
}

const complete = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot, mergeSha: string | null, actions: string[]): Promise<DeliverResult> => {
  if (!ctx.dryRun) {
    const linear = linearOptions(ctx.config)
    try {
      await linearAttach(ctx.runner, { issue: record.issue, url: pr.url, title: `PR #${pr.number}`, dedupeKey: `attach:${record.issue}:${pr.number}` }, linear)
      await linearCommentAdd(ctx.runner, { issue: record.issue, body: `**Loop: merged** — ${pr.url}${mergeSha ? ` as \`${mergeSha.slice(0, 12)}\`` : ''} after a clean review and green checks. Worker: \`${record.provider}/${record.model}\`.\n\n<!-- loop:merged:${pr.number} -->`, dedupeKey: `merged:${record.issue}:${pr.number}` }, linear)
      await createLinearTrackingAdapter(ctx.runner, linear).transition({ tracker: 'linear', issue: record.issue, to: ctx.config.linear.doneState, reason: `PR #${pr.number} merged` })
      actions.push(`Linear: attached PR, commented, → ${ctx.config.linear.doneState}`)
    } catch (error) { actions.push(`Linear completion failed: ${message(error)}`) }
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
  await escalateLinear(ctx, record, 'blocked', `**Loop: blocked after ${state.fixRounds} fix round(s)** — ${why}. PR: ${pr.url}. The worktree and PR stay open for a human; the slot was released.`, actions)
  if (!ctx.dryRun) { try { await githubComment(ctx.runner, { repo: ctx.config.project.repo, number: pr.number, body: `**Loop: blocked** — ${why}. Fix rounds exhausted (${state.fixRounds}/${ctx.config.delivery.maxFixRounds}); a human needs to take over.\n\n<!-- loop:blocked:${pr.headSha} -->` }) } catch (error) { actions.push(`PR comment failed: ${message(error)}`) } }
  finish(ctx, record, lease, { ...state, prNumber: pr.number }, 'blocked', why)
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'blocked', reason: why, pr: pr.number, head: pr.headSha, actions }
}

const fixRound = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot, kind: 'ci' | 'review' | 'conflict', text: string, why: string, actions: string[]): Promise<DeliverResult> => {
  const already = state.nudges.some((nudge) => nudge.kind === kind && nudge.head === pr.headSha)
  if (already) return { issue: record.issue, outcome: 'waiting', reason: `${kind} nudge already sent for head ${pr.headSha.slice(0, 7)}; waiting for a new push`, pr: pr.number, head: pr.headSha, actions }
  const counts = kind !== 'conflict'
  if (counts && state.fixRounds >= ctx.config.delivery.maxFixRounds) return blockAfterRounds(ctx, record, lease, state, pr, why, actions)
  const sent = await sendToWorker(ctx, record, text, actions)
  const next: DeliveryState = { ...state, prNumber: pr.number, fixRounds: sent && counts ? state.fixRounds + 1 : state.fixRounds, nudges: sent ? [...state.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] : state.nudges }
  saveState(ctx, next)
  if (sent) event(ctx, { type: `worker.${kind}-round`, issue: record.issue, pr: pr.number, head: pr.headSha, round: next.fixRounds })
  return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'fix-round' : 'waiting', reason: why, pr: pr.number, head: pr.headSha, actions }
}

const handlePullRequest = async (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, pr: PullRequestSnapshot): Promise<DeliverResult> => {
  const actions: string[] = []
  const { config } = ctx
  if (pr.isDraft) return { issue: record.issue, outcome: 'waiting', reason: 'PR is a draft', pr: pr.number, head: pr.headSha, actions }
  const protectedFiles = touchesProtectedPaths(pr.files, config.delivery.selfEditPaths)
  if (protectedFiles.length) {
    if (!ctx.dryRun && state.heldFor !== pr.headSha) {
      const marker = `<!-- loop:self-edit:${pr.headSha} -->`
      try { if (!(await githubCommentExists(ctx.runner, { repo: config.project.repo, number: pr.number, marker }))) await githubComment(ctx.runner, { repo: config.project.repo, number: pr.number, body: `**Loop: held for a human** — this PR touches protected paths (${protectedFiles.join(', ')}), so the loop will not review or merge it automatically.\n\n${marker}` }); actions.push('self-edit hold commented') } catch (error) { actions.push(`PR comment failed: ${message(error)}`) }
      saveState(ctx, { ...state, prNumber: pr.number, heldFor: pr.headSha })
    }
    return { issue: record.issue, outcome: 'held', reason: `touches protected paths: ${protectedFiles.join(', ')}`, pr: pr.number, head: pr.headSha, actions }
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return fixRound(ctx, record, lease, state, pr, 'conflict', `Loop: PR #${pr.number} conflicts with ${config.project.baseBranch}. In this worktree run \`git fetch origin ${config.project.baseBranch} && git rebase origin/${config.project.baseBranch}\`, resolve conflicts keeping the contract's behaviour, re-run \`${config.delivery.verifyCommand}\`, then \`git push --force-with-lease\` (the only force allowed, on your own branch). Reply here when pushed.`, `conflicts with ${config.project.baseBranch}`, actions)
  const checks = assessChecks(pr.checks, config.delivery.requiredChecks, config.delivery.ignoreChecks)
  if (checks.status === 'red') return fixRound(ctx, record, lease, state, pr, 'ci', `Loop: CI is red on PR #${pr.number} (head ${pr.headSha.slice(0, 7)}). Failing checks: ${checks.failing.join(', ')}. Inspect them with \`gh pr checks ${pr.number} --repo ${config.project.repo}\` and \`gh run view --log-failed\`, fix the root cause (never skip or disable a check), re-run \`${config.delivery.verifyCommand}\`, commit and push. Reply here when pushed.`, `CI red: ${checks.failing.join(', ')}`, actions)
  if (checks.status !== 'green') return { issue: record.issue, outcome: 'waiting', reason: checks.status === 'missing' ? `required checks not reported yet: ${checks.missingRequired.join(', ')}` : `checks pending: ${checks.pending.join(', ')}`, pr: pr.number, head: pr.headSha, actions }

  const prior = state.reviews[pr.headSha]
  let review: CodeReviewOutcome | null = null
  if (!prior || prior.status === 'incomplete') {
    if (!ctx.reviewer) return { issue: record.issue, outcome: 'waiting', reason: 'no reviewer provider available', pr: pr.number, head: pr.headSha, actions }
    const { settings } = providerIdentity(config, ctx.reviewer.provider)
    const reviewProvider = settings.reviewProvider ?? `${ctx.reviewer.provider}-cli`
    if (prior && prior.attempts >= 2 && prior.provider === reviewProvider && prior.model === ctx.reviewer.model) {
      const known = readBlockingReviewFindings(ctx.loaded.stateDir, record.issue, pr.headSha, config.delivery.review.minSeverity)
      if (known.length && !state.nudges.some((nudge) => nudge.kind === 'review' && nudge.head === pr.headSha)) return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the last review was incomplete after ${prior.attempts} attempts, but it recorded ${known.length} blocking issue(s). Address the findings below, re-run \`${config.delivery.verifyCommand}\`, commit and push; a complete review is still required before merge. Findings:\n${renderFindingsForWorker(known)}\nThe full review is on the PR.`, `replaying ${known.length} blocking finding(s) from incomplete review`, actions)
      return { issue: record.issue, outcome: 'held', reason: 'review incomplete twice at this head; needs a human look', pr: pr.number, head: pr.headSha, actions }
    }
    if (prior && prior.attempts >= 2) actions.push(`retrying incomplete review with ${reviewProvider}/${ctx.reviewer.model}`)
    if (ctx.dryRun) { actions.push(`would review with ${ctx.reviewer.provider}/${ctx.reviewer.model}`); return { issue: record.issue, outcome: 'dry-run', reason: 'review pending', pr: pr.number, head: pr.headSha, actions } }
    const beforeReview = await ctx.bus.runHook('beforeReview', { issue: record.issue, pr: pr.number, head: pr.headSha, provider: ctx.reviewer.provider, model: ctx.reviewer.model })
    if (beforeReview.block) return { issue: record.issue, outcome: 'waiting', reason: `review blocked by plugin: ${beforeReview.reason}`, pr: pr.number, head: pr.headSha, actions }
    const resultFile = join(ctx.loaded.stateDir, 'issues', record.issue, `review-${pr.headSha.slice(0, 12)}.json`)
    mkdirSync(dirname(resultFile), { recursive: true })
    review = await runCodeReview(ctx.runner, { cli: config.delivery.review.cli, repo: config.project.repo, number: pr.number, provider: settings.reviewProvider ?? `${ctx.reviewer.provider}-cli`, model: ctx.reviewer.model, mode: config.delivery.review.mode, ...(config.delivery.review.transport ? { transport: config.delivery.review.transport } : {}), profile: config.delivery.review.profile, votes: config.delivery.review.votes, concurrency: config.delivery.review.concurrency, minSeverity: config.delivery.review.minSeverity, deadlineMs: ctx.reviewDeadlineMs, maxCalls: config.delivery.review.maxCalls, post: config.delivery.review.post, resultFile, cwd: ctx.loaded.root, env: ctx.env })
    actions.push(`review ${review.status}: ${review.summary}`)
    const attempts = (prior?.attempts ?? 0) + 1
    state = { ...state, prNumber: pr.number, reviews: { ...state.reviews, [pr.headSha]: { status: review.status, at: ctx.now().toISOString(), provider: review.provider, model: review.model, blocking: review.blocking.length, attempts } } }
    saveState(ctx, state)
    event(ctx, { type: 'pr.reviewed', issue: record.issue, pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, provider: review.provider, model: review.model })
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
      if (review.blocking.length) return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the review of PR #${pr.number} is incomplete, but it found ${review.blocking.length} blocking issue(s). Address the findings below, re-run \`${config.delivery.verifyCommand}\`, commit and push; the loop will require a complete review before merge. Findings:\n${renderFindingsForWorker(review.blocking)}\nThe full (incomplete) review is on the PR.`, `review incomplete with ${review.blocking.length} blocking finding(s)`, actions)
      return { issue: record.issue, outcome: 'waiting', reason: review.summary, pr: pr.number, head: pr.headSha, review, actions }
    }
    if (review.status === 'findings') return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the code review of PR #${pr.number} (head ${pr.headSha.slice(0, 7)}) found ${review.blocking.length} issue(s) at or above "${config.delivery.review.minSeverity}". Address each one (or explain in the PR why it is not applicable), re-run \`${config.delivery.verifyCommand}\`, commit and push. Findings:\n${renderFindingsForWorker(review.blocking)}\nThe full review is on the PR. Reply here when pushed.`, `review found ${review.blocking.length} blocking finding(s)`, actions)
  } else if (prior.status === 'findings') return { issue: record.issue, outcome: 'waiting', reason: `review findings pending a new push (head ${pr.headSha.slice(0, 7)})`, pr: pr.number, head: pr.headSha, actions }

  if (!config.delivery.merge.auto) return { issue: record.issue, outcome: 'held', reason: 'review clean; auto-merge disabled', pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }

  const smoke = config.delivery.smoke
  if (smoke.enabled && smoke.kind === 'verify-argv') {
    if (!smoke.argv.length) return { issue: record.issue, outcome: 'held', reason: 'delivery.smoke.enabled but argv is empty', pr: pr.number, head: pr.headSha, actions }
    if (ctx.dryRun) { actions.push(`would run smoke: ${smoke.argv.join(' ')}`); return { issue: record.issue, outcome: 'dry-run', reason: 'smoke pending', pr: pr.number, head: pr.headSha, actions } }
    const smokeOutcome = await ctx.runner.run([...smoke.argv], { timeoutMs: smoke.timeoutMs, cwd: ctx.loaded.root, env: ctx.env })
    if (smokeOutcome.timedOut || smokeOutcome.code !== 0) {
      const detail = `${smokeOutcome.stderr}\n${smokeOutcome.stdout}`.trim().slice(0, 400)
      actions.push(`smoke failed: exit ${smokeOutcome.timedOut ? 'timeout' : smokeOutcome.code ?? 'null'}`)
      event(ctx, { type: 'pr.smoke-failed', issue: record.issue, pr: pr.number, head: pr.headSha, detail })
      return fixRound(ctx, record, lease, state, pr, 'ci', `Loop: optional deliver smoke failed (\`${smoke.argv.join(' ')}\`). Fix the failure, re-run \`${config.delivery.verifyCommand}\`, push, and the loop will retry.\n\n${detail}`, `smoke failed: ${detail.split('\n')[0] ?? 'non-zero exit'}`, actions)
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

const finishIntake = (ctx: Context, identifier: string, pr: PullRequestSnapshot, state: DeliveryState, outcome: DeliverOutcome, reason: string): void => {
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
    if (prior && prior.attempts >= 2) return { issue: identifier, outcome: 'held', reason: 'review incomplete twice at this head; needs a human look', pr: pr.number, head: pr.headSha, actions }
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
    const next: DeliveryState = { ...state, prNumber: pr.number, reviews: { ...state.reviews, [pr.headSha]: { status: review.status, at: ctx.now().toISOString(), provider: review.provider, model: review.model, blocking: review.blocking.length, attempts } } }
    saveState(ctx, next)
    event(ctx, { type: 'pr.reviewed', pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, provider: review.provider, model: review.model, source: 'github-intake' })
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
  const reviewer = rankModels(config, 'reviewer', providers, await catalogExtras('reviewer'))[0] ?? null
  const builder = rankModels(config, 'builder', providers, await catalogExtras('builder'))[0] ?? null
  let env = input.env ?? process.env
  if (!env['GITHUB_TOKEN'] && !env['GH_TOKEN']) { try { const token = await input.runner.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 }); if (token.code === 0 && token.stdout.trim()) env = { ...env, GITHUB_TOKEN: token.stdout.trim(), GH_TOKEN: token.stdout.trim() } } catch { /* review runs without a token and reports incomplete */ } }
  const reviewDeadlineMs = input.budgetMs ? Math.max(60_000, Math.min(config.delivery.review.deadlineMs, input.budgetMs - 90_000)) : config.delivery.review.deadlineMs
  if (reviewDeadlineMs < config.delivery.review.deadlineMs) notes.push(`review deadline capped to ${Math.round(reviewDeadlineMs / 1000)}s to fit the stage budget`)
  const bus = createLoopEventBus()
  if (config.plugins.modules.length) {
    const { errors } = await loadLoopPlugins(loaded.root, config.plugins.modules, bus)
    for (const failure of errors) notes.push(`plugin ${failure.path} failed to load: ${failure.error}`)
  }
  const ctx: Context = { loaded, config, runner: input.runner, now, dryRun, reviewer, builder, providers, env, ...(input.assumeIdle === undefined ? {} : { assumeIdle: input.assumeIdle }), notes, reviewDeadlineMs, bus }
  const ledger = createDispatchLedger(loaded.stateDir)
  const leases = new Map(ledger.active().map((lease) => [lease.issue, lease]))
  const results: DeliverResult[] = []
  for (const record of listDispatched(loaded.stateDir)) {
    if (input.onlyIssue && record.issue !== input.onlyIssue) continue
    let state = readDeliveryState(loaded.stateDir, record.issue)
    const lease = leases.get(record.issue)
    if (!state.finishedAt) {
      const ageMinutes = minutesBetween(now(), record.dispatchedAt)
      if (config.delivery.maxDispatchMinutes && ageMinutes >= config.delivery.maxDispatchMinutes) {
        results.push(await tripCircuitBreaker(ctx, record, lease, state, 'max-duration', `dispatch has been running ${Math.round(ageMinutes)} min, at or past the ${config.delivery.maxDispatchMinutes} min ceiling (delivery.maxDispatchMinutes)`))
        continue
      }
      const initialRemaining = record.initialRemainingPercent
      if (config.resilience.maxUsageDeltaPercent && initialRemaining !== null && initialRemaining !== undefined) {
        const currentProvider = ctx.providers.find((provider) => provider.id === record.provider)
        const currentRemaining = currentProvider ? remainingUsagePercent(currentProvider.usage, config.models.routing.usageMetric) : null
        if (currentRemaining !== null) {
          const delta = initialRemaining - currentRemaining
          if (delta >= config.resilience.maxUsageDeltaPercent) {
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
        if (candidates.length) { open = candidates; if (!dryRun) writeJson(dispatchRecordPath(loaded.stateDir, record.issue), { ...record, branch: candidates[0]!.headRef }); notes.push(`${record.issue}: PR found on branch ${candidates[0]!.headRef}; dispatch record updated`) }
      }
      const pr = open[0]
      if (pr) {
        const wasFinished = Boolean(state.finishedAt)
        state = await reopenFinishedIssue(ctx, record, state, pr)
        if (wasFinished && state.finishedAt) continue
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
      if (merged) { const actions: string[] = ['PR merged outside the loop']; results.push(await complete(ctx, record, lease, state, merged, null, actions)); continue }
      const abandoned = closed.find((item) => item.state === 'CLOSED')
      if (abandoned) {
        const actions: string[] = []
        await escalateLinear(ctx, record, 'abandoned', `**Loop: PR closed without merge** — ${abandoned.url}. The issue returned to ${config.delivery.returnState}; the worktree was preserved.`, actions)
        finish(ctx, record, lease, { ...state, prNumber: abandoned.number }, 'abandoned', `PR #${abandoned.number} closed`)
        results.push({ issue: record.issue, outcome: dryRun ? 'dry-run' : 'abandoned', reason: `PR #${abandoned.number} closed without merge`, pr: abandoned.number, actions })
        continue
      }
      if (state.finishedAt) continue
      results.push(await handleNoPullRequest(ctx, record, lease, state))
    } catch (error) {
      results.push({ issue: record.issue, outcome: 'failed', reason: message(error), actions: [] })
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

  return { status: results.length ? 'ok' : 'idle', generatedAt: now().toISOString(), dryRun, reviewer: reviewer ? `${reviewer.provider}/${reviewer.model}` : null, results, notes }
}
