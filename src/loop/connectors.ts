import type { CommandRunner } from '../adapters/command.js'
import {
  createLinearTrackingAdapter, fetchLinearIssue, fetchLinearQueue, linearAssigneeClear, linearAssigneeSet,
  linearAttach, linearCommentAdd, linearLabelAdd, linearLabelRemove, linearSaveIssue, linearStatusSet,
  type LinearIssueDetail, type LoopIssue,
} from '../adapters/linear-orca.js'
import {
  githubComment, githubCommentExists, githubLabelRemove, githubMerge, githubOpenPullRequests, githubPullRequest,
  githubPullRequestsForBranch, type PullRequestSnapshot,
} from '../adapters/github-cli.js'
import type { TrackingAdapter } from '../adapters/tracking.js'
import type { LoopConfig } from './config.js'

/**
 * Everything the loop needs from an issue tracker. Linear is the first implementation; Jira, GitHub Issues or
 * Notion are a new implementation of this interface and nothing else — the engine never names a vendor.
 *
 * Reads are pull-based and writes are idempotent by `dedupeKey`: a stage that reruns must not produce a second
 * comment, which is the only reason the key is part of the interface rather than an implementation detail.
 */
export interface TrackerConnector {
  readonly id: string
  /** Dispatchable issues, already filtered and ordered by the tracker. */
  queue(input: { readonly assignee: string | null }): Promise<readonly LoopIssue[]>
  issue(identifier: string): Promise<LinearIssueDetail>
  comment(input: { readonly issue: string; readonly body: string; readonly dedupeKey?: string }): Promise<void>
  addLabels(issue: string, labels: readonly string[]): Promise<void>
  removeLabels(issue: string, labels: readonly string[]): Promise<void>
  setState(input: { readonly issue: string; readonly from?: string; readonly to: string; readonly reason?: string }): Promise<void>
  /** Take the issue for this machine; `release` puts it back. Both are no-ops for a tracker without assignees. */
  claim(issue: string, assignee: string): Promise<void>
  release(issue: string): Promise<void>
  attach(input: { readonly issue: string; readonly url: string; readonly title?: string; readonly dedupeKey?: string }): Promise<void>
  createIssue(input: { readonly title: string; readonly description: string; readonly state?: string; readonly labels?: readonly string[]; readonly priority?: string; readonly dedupeKey?: string }): Promise<{ readonly identifier: string | null; readonly url: string | null }>
  /** The attested transition adapter, for the state changes that are recorded as decisions. */
  readonly transitions: TrackingAdapter
}

/** Everything the loop needs from the code host: pull requests, their checks, comments and the merge. */
export interface ScmConnector {
  readonly id: string
  pullRequest(number: number): Promise<PullRequestSnapshot>
  pullRequestsForBranch(head: string, state?: 'open' | 'merged' | 'closed' | 'all'): Promise<readonly PullRequestSnapshot[]>
  openPullRequests(input?: { readonly limit?: number; readonly label?: string }): Promise<readonly PullRequestSnapshot[]>
  comment(input: { readonly number: number; readonly body: string }): Promise<void>
  commentExists(input: { readonly number: number; readonly marker: string }): Promise<boolean>
  removeLabel(input: { readonly number: number; readonly label: string }): Promise<void>
  merge(input: { readonly number: number; readonly headSha: string; readonly method: 'squash' | 'merge' | 'rebase'; readonly title?: string }): Promise<{ readonly merged: boolean; readonly sha: string | null; readonly message: string }>
}

export interface ConnectorInput {
  readonly runner: CommandRunner
  readonly config: LoopConfig
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly dryRun?: boolean
}

const linearOptions = (config: LoopConfig) => ({ bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } })

/** Linear over Orca's CLI — the first `TrackerConnector`. */
export const createLinearTracker = (input: ConnectorInput): TrackerConnector => {
  const { runner, config } = input
  const write = linearOptions(config)
  return {
    id: 'linear',
    queue: async ({ assignee }) => fetchLinearQueue(runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: assignee ?? '', filter: config.linear, orca: { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs } }),
    issue: async (identifier) => fetchLinearIssue(runner, identifier, write),
    comment: async ({ issue, body, dedupeKey }) => { await linearCommentAdd(runner, { issue, body, ...(dedupeKey ? { dedupeKey } : {}) }, write) },
    addLabels: async (issue, labels) => { await linearLabelAdd(runner, { issue, labels }, write) },
    removeLabels: async (issue, labels) => { await linearLabelRemove(runner, { issue, labels }, write) },
    setState: async ({ issue, to }) => { await linearStatusSet(runner, { issue, to }, write) },
    claim: async (issue, assignee) => { await linearAssigneeSet(runner, { issue, assignee }, write) },
    release: async (issue) => { await linearAssigneeClear(runner, { issue }, write) },
    attach: async ({ issue, url, title, dedupeKey }) => { await linearAttach(runner, { issue, url, ...(title ? { title } : {}), ...(dedupeKey ? { dedupeKey } : {}) }, write) },
    createIssue: async ({ title, description, state, labels, priority, dedupeKey }) => linearSaveIssue(runner, {
      team: config.linear.teamKey, title, description,
      ...(state ? { state } : {}), ...(labels?.length ? { labels } : {}), ...(priority ? { priority } : {}), ...(dedupeKey ? { dedupeKey } : {}),
    }, write),
    transitions: createLinearTrackingAdapter(runner, { ...write, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) }),
  }
}

/** GitHub over `gh` — the first `ScmConnector`. */
export const createGitHubScm = (input: ConnectorInput): ScmConnector => {
  const { runner, config } = input
  const repo = config.project.repo
  const options = { ...(input.env ? { env: input.env } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) }
  return {
    id: 'github',
    pullRequest: async (number) => githubPullRequest(runner, { repo, number }, options),
    pullRequestsForBranch: async (head, state) => githubPullRequestsForBranch(runner, { repo, head, ...(state ? { state } : {}) }, options),
    openPullRequests: async (query) => githubOpenPullRequests(runner, { repo, ...(query?.limit ? { limit: query.limit } : {}), ...(query?.label ? { label: query.label } : {}) }, options),
    comment: async ({ number, body }) => { await githubComment(runner, { repo, number, body }, options) },
    commentExists: async ({ number, marker }) => githubCommentExists(runner, { repo, number, marker }, options),
    removeLabel: async ({ number, label }) => { await githubLabelRemove(runner, { repo, number, label }, options) },
    merge: async ({ number, headSha, method, title }) => githubMerge(runner, { repo, number, headSha, method, ...(title ? { title } : {}) }, options),
  }
}

/**
 * The connectors this config selects. Two implementations exist today; a third is a new factory here and a new
 * value in `connectors.*`, never a change in tick, deliver or release.
 */
export const resolveConnectors = (input: ConnectorInput): { readonly tracker: TrackerConnector; readonly scm: ScmConnector } => {
  const { tracker, scm } = input.config.connectors
  return {
    tracker: tracker === 'linear' ? createLinearTracker(input) : fail_unknown('tracker', tracker),
    scm: scm === 'github' ? createGitHubScm(input) : fail_unknown('scm', scm),
  }
}

const fail_unknown = (kind: string, id: string): never => { throw new Error(`Unknown ${kind} connector "${id}". Implement it against the ${kind === 'tracker' ? 'TrackerConnector' : 'ScmConnector'} interface and register it in resolveConnectors.`) }
