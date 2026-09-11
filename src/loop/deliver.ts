import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { renderFindingsForWorker, runCodeReview, type CodeReviewOutcome } from '../adapters/code-review.js'
import { assessChecks, githubComment, githubCommentExists, githubMerge, githubOpenPullRequests, githubPullRequestsForBranch, touchesProtectedPaths, type PullRequestSnapshot } from '../adapters/github-cli.js'
import { createLinearTrackingAdapter, linearAttach, linearCommentAdd, linearLabelAdd } from '../adapters/linear-orca.js'
import { orcaAccountList, orcaAgentHooks, orcaTerminalList, orcaTerminalSend, orcaTerminalWait, orcaWorktreeRemove, orcaWorktreeSet } from '../adapters/orca-cli.js'
import { detectProviders } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError } from '../kernel/errors.js'
import { loadLoopConfig, providerIdentity, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { providerSpecs } from './doctor.js'
import { rankModels, type RankedModel } from './routing.js'
import { appendLoopEvent, dispatchRecordPath, readDispatchRecord, type DispatchRecordFile } from './tick.js'

export type DeliverOutcome = 'waiting' | 'reviewed' | 'fix-round' | 'nudged' | 'merged' | 'held' | 'blocked' | 'stuck' | 'abandoned' | 'failed' | 'dry-run'

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

export interface DeliveryState {
  readonly issue: string
  readonly prNumber: number | null
  readonly reviews: Readonly<Record<string, { readonly status: CodeReviewOutcome['status']; readonly at: string; readonly provider: string; readonly model: string | null; readonly blocking: number; readonly attempts: number }>>
  readonly fixRounds: number
  readonly nudges: readonly { readonly kind: 'idle' | 'conflict' | 'ci' | 'review'; readonly at: string; readonly head: string | null }[]
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
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }

export const deliveryStatePath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'delivery.json')
export const readDeliveryState = (stateDir: string, identifier: string): DeliveryState => {
  const path = deliveryStatePath(stateDir, identifier)
  const empty: DeliveryState = { issue: identifier, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], heldFor: null, finishedAt: null, finalOutcome: null }
  if (!existsSync(path)) return empty
  try { return { ...empty, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<DeliveryState>) } } catch { return empty }
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
  readonly env: NodeJS.ProcessEnv
  readonly assumeIdle?: boolean
  readonly notes: string[]
  readonly reviewDeadlineMs: number
}

const orcaOptions = (config: LoopConfig) => ({ bin: config.orca.bin, timeoutMs: config.orca.timeoutMs })
const linearOptions = (config: LoopConfig) => ({ bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } })

const saveState = (ctx: Context, state: DeliveryState): void => { if (!ctx.dryRun) writeJson(deliveryStatePath(ctx.loaded.stateDir, state.issue), state) }
const event = (ctx: Context, payload: Record<string, unknown>): void => { if (!ctx.dryRun) appendLoopEvent(ctx.loaded.stateDir, { at: ctx.now().toISOString(), ...payload }) }

const sendToWorker = async (ctx: Context, record: DispatchRecordFile, text: string, actions: string[]): Promise<boolean> => {
  if (!record.terminal) { actions.push('no terminal handle recorded; cannot nudge'); return false }
  if (ctx.dryRun) { actions.push(`would send to ${record.terminal}: ${text.split('\n')[0]?.slice(0, 80)}`); return true }
  try {
    const receipt = await orcaTerminalSend(ctx.runner, { terminal: record.terminal, text, enter: true, waitSubmitSeconds: 10 }, orcaOptions(ctx.config))
    actions.push(receipt.accepted ? `sent to worker terminal ${record.terminal}` : `terminal ${record.terminal} did not accept input`)
    return receipt.accepted
  } catch (error) { actions.push(`terminal send failed: ${message(error)}`); return false }
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

const finish = (ctx: Context, record: DispatchRecordFile, lease: DispatchLease | undefined, state: DeliveryState, outcome: DeliverOutcome, reason: string): void => {
  if (ctx.dryRun) return
  if (lease) { try { createDispatchLedger(ctx.loaded.stateDir).release(lease, `${outcome}: ${reason}`) } catch (error) { ctx.notes.push(`lease release for ${record.issue} failed: ${message(error)}`) } }
  saveState(ctx, { ...state, finishedAt: ctx.now().toISOString(), finalOutcome: outcome })
  event(ctx, { type: `worker.${outcome}`, issue: record.issue, reason, worktreeId: record.worktreeId })
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
  if (!terminalAlive) {
    if (sinceDispatch < 5) return { issue: record.issue, outcome: 'waiting', reason: 'worker terminal not visible yet', actions }
    await escalateLinear(ctx, record, 'stuck', `**Loop: worker stuck** — the worker terminal for \`${record.worktree}\` is gone and no pull request was opened. The worktree was preserved for inspection; the slot was released.`, actions)
    finish(ctx, record, lease, state, 'stuck', 'terminal gone before PR')
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : 'stuck', reason: 'worker terminal gone before a PR was opened', actions }
  }
  let idle = ctx.assumeIdle ?? false
  if (ctx.assumeIdle === undefined && record.terminal) { try { idle = (await orcaTerminalWait(ctx.runner, { terminal: record.terminal, for: 'tui-idle', timeoutMs: 1_500 }, orcaOptions(ctx.config))).satisfied } catch { idle = false } }
  if (!idle || sinceOutput < idleTimeout) return { issue: record.issue, outcome: 'waiting', reason: idle ? `worker idle for ${Math.round(sinceOutput)} min (< ${idleTimeout})` : 'worker active', actions }
  const idleNudges = state.nudges.filter((nudge) => nudge.kind === 'idle')
  const lastNudge = idleNudges.at(-1)
  if (!lastNudge || minutesBetween(now, lastNudge.at) < idleTimeout) {
    if (lastNudge) return { issue: record.issue, outcome: 'waiting', reason: 'nudged recently; waiting for the worker to open the PR', actions }
    const sent = await sendToWorker(ctx, record, `Loop check-in: the terminal has been idle for ${Math.round(sinceOutput)} minutes and no pull request exists for branch ${record.branch}. Continue from \`git status\`: finish the contract outcomes, run the project verification, push, open the PR exactly as the brief describes, then print LOOP_WORKER_DONE ${record.issue}. If you are blocked, run \`orca worktree set --worktree active --comment "BLOCKED: <reason>" --json\` and stop.`, actions)
    saveState(ctx, { ...state, nudges: [...state.nudges, { kind: 'idle', at: now.toISOString(), head: null }] })
    event(ctx, { type: 'worker.nudged', issue: record.issue, kind: 'idle' })
    return { issue: record.issue, outcome: ctx.dryRun ? 'dry-run' : sent ? 'nudged' : 'waiting', reason: 'idle without PR; nudged once', actions }
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
    try { await orcaWorktreeSet(ctx.runner, { worktree: `id:${record.worktreeId}`, comment: `LOOP MERGED: PR #${pr.number}` }, orcaOptions(ctx.config)) } catch (error) { actions.push(`Orca comment failed: ${message(error)}`) }
    if (ctx.config.delivery.cleanupWorktree) { try { await orcaWorktreeRemove(ctx.runner, { worktree: `id:${record.worktreeId}`, force: true }, orcaOptions(ctx.config)); actions.push('worktree removed') } catch (error) { actions.push(`worktree removal failed (kept): ${message(error)}`) } }
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
  const next: DeliveryState = { ...state, prNumber: pr.number, fixRounds: counts ? state.fixRounds + 1 : state.fixRounds, nudges: [...state.nudges, { kind, at: ctx.now().toISOString(), head: pr.headSha }] }
  saveState(ctx, next)
  event(ctx, { type: `worker.${kind}-round`, issue: record.issue, pr: pr.number, head: pr.headSha, round: next.fixRounds })
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
    if (prior && prior.attempts >= 2) return { issue: record.issue, outcome: 'held', reason: 'review incomplete twice at this head; needs a human look', pr: pr.number, head: pr.headSha, actions }
    if (!ctx.reviewer) return { issue: record.issue, outcome: 'waiting', reason: 'no reviewer provider available', pr: pr.number, head: pr.headSha, actions }
    if (ctx.dryRun) { actions.push(`would review with ${ctx.reviewer.provider}/${ctx.reviewer.model}`); return { issue: record.issue, outcome: 'dry-run', reason: 'review pending', pr: pr.number, head: pr.headSha, actions } }
    const { settings } = providerIdentity(config, ctx.reviewer.provider)
    const resultFile = join(ctx.loaded.stateDir, 'issues', record.issue, `review-${pr.headSha.slice(0, 12)}.json`)
    mkdirSync(dirname(resultFile), { recursive: true })
    review = await runCodeReview(ctx.runner, { cli: config.delivery.review.cli, repo: config.project.repo, number: pr.number, provider: settings.reviewProvider ?? `${ctx.reviewer.provider}-cli`, model: ctx.reviewer.model, mode: config.delivery.review.mode, profile: config.delivery.review.profile, votes: config.delivery.review.votes, concurrency: config.delivery.review.concurrency, minSeverity: config.delivery.review.minSeverity, deadlineMs: ctx.reviewDeadlineMs, maxCalls: config.delivery.review.maxCalls, post: config.delivery.review.post, resultFile, cwd: ctx.loaded.root, env: ctx.env })
    actions.push(`review ${review.status}: ${review.summary}`)
    const attempts = (prior?.attempts ?? 0) + 1
    state = { ...state, prNumber: pr.number, reviews: { ...state.reviews, [pr.headSha]: { status: review.status, at: ctx.now().toISOString(), provider: review.provider, model: review.model, blocking: review.blocking.length, attempts } } }
    saveState(ctx, state)
    event(ctx, { type: 'pr.reviewed', issue: record.issue, pr: pr.number, head: pr.headSha, status: review.status, blocking: review.blocking.length, provider: review.provider, model: review.model })
    if (review.status === 'incomplete') return { issue: record.issue, outcome: 'waiting', reason: review.summary, pr: pr.number, head: pr.headSha, review, actions }
    if (review.status === 'findings') return fixRound(ctx, record, lease, state, pr, 'review', `Loop: the code review of PR #${pr.number} (head ${pr.headSha.slice(0, 7)}) found ${review.blocking.length} issue(s) at or above "${config.delivery.review.minSeverity}". Address each one (or explain in the PR why it is not applicable), re-run \`${config.delivery.verifyCommand}\`, commit and push. Findings:\n${renderFindingsForWorker(review.blocking)}\nThe full review is on the PR. Reply here when pushed.`, `review found ${review.blocking.length} blocking finding(s)`, actions)
  } else if (prior.status === 'findings') return { issue: record.issue, outcome: 'waiting', reason: `review findings pending a new push (head ${pr.headSha.slice(0, 7)})`, pr: pr.number, head: pr.headSha, actions }

  if (!config.delivery.merge.auto) return { issue: record.issue, outcome: 'held', reason: 'review clean; auto-merge disabled', pr: pr.number, head: pr.headSha, ...(review ? { review } : {}), actions }
  if (ctx.dryRun) { actions.push('would squash-merge'); return { issue: record.issue, outcome: 'dry-run', reason: 'ready to merge', pr: pr.number, head: pr.headSha, actions } }
  const merged = await githubMerge(ctx.runner, { repo: config.project.repo, number: pr.number, headSha: pr.headSha, method: config.delivery.merge.method, title: `${pr.title} (#${pr.number})` })
  if (!merged.merged) { actions.push(`merge refused: ${merged.message}`); event(ctx, { type: 'pr.merge-refused', issue: record.issue, pr: pr.number, head: pr.headSha, message: merged.message }); return { issue: record.issue, outcome: 'waiting', reason: `merge refused: ${merged.message}`, pr: pr.number, head: pr.headSha, actions } }
  actions.push(`merged as ${merged.sha ?? 'unknown sha'}`)
  event(ctx, { type: 'pr.merged', issue: record.issue, pr: pr.number, head: pr.headSha, sha: merged.sha })
  return complete(ctx, record, lease, state, pr, merged.sha, actions)
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
  const reviewer = rankModels(config, 'reviewer', providers)[0] ?? null
  let env = input.env ?? process.env
  if (!env['GITHUB_TOKEN'] && !env['GH_TOKEN']) { try { const token = await input.runner.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 }); if (token.code === 0 && token.stdout.trim()) env = { ...env, GITHUB_TOKEN: token.stdout.trim(), GH_TOKEN: token.stdout.trim() } } catch { /* review runs without a token and reports incomplete */ } }
  const reviewDeadlineMs = input.budgetMs ? Math.max(60_000, Math.min(config.delivery.review.deadlineMs, input.budgetMs - 90_000)) : config.delivery.review.deadlineMs
  if (reviewDeadlineMs < config.delivery.review.deadlineMs) notes.push(`review deadline capped to ${Math.round(reviewDeadlineMs / 1000)}s to fit the stage budget`)
  const ctx: Context = { loaded, config, runner: input.runner, now, dryRun, reviewer, env, ...(input.assumeIdle === undefined ? {} : { assumeIdle: input.assumeIdle }), notes, reviewDeadlineMs }
  const ledger = createDispatchLedger(loaded.stateDir)
  const leases = new Map(ledger.active().map((lease) => [lease.issue, lease]))
  const results: DeliverResult[] = []
  for (const record of listDispatched(loaded.stateDir)) {
    if (input.onlyIssue && record.issue !== input.onlyIssue) continue
    const state = readDeliveryState(loaded.stateDir, record.issue)
    if (state.finishedAt) continue
    const lease = leases.get(record.issue)
    try {
      let open = await githubPullRequestsForBranch(input.runner, { repo: config.project.repo, head: record.branch })
      if (!open.length) {
        // The worker may have pushed the branch Orca assigned (`<git user>/<worktree>`) rather than the recorded one.
        const candidates = (await githubOpenPullRequests(input.runner, { repo: config.project.repo, limit: 100 })).filter((item) => item.headRef === record.branch || item.headRef.endsWith(`/${record.worktree}`) || item.headRef === record.worktree)
        if (candidates.length) { open = candidates; if (!dryRun) writeJson(dispatchRecordPath(loaded.stateDir, record.issue), { ...record, branch: candidates[0]!.headRef }); notes.push(`${record.issue}: PR found on branch ${candidates[0]!.headRef}; dispatch record updated`) }
      }
      const pr = open[0]
      if (pr) { results.push(await handlePullRequest(ctx, record, lease, state, pr)); continue }
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
      results.push(await handleNoPullRequest(ctx, record, lease, state))
    } catch (error) {
      results.push({ issue: record.issue, outcome: 'failed', reason: message(error), actions: [] })
    }
  }
  return { status: results.length ? 'ok' : 'idle', generatedAt: now().toISOString(), dryRun, reviewer: reviewer ? `${reviewer.provider}/${reviewer.model}` : null, results, notes }
}
