import type { CommandRunner } from '../adapters/command.js'
import {
  createLinearTrackingAdapter, fetchLinearIssue, fetchLinearQueue, linearAssigneeClear, linearAssigneeSet,
  linearAttach, linearCommentAdd, linearLabelAdd, linearLabelRemove, linearSaveIssue, linearStatusSet,
  type LinearIssueDetail,
} from '../adapters/linear-orca.js'
import {
  githubComment, githubCommentExists, githubUpsertComment, githubCurrentUser, githubIssue, githubIssueClose, githubIssueComment,
  githubEnsureLabels, githubIssueCommentExists, githubIssueCreate, githubIssueEdit, githubIssueReopen, githubMerge, githubOpenIssues,
  githubOpenPullRequests, githubPullRequest, githubPullRequestsForBranch, githubPullRequestsForIssue, githubPreflight, githubLabelRemove, githubUnresolvedReviewThreads, type GitHubIssueDetail,
  type PullRequestSnapshot,
} from '../adapters/github-cli.js'
import { createTrackingAdapter, type TrackingAdapter } from '../adapters/tracking.js'
import { fail } from '../kernel/errors.js'
import type { LoopConfig } from './config.js'
import { filterAndOrderQueue, type LoopIssue } from '../adapters/linear-orca.js'
import type { TrackerIssueDetail } from './tracker.js'
import type { TrackerCommentOptions } from './comment-format.js'

/**
 * Everything the loop needs from an issue tracker. Linear is the first implementation; Jira, GitHub Issues or
 * Notion are a new implementation of this interface and nothing else — the engine never names a vendor.
 *
 * Reads are pull-based and writes are idempotent by `dedupeKey`: a stage that reruns must not produce a second
 * comment, which is the only reason the key is part of the interface rather than an implementation detail.
 */
export interface TrackerConnector {
  readonly id: string
  /**
   * Dispatchable issues, already filtered and ordered by the tracker. `ownership` overrides `linear.queueOwnership`
   * for this one read and `excludeLabels` adds to `linear.excludeLabels` — both exist for `linear.refill`, which
   * reads the person's queue AND the unassigned pool through the same filter rather than a second, drifting copy.
   */
  queue(input: { readonly assignee: string | null; readonly ownership?: 'person' | 'unassigned' | 'both'; readonly excludeLabels?: readonly string[] }): Promise<readonly LoopIssue[]>
  /** Issues the last `queue()` read dropped although they carry the todo lifecycle label, each with the filter that dropped it. */
  queueSkips?(): readonly { readonly identifier: string; readonly reason: string }[]
  issue(identifier: string): Promise<TrackerIssueDetail>
  comment(input: { readonly issue: string; readonly body: string; readonly dedupeKey?: string }): Promise<void>
  addLabels(issue: string, labels: readonly string[]): Promise<void>
  removeLabels(issue: string, labels: readonly string[]): Promise<void>
  setState(input: { readonly issue: string; readonly from?: string; readonly to: string; readonly reason?: string }): Promise<void>
  /** Take the issue for this machine; `release` puts it back. Both are no-ops for a tracker without assignees. */
  claim(issue: string, assignee: string): Promise<void>
  release(issue: string): Promise<void>
  attach(input: { readonly issue: string; readonly url: string; readonly title?: string; readonly dedupeKey?: string }): Promise<void>
  createIssue(input: { readonly title: string; readonly description: string; readonly state?: string; readonly labels?: readonly string[]; readonly priority?: string; readonly project?: string; readonly parent?: string; readonly dedupeKey?: string }): Promise<{ readonly identifier: string | null; readonly url: string | null }>
  /** The attested transition adapter, for the state changes that are recorded as decisions. */
  readonly transitions: TrackingAdapter
  /** Validate authenticated identity, repository access and write permission before a mutating run. */
  /** `missingLabels`: lifecycle labels absent in the tracker today (created on first use where the tracker can). */
  readonly preflight?: () => Promise<{ readonly login: string; readonly permission: string; readonly missingLabels?: readonly string[] }>
  /**
   * How a structured comment (the delivery evidence) is written for this tracker: Markdown or plain text, its size
   * ceiling, or the connector's own renderer (Jira ADF). Omitted = `DEFAULT_COMMENT_OPTIONS` (Markdown, 60k).
   */
  readonly comments?: TrackerCommentOptions
}

/** Everything the loop needs from the code host: pull requests, their checks, comments and the merge. */
export interface ScmConnector {
  readonly id: string
  pullRequest(number: number): Promise<PullRequestSnapshot>
  pullRequestsForBranch(head: string, state?: 'open' | 'merged' | 'closed' | 'all'): Promise<readonly PullRequestSnapshot[]>
  pullRequestsForIssue(issue: string, state?: 'open' | 'closed' | 'all'): Promise<readonly PullRequestSnapshot[]>
  openPullRequests(input?: { readonly limit?: number; readonly label?: string }): Promise<readonly PullRequestSnapshot[]>
  comment(input: { readonly number: number; readonly body: string }): Promise<void>
  commentExists(input: { readonly number: number; readonly marker: string }): Promise<boolean>
  /** Edit the comment carrying `marker` in place, or create it — one living comment instead of one per pass. */
  upsertComment(input: { readonly number: number; readonly body: string; readonly marker: string }): Promise<'created' | 'updated'>
  removeLabel(input: { readonly number: number; readonly label: string }): Promise<void>
  merge(input: { readonly number: number; readonly headSha: string; readonly method: 'squash' | 'merge' | 'rebase'; readonly title?: string }): Promise<{ readonly merged: boolean; readonly sha: string | null; readonly message: string }>
  /** Review threads nobody resolved; `null` when the host cannot say. Optional: evidence reports it as unavailable. */
  unresolvedReviewThreads?(number: number): Promise<number | null>
}

export interface ConnectorInput {
  readonly runner: CommandRunner
  readonly config: LoopConfig
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly dryRun?: boolean
}

/** Both supported tracker adapters are writable; this remains as a compatibility gate for callers. */
export const requireWritableTracker = (config: LoopConfig): void => {
  if (config.connectors.tracker !== 'linear' && config.connectors.tracker !== 'github') fail(`Unsupported tracker "${config.connectors.tracker}".`, 'INVALID_CONFIG')
}

/** `config.linear` as the queue filter, with `TrackerConnector.queue`'s per-read ownership override and extra excluded labels. */
const queueFilter = (config: LoopConfig, input: { readonly ownership?: 'person' | 'unassigned' | 'both' | undefined; readonly excludeLabels?: readonly string[] | undefined }): LoopConfig['linear'] => ({ ...config.linear, queueOwnership: input.ownership ?? config.linear.queueOwnership, excludeLabels: [...config.linear.excludeLabels, ...(input.excludeLabels ?? [])] })

// ponytail: both trackers get the body as one argv element and Windows caps a whole command line at 32,767 chars;
// a body near the vendor limit (~65k) would fail to spawn there, so it is held well under that on win32.
const argvBodyChars = (vendorMax: number): number => Math.min(vendorMax, process.platform === 'win32' ? 24_000 : vendorMax)

const linearOptions = (config: LoopConfig) => ({ bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } })

const githubOptions = (input: ConnectorInput) => ({ ...(input.env ? { env: input.env } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), timeoutMs: input.config.orca.timeoutMs })

const githubStateLabels = (config: LoopConfig): readonly string[] => {
  const labels = config.github.issues.labels
  return [labels.todo, labels.inProgress, labels.review, labels.done, labels.blocked]
}

const githubStateForLabels = (config: LoopConfig, labels: readonly string[]): string => {
  const lifecycle = config.github.issues.labels
  if (labels.includes(lifecycle.done)) return config.linear.doneState
  if (labels.includes(lifecycle.blocked)) return config.linear.blockedLabel
  if (labels.includes(lifecycle.review)) return config.linear.reviewState
  if (labels.includes(lifecycle.inProgress)) return config.linear.inProgressState
  if (labels.includes(lifecycle.todo)) return config.linear.states[0] ?? 'Todo'
  return 'Unclassified'
}

const githubLifecycleLabel = (config: LoopConfig, state: string): string => {
  const labels = config.github.issues.labels
  const normalized = state.trim().toLowerCase()
  const known = new Map<string, string>([
    [config.linear.states[0]?.toLowerCase() ?? 'todo', labels.todo],
    ['todo', labels.todo],
    ['ready', labels.todo],
    [config.linear.inProgressState.toLowerCase(), labels.inProgress],
    ['in progress', labels.inProgress],
    ['in-progress', labels.inProgress],
    [config.linear.reviewState.toLowerCase(), labels.review],
    ['review', labels.review],
    [config.linear.doneState.toLowerCase(), labels.done],
    ['done', labels.done],
    [config.linear.blockedLabel.toLowerCase(), labels.blocked],
    ['blocked', labels.blocked],
    [labels.todo.toLowerCase(), labels.todo],
    [labels.inProgress.toLowerCase(), labels.inProgress],
    [labels.review.toLowerCase(), labels.review],
    [labels.done.toLowerCase(), labels.done],
    [labels.blocked.toLowerCase(), labels.blocked],
  ])
  return known.get(normalized) ?? fail(`GitHub state "${state}" has no configured lifecycle label.`, 'INVALID_INPUT')
}

/** Planned GitHub issues stay unclassified until a human moves them into the dispatch lane. */
const githubCreateLifecycleLabel = (config: LoopConfig, state: string): string | null => {
  const normalized = state.trim().toLowerCase()
  return normalized === config.linear.entryState.toLowerCase() || normalized === 'backlog' ? null : githubLifecycleLabel(config, state)
}

const githubIssueToTracker = (config: LoopConfig, issue: GitHubIssueDetail | Awaited<ReturnType<typeof githubIssue>>): TrackerIssueDetail => ({
  id: issue.identifier,
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  state: issue.state === 'CLOSED' ? config.linear.doneState : githubStateForLabels(config, issue.labels),
  stateType: issue.state === 'CLOSED' ? 'completed' : 'started',
  assignee: issue.assignees[0] ?? null,
  assigneeId: null,
  labels: issue.labels,
  priority: 0,
  priorityLabel: 'none',
  project: null,
  branchName: null,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  description: issue.description,
  comments: issue.comments,
  raw: issue.raw,
})

/** Which queue filter dropped an issue labelled todo; mirrors the order `filterAndOrderQueue` applies them in. */
const githubSkipReason = (issue: LoopIssue, input: { readonly effective: string; readonly target: string; readonly filter: LoopConfig['linear'] }): string => {
  const { effective, target, filter } = input
  if (!((effective !== 'person' && issue.assignee === null) || (effective !== 'unassigned' && issue.assignee === target))) return `assignee ${issue.assignee ?? 'none'} is outside queueOwnership "${effective}" (queue owner ${target})`
  const excluded = issue.labels.find((label) => label === filter.outsideLabel || filter.excludeLabels.includes(label))
  if (excluded) return `label "${excluded}" is in linear.excludeLabels`
  if (!filter.states.includes(issue.state)) return `state "${issue.state}" is not in linear.states`
  if (filter.anyLabels?.length && !filter.anyLabels.some((label) => issue.labels.includes(label))) return `none of github.issues.anyLabels (${filter.anyLabels.join(', ')}) is on the issue`
  return `beyond linear.maxQueue (${filter.maxQueue})`
}

/** GitHub Issues over `gh`; all provider-specific lifecycle behaviour lives behind TrackerConnector. */
export const createGitHubTracker = (input: ConnectorInput): TrackerConnector => {
  const { config, runner } = input
  const repo = config.project.repo
  const options = githubOptions(input)
  const lifecycleLabels = githubStateLabels(config)
  let cachedAssignee = config.github.issues.assignee ?? null
  let assigneeResolved = cachedAssignee !== null
  const defaultAssignee = async (): Promise<string> => {
    if (!assigneeResolved) { cachedAssignee = await githubCurrentUser(runner, options); assigneeResolved = true }
    return cachedAssignee ?? fail('No GitHub assignee could be resolved.', 'HARNESS_ERROR')
  }
  const readDetail = async (identifier: string): Promise<TrackerIssueDetail> => githubIssueToTracker(config, await githubIssue(runner, { repo, identifier }, options))
  // Labels the loop applies are its own: create a missing one instead of failing the edit. One label listing per
  // connector instance (a stage run), and only when something is actually labelled.
  const ensured = new Set<string>()
  const ensureLabels = async (labels: readonly string[]): Promise<void> => {
    const pending = labels.filter((label) => !ensured.has(label))
    if (!pending.length || input.dryRun) return
    await githubEnsureLabels(runner, { repo, labels: [...new Set([...lifecycleLabels, ...pending])] }, options)
    for (const label of [...lifecycleLabels, ...pending]) ensured.add(label)
  }
  const setState = async ({ issue, to }: { readonly issue: string; readonly to: string }): Promise<void> => {
    const target = githubLifecycleLabel(config, to)
    await ensureLabels([target])
    const current = await githubIssue(runner, { repo, identifier: issue }, options)
    const currentKnown = current.labels.filter((label) => lifecycleLabels.includes(label))
    if (currentKnown.length !== 1 || currentKnown[0] !== target) await githubIssueEdit(runner, { repo, identifier: issue, removeLabels: currentKnown.filter((label) => label !== target), addLabels: [target] }, options)
    if (target === config.github.issues.labels.done) {
      if (current.state !== 'CLOSED') await githubIssueClose(runner, { repo, identifier: issue }, options)
    } else if (current.state !== 'OPEN') await githubIssueReopen(runner, { repo, identifier: issue }, options)
  }

  let skips: readonly { readonly identifier: string; readonly reason: string }[] = []
  let tracker: TrackerConnector
  tracker = {
    id: 'github',
    queue: async ({ ownership, excludeLabels }) => {
      const target = await defaultAssignee()
      const issues = await githubOpenIssues(runner, { repo, limit: config.github.issues.maxIssues }, options)
      const normalized: LoopIssue[] = issues.map((issue) => ({
        id: issue.identifier, identifier: issue.identifier, title: issue.title, url: issue.url,
        state: githubStateForLabels(config, issue.labels), stateType: 'started', assignee: issue.assignees[0] ?? null,
        assigneeId: null, labels: issue.labels, priority: 0, priorityLabel: 'none', project: null, branchName: null,
        createdAt: issue.createdAt, updatedAt: issue.updatedAt,
      }))
      const effective = ownership ?? config.linear.queueOwnership
      const owned = normalized.filter((issue) => (effective !== 'person' && issue.assignee === null) || (effective !== 'unassigned' && issue.assignee === target))
      // The Linear label/project filters (`linear.requireLabels`, `anyLabels`, `projects`) describe a Linear board; a
      // GitHub queue is narrowed by `github.issues.anyLabels` instead.
      const filter = { ...queueFilter(config, { ownership, excludeLabels }), requireLabels: [], projects: [], anyLabels: config.github.issues.anyLabels }
      const queue = filterAndOrderQueue(owned, filter)
      const kept = new Set(queue.map((issue) => issue.identifier))
      skips = normalized.filter((issue) => issue.labels.includes(config.github.issues.labels.todo) && !kept.has(issue.identifier))
        .map((issue) => ({ identifier: issue.identifier, reason: githubSkipReason(issue, { effective, target, filter }) }))
      return queue
    },
    queueSkips: () => skips,
    issue: readDetail,
    comment: async ({ issue, body, dedupeKey }) => {
      const marker = dedupeKey ? `<!-- harness:${dedupeKey} -->` : null
      if (marker && await githubIssueCommentExists(runner, { repo, identifier: issue, marker }, options)) return
      await githubIssueComment(runner, { repo, identifier: issue, body: marker ? `${body}\n\n${marker}` : body }, options)
    },
    addLabels: async (issue, labels) => {
      const lifecycle = labels.filter((label) => lifecycleLabels.includes(label))
      if (lifecycle.length) fail(`Use setState to change GitHub lifecycle labels; direct add would violate exclusivity: ${lifecycle.join(', ')}.`, 'INVALID_INPUT')
      if (!labels.length) return
      await ensureLabels(labels)
      await githubIssueEdit(runner, { repo, identifier: issue, addLabels: labels }, options)
    },
    removeLabels: async (issue, labels) => { if (labels.length) await githubIssueEdit(runner, { repo, identifier: issue, removeLabels: labels }, options) },
    setState,
    claim: async (issue) => { await githubIssueEdit(runner, { repo, identifier: issue, addAssignees: [await defaultAssignee()] }, options) },
    release: async (issue) => { await githubIssueEdit(runner, { repo, identifier: issue, removeAssignees: [await defaultAssignee()] }, options) },
    attach: async ({ issue, url, title, dedupeKey }) => { await tracker.comment({ issue, body: `[${title ?? url}](${url})`, ...(dedupeKey ? { dedupeKey } : {}) }) },
    createIssue: async ({ title, description, state, labels, project, parent, dedupeKey }) => {
      const lifecycle = githubCreateLifecycleLabel(config, state ?? config.linear.states[0] ?? 'Todo')
      const relation = [project ? `**Project:** ${project}` : '', parent ? `**Parent issue:** ${parent}` : ''].filter(Boolean).join('\n\n')
      const content = [description, relation].filter(Boolean).join('\n\n')
      const body = dedupeKey ? `${content}\n\n<!-- harness:${dedupeKey} -->` : content
      // `gh issue create --label` fails on a label the repo does not have yet (`loop:backlog` on a leftovers issue).
      await ensureLabels(labels ?? [])
      return githubIssueCreate(runner, { repo, title, body, labels: [...new Set([...(lifecycle ? [lifecycle] : []), ...(labels ?? [])])], assignee: await defaultAssignee(), ...(dedupeKey ? { dedupeKey } : {}) }, options)
    },
    transitions: createTrackingAdapter('github', async (transition) => { await setState({ issue: transition.issue, to: transition.to }) }, { ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) }),
    preflight: async () => githubPreflight(runner, { repo, labels: lifecycleLabels }, options),
    // GitHub caps a comment at 65,536 chars; the connector appends its own dedupe marker.
    comments: { format: 'markdown', maxChars: argvBodyChars(65_000) },
  }
  return tracker
}

/** Linear over Orca's CLI — the first `TrackerConnector`. */
export const createLinearTracker = (input: ConnectorInput): TrackerConnector => {
  const { runner, config } = input
  const write = linearOptions(config)
  return {
    id: 'linear',
    queue: async ({ assignee, ownership, excludeLabels }) => fetchLinearQueue(runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: assignee ?? '', filter: queueFilter(config, { ownership, excludeLabels }), orca: { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs } }),
    issue: async (identifier) => fetchLinearIssue(runner, identifier, write),
    comment: async ({ issue, body, dedupeKey }) => { await linearCommentAdd(runner, { issue, body, ...(dedupeKey ? { dedupeKey } : {}) }, write) },
    addLabels: async (issue, labels) => { await linearLabelAdd(runner, { issue, labels }, write) },
    removeLabels: async (issue, labels) => { await linearLabelRemove(runner, { issue, labels }, write) },
    setState: async ({ issue, to }) => { await linearStatusSet(runner, { issue, to }, write) },
    // `assignee` is a `models.linear.people` key (a person, e.g. `state.person`), not the Linear user id Orca's
    // CLI now requires (`--to-id`, see `linearAssigneeSetArgv`) — resolve it here so every caller keeps naming
    // the person, and fail loudly on a stale/missing map entry instead of silently sending a bad id.
    claim: async (issue, assignee) => {
      const toId = config.linear.people[assignee] ?? fail(`No Linear user id configured for "${assignee}" (models.linear.people.${assignee}) — cannot claim ${issue}.`, 'INVALID_CONFIG')
      await linearAssigneeSet(runner, { issue, toId }, write)
    },
    release: async (issue) => { await linearAssigneeClear(runner, { issue }, write) },
    attach: async ({ issue, url, title, dedupeKey }) => { await linearAttach(runner, { issue, url, ...(title ? { title } : {}), ...(dedupeKey ? { dedupeKey } : {}) }, write) },
    createIssue: async ({ title, description, state, labels, priority, project, parent, dedupeKey }) => linearSaveIssue(runner, {
      team: config.linear.teamKey, title, description,
      ...(state ? { state } : {}), ...(labels?.length ? { labels } : {}), ...(priority ? { priority } : {}), ...(project ? { project } : {}), ...(parent ? { parentId: parent } : {}), ...(dedupeKey ? { dedupeKey } : {}),
    }, write),
    transitions: createLinearTrackingAdapter(runner, { ...write, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) }),
    // Linear comments are Markdown; ~65k is the practical body ceiling.
    comments: { format: 'markdown', maxChars: argvBodyChars(65_000) },
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
    pullRequestsForIssue: async (issue, state) => { const number = Number(issue.split('#').at(-1)); if (!Number.isInteger(number) || number < 1) return []; return githubPullRequestsForIssue(runner, { repo, issue: number, ...(state ? { state } : {}) }, options) },
    openPullRequests: async (query) => githubOpenPullRequests(runner, { repo, ...(query?.limit ? { limit: query.limit } : {}), ...(query?.label ? { label: query.label } : {}) }, options),
    comment: async ({ number, body }) => { await githubComment(runner, { repo, number, body }, options) },
    commentExists: async ({ number, marker }) => githubCommentExists(runner, { repo, number, marker }, options),
    upsertComment: async ({ number, body, marker }) => githubUpsertComment(runner, { repo, number, body, marker }, options),
    removeLabel: async ({ number, label }) => { await githubLabelRemove(runner, { repo, number, label }, options) },
    merge: async ({ number, headSha, method, title }) => githubMerge(runner, { repo, number, headSha, method, ...(title ? { title } : {}) }, options),
    unresolvedReviewThreads: async (number) => githubUnresolvedReviewThreads(runner, { repo, number }, options),
  }
}

/**
 * The connectors this config selects. Two implementations exist today; a third is a new factory here and a new
 * value in `connectors.*`, never a change in tick, deliver or release.
 */
export const resolveConnectors = (input: ConnectorInput): { readonly tracker: TrackerConnector; readonly scm: ScmConnector } => {
  const { tracker, scm } = input.config.connectors
  return {
    tracker: tracker === 'linear' ? createLinearTracker(input) : tracker === 'github' ? createGitHubTracker(input) : fail_unknown('tracker', tracker),
    scm: scm === 'github' ? createGitHubScm(input) : fail_unknown('scm', scm),
  }
}

const fail_unknown = (kind: string, id: string): never => { throw new Error(`Unknown ${kind} connector "${id}". Implement it against the ${kind === 'tracker' ? 'TrackerConnector' : 'ScmConnector'} interface and register it in resolveConnectors.`) }
