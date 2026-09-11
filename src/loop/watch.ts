import type { CommandRunner } from '../adapters/command.js'
import { githubPullRequest, githubPullRequestsForBranch, type PullRequestSnapshot } from '../adapters/github-cli.js'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { listDispatched, readDeliveryState, type DeliveryState, type DeliverOutcome } from './deliver.js'
import { readDispatchRecord, type DispatchRecordFile } from './tick.js'

export type WatchEventKind = 'DONE' | 'FAILED' | 'ACTION_REQUIRED' | 'PROGRESS'

export interface WatchEvent {
  readonly kind: WatchEventKind
  readonly issue: string
  readonly message: string
  readonly phase: string
  readonly pr: number | null
  readonly finalOutcome: DeliverOutcome | null
  readonly at: string
}

export interface WatchTargetSnapshot {
  readonly issue: string
  readonly phase: string
  readonly signature: string
  readonly delivery: DeliveryState
  readonly dispatch: DispatchRecordFile | null
  readonly pr: PullRequestSnapshot | null
}

export interface WatchInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner?: CommandRunner
  readonly issue?: string
  readonly intervalMs?: number
  readonly once?: boolean
  readonly timeoutMs?: number
  readonly livePr?: boolean
  readonly now?: () => Date
  readonly sleep?: (ms: number) => Promise<void>
  readonly onEvent?: (event: WatchEvent) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const latestReview = (state: DeliveryState): { readonly status: string; readonly attempts: number } | null => {
  const entries = Object.values(state.reviews)
  if (entries.length === 0) return null
  const latest = entries.reduce((best, item) => (item.at > best.at ? item : best))
  return { status: latest.status, attempts: latest.attempts }
}

export const classifyWatchPhase = (delivery: DeliveryState, pr: PullRequestSnapshot | null): string => {
  if (delivery.finalOutcome === 'merged' || pr?.state === 'MERGED') return 'merged'
  if (delivery.finalOutcome === 'failed' || delivery.finalOutcome === 'stuck' || delivery.finalOutcome === 'abandoned') return delivery.finalOutcome
  if (pr?.state === 'CLOSED') return 'closed'
  if (delivery.heldFor) return 'held'
  const review = latestReview(delivery)
  if (review?.status === 'incomplete' && review.attempts >= 2) return 'held-incomplete-review'
  if (review?.status === 'incomplete') return 'review-incomplete'
  if (review?.status === 'findings') return 'fix-round'
  if (review?.status === 'clean') return 'ready-to-merge'
  if (delivery.prNumber || pr) return 'awaiting-review'
  return 'waiting-for-pr'
}

export const classifyWatchEvent = (phase: string, delivery: DeliveryState, pr: PullRequestSnapshot | null, at: string, issue: string): WatchEvent => {
  const prNumber = delivery.prNumber ?? pr?.number ?? null
  if (phase === 'merged') return { kind: 'DONE', issue, message: `PR #${prNumber ?? '?'} merged`, phase, pr: prNumber, finalOutcome: 'merged', at }
  if (phase === 'closed') return { kind: 'FAILED', issue, message: `PR #${prNumber ?? '?'} closed without merge`, phase, pr: prNumber, finalOutcome: delivery.finalOutcome, at }
  if (phase === 'failed' || phase === 'stuck' || phase === 'abandoned') {
    return { kind: 'FAILED', issue, message: `Delivery finished as ${phase}`, phase, pr: prNumber, finalOutcome: delivery.finalOutcome, at }
  }
  if (phase === 'held' || phase === 'held-incomplete-review') {
    return { kind: 'ACTION_REQUIRED', issue, message: phase === 'held' ? `Held for a human${delivery.heldFor ? ` at ${delivery.heldFor.slice(0, 7)}` : ''}` : 'Review incomplete twice; needs a human look', phase, pr: prNumber, finalOutcome: delivery.finalOutcome, at }
  }
  if (phase === 'fix-round') return { kind: 'ACTION_REQUIRED', issue, message: `Review findings pending a fix round (${delivery.fixRounds})`, phase, pr: prNumber, finalOutcome: null, at }
  return { kind: 'PROGRESS', issue, message: `Phase ${phase}${prNumber ? ` · PR #${prNumber}` : ''}`, phase, pr: prNumber, finalOutcome: null, at }
}

const signatureOf = (delivery: DeliveryState, phase: string, pr: PullRequestSnapshot | null): string => {
  const review = latestReview(delivery)
  return [
    phase,
    delivery.finalOutcome,
    delivery.finishedAt,
    delivery.heldFor,
    delivery.prNumber,
    review?.status,
    review?.attempts,
    pr?.state,
    pr?.headSha,
    pr?.mergeable,
  ].map(String).join('|')
}

export const snapshotWatchTargets = async (input: {
  readonly loaded: LoadedLoopConfig
  readonly runner?: CommandRunner
  readonly issue?: string
  readonly livePr?: boolean
  readonly now?: () => Date
}): Promise<readonly WatchTargetSnapshot[]> => {
  const stateDir = input.loaded.stateDir
  const repo = input.loaded.config.project.repo
  const dispatched = listDispatched(stateDir)
  const ids = input.issue ? [input.issue] : dispatched.map((item) => item.issue)
  const out: WatchTargetSnapshot[] = []
  for (const issue of ids) {
    const dispatch = readDispatchRecord(stateDir, issue)
    const delivery = readDeliveryState(stateDir, issue)
    if (!dispatch && !delivery.prNumber && !delivery.finalOutcome) continue
    let pr: PullRequestSnapshot | null = null
    if (input.livePr && input.runner) {
      try {
        if (delivery.prNumber) pr = await githubPullRequest(input.runner, { repo, number: delivery.prNumber })
        else if (dispatch?.branch) pr = (await githubPullRequestsForBranch(input.runner, { repo, head: dispatch.branch }))[0] ?? null
      } catch {
        pr = null
      }
    }
    const phase = classifyWatchPhase(delivery, pr)
    out.push({ issue, phase, signature: signatureOf(delivery, phase, pr), delivery, dispatch, pr })
  }
  return out
}

export interface WatchReport {
  readonly status: 'done' | 'failed' | 'waiting' | 'action-required'
  readonly generatedAt: string
  readonly events: readonly WatchEvent[]
  readonly targets: readonly WatchTargetSnapshot[]
}

/** Poll delivery state (and optionally live PRs). Emits DONE / FAILED / ACTION_REQUIRED / PROGRESS. Read-only. */
export const watchDeliveries = async (input: WatchInput): Promise<WatchReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath ?? 'loop.config.yaml')
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const intervalMs = input.intervalMs ?? 30_000
  const started = now().getTime()
  const prev = new Map<string, string>()
  const events: WatchEvent[] = []
  let targets: readonly WatchTargetSnapshot[] = []

  const tick = async (): Promise<'continue' | 'done' | 'failed' | 'action-required'> => {
    targets = await snapshotWatchTargets({ loaded, runner: input.runner, issue: input.issue, livePr: input.livePr ?? Boolean(input.runner), now })
    const at = now().toISOString()
    let anyAction = false
    let anyFailed = false
    let allTerminal = targets.length > 0
    for (const target of targets) {
      const event = classifyWatchEvent(target.phase, target.delivery, target.pr, at, target.issue)
      const previous = prev.get(target.issue)
      const changed = previous !== target.signature
      if (changed) {
        prev.set(target.issue, target.signature)
        if (previous !== undefined || event.kind !== 'PROGRESS') {
          events.push(event)
          input.onEvent?.(event)
        }
      }
      if (event.kind === 'ACTION_REQUIRED') anyAction = true
      if (event.kind === 'FAILED') anyFailed = true
      if (event.kind !== 'DONE' && event.kind !== 'FAILED') allTerminal = false
    }
    if (targets.length === 0) return 'done'
    if (allTerminal) return anyFailed ? 'failed' : 'done'
    if (anyFailed) return 'failed'
    if (anyAction) return 'action-required'
    return 'continue'
  }

  if (input.once) {
    const status = await tick()
    return { status: status === 'continue' ? 'waiting' : status, generatedAt: now().toISOString(), events, targets }
  }

  for (;;) {
    const status = await tick()
    if (status === 'done' || status === 'failed') {
      return { status, generatedAt: now().toISOString(), events, targets }
    }
    if (input.timeoutMs && input.timeoutMs > 0 && now().getTime() - started >= input.timeoutMs) {
      return { status: status === 'action-required' ? 'action-required' : 'waiting', generatedAt: now().toISOString(), events, targets }
    }
    await sleep(intervalMs)
  }
}

export const formatWatchEvent = (event: WatchEvent): string => `${event.kind}: ${event.issue} · ${event.message}`
