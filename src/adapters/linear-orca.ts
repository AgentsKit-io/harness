import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { orcaJson, type OrcaCliOptions } from './orca-cli.js'
import { createTrackingAdapter, type TrackingAdapter } from './tracking.js'
import type { CommandRunner } from './command.js'

export interface LoopIssue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly state: string
  readonly stateType: string
  readonly assignee: string | null
  readonly assigneeId: string | null
  readonly labels: readonly string[]
  readonly priority: number
  readonly priorityLabel: string
  readonly project: string | null
  readonly branchName: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LinearQueueFilter {
  readonly states: readonly string[]
  readonly excludeLabels: readonly string[]
  /** Every one of these must be present on the issue (AND). Empty = no constraint. */
  readonly requireLabels: readonly string[]
  /**
   * At least ONE of these must be present (OR). Empty or absent = no constraint.
   *
   * This is what lets a machine declare the slices of the board it drains — `layer:L2` or `layer:L3` —
   * which `requireLabels` cannot express: it demands all of them on the same issue, so listing two
   * layers matches nothing at all. A queue that silently returns zero is the worst failure mode this
   * loop has, because it is indistinguishable from "no work to do".
   *
   * Optional on purpose: the config schema always supplies it, and a caller that builds the filter by
   * hand keeps working untouched. A new field on a published type should not crash an existing consumer.
   */
  readonly anyLabels?: readonly string[]
  readonly projects: readonly string[]
  readonly order: readonly ('priority' | 'updatedAt' | 'createdAt')[]
  readonly maxQueue: number
  /**
   * Whose queue this is.
   *
   * `person` (the default, and the only historical behaviour) drains the issues ASSIGNED to
   * `linear.person`: the assignee is ownership, and an issue nobody owns is invisible.
   *
   * `unassigned` inverts that: the queue is the issues with NO assignee, ordered by priority, and the
   * assignee becomes a TRANSIENT CLAIM — the loop writes it when it dispatches and clears it when the
   * item comes back. That is what lets several machines drain one queue without two of them picking the
   * same issue, and it is why an unowned issue is the normal state rather than a lost one.
   *
   * Absent reads as `person`, so a caller that builds the filter by hand keeps the historical behaviour.
   */
  readonly queueOwnership?: 'person' | 'unassigned'
}

/** The `--assignee` value the queue is listed with. `null` is Orca's literal for "unassigned". */
export const queueAssigneeFilter = (filter: Pick<LinearQueueFilter, 'queueOwnership'>, person: string): string =>
  filter.queueOwnership === 'unassigned' ? 'null' : person

export interface LinearListInput {
  readonly bin?: string
  readonly workspaceId: string
  readonly teamKey: string
  readonly assignee: string
  readonly state: string
  readonly limit: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const name = (value: unknown): string | null => isRecord(value) && typeof value['name'] === 'string' ? value['name'] : null

export const parseLinearIssues = (result: unknown): readonly LoopIssue[] => {
  const list = isRecord(result) && Array.isArray(result['issues']) ? result['issues'] : Array.isArray(result) ? result : []
  return list.filter(isRecord).map((item) => {
    const state = isRecord(item['state']) ? item['state'] : {}
    const assignee = isRecord(item['assignee']) ? item['assignee'] : null
    return {
      id: str(item['id']),
      identifier: str(item['identifier']),
      title: str(item['title']),
      url: str(item['url']),
      state: str(state['name'], 'unknown'),
      stateType: str(state['type'], 'unknown'),
      assignee: assignee ? str(assignee['displayName'], str(assignee['name'])) || null : null,
      assigneeId: assignee ? str(assignee['id']) || null : null,
      labels: Array.isArray(item['labels']) ? item['labels'].map((label: unknown) => isRecord(label) ? str(label['name']) : str(label)).filter(Boolean) : [],
      priority: typeof item['priority'] === 'number' ? item['priority'] : 0,
      priorityLabel: str(item['priorityLabel'], 'none'),
      project: name(item['project']),
      branchName: typeof item['branchName'] === 'string' && item['branchName'].trim() ? item['branchName'] : null,
      createdAt: str(item['createdAt']),
      updatedAt: str(item['updatedAt']),
    }
  }).filter((issue) => issue.identifier)
}

export const buildListIssuesArgv = (input: LinearListInput): readonly string[] => [input.bin ?? 'orca', 'linear', 'list-issues', '--team', input.teamKey, '--workspace', input.workspaceId, '--assignee', input.assignee, '--state', input.state, '--limit', String(input.limit), '--json']

/** Linear priority: 0 = none sorts last; 1 = urgent first. */
const priorityRank = (priority: number): number => priority === 0 ? Number.MAX_SAFE_INTEGER : priority

export const filterAndOrderQueue = (issues: readonly LoopIssue[], filter: LinearQueueFilter): readonly LoopIssue[] => {
  const states = new Set(filter.states)
  const exclude = new Set(filter.excludeLabels)
  const seen = new Set<string>()
  const eligible = issues.filter((issue) => {
    if (seen.has(issue.identifier)) return false
    seen.add(issue.identifier)
    if (!states.has(issue.state)) return false
    if (issue.labels.some((label) => exclude.has(label))) return false
    if (filter.requireLabels.length && !filter.requireLabels.every((label) => issue.labels.includes(label))) return false
    // OR, and deliberately a separate field from `requireLabels`: a machine declaring the layers it
    // drains needs "any of these", and folding both meanings into one list would make it impossible to
    // say "layer:L2 or layer:L3, and always type:fix".
    const anyLabels = filter.anyLabels ?? []
    if (anyLabels.length && !anyLabels.some((label) => issue.labels.includes(label))) return false
    if (filter.projects.length && (!issue.project || !filter.projects.includes(issue.project))) return false
    return true
  })
  const compare = (left: LoopIssue, right: LoopIssue): number => {
    for (const key of filter.order) {
      const diff = key === 'priority' ? priorityRank(left.priority) - priorityRank(right.priority) : key === 'updatedAt' ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt) : Date.parse(left.createdAt) - Date.parse(right.createdAt)
      if (diff !== 0 && Number.isFinite(diff)) return diff
    }
    return left.identifier.localeCompare(right.identifier)
  }
  return [...eligible].sort(compare).slice(0, filter.maxQueue)
}

export interface FetchQueueInput extends Omit<LinearListInput, 'state' | 'limit'> {
  readonly filter: LinearQueueFilter
  readonly pageLimit?: number
  readonly orca?: OrcaCliOptions
}

/** One `list-issues` call per configured state (Orca keeps only the last repeated `--state`), then filter/order locally. */
export const fetchLinearQueue = async (runner: CommandRunner, input: FetchQueueInput): Promise<readonly LoopIssue[]> => {
  // The queue's `--assignee` is NOT always the person: under `queueOwnership: 'unassigned'` it is
  // Orca's literal `null`, because there the assignee is a claim the loop writes, not the filter.
  const assignee = queueAssigneeFilter(input.filter, input.assignee)
  const pages = await Promise.all(input.filter.states.map(async (state) => parseLinearIssues(await orcaJson(runner, buildListIssuesArgv({ workspaceId: input.workspaceId, teamKey: input.teamKey, assignee, state, limit: input.pageLimit ?? 200 }).slice(1), { ...input.orca, ...(input.bin ? { bin: input.bin } : {}) }))))
  return filterAndOrderQueue(pages.flat(), input.filter)
}

// ---- issue detail and writes ------------------------------------------------------------------

export interface LinearIssueDetail extends LoopIssue {
  readonly description: string
  readonly comments: readonly { readonly author: string | null; readonly body: string; readonly createdAt: string }[]
  readonly raw: unknown
}

const commentsOf = (result: Record<string, unknown>): LinearIssueDetail['comments'] => {
  const list = Array.isArray(result['comments']) ? result['comments'] : []
  return list.filter(isRecord).map((item) => ({ author: isRecord(item['user']) ? str(item['user']['displayName'], str(item['user']['name'])) || null : str(item['author']) || null, body: str(item['body']), createdAt: str(item['createdAt']) }))
}

export const parseLinearIssueDetail = (result: unknown): LinearIssueDetail => {
  const record = isRecord(result) ? (isRecord(result['issue']) ? result['issue'] : result) : {}
  const [issue] = parseLinearIssues([record])
  if (!issue) return fail('Linear issue payload has no identifier.', 'HARNESS_ERROR')
  return { ...issue, description: str(record['description']), comments: commentsOf(isRecord(result) ? result : {}), raw: result }
}

export interface LinearWriteOptions { readonly bin?: string; readonly workspaceId: string; readonly orca?: OrcaCliOptions }

const scoped = (options: LinearWriteOptions): OrcaCliOptions => ({ ...options.orca, ...(options.bin ? { bin: options.bin } : {}) })

export const fetchLinearIssue = async (runner: CommandRunner, identifier: string, options: LinearWriteOptions): Promise<LinearIssueDetail> => parseLinearIssueDetail(await orcaJson(runner, ['linear', 'issue', identifier, '--full', '--workspace', options.workspaceId], scoped(options)))

/** Deterministic UUID (v4 layout) derived from a stable key, for Orca's `--write-id` idempotency. */
export const writeIdFor = (key: string): string => {
  const hex = hashJson(key).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** `--to-id` takes a Linear user id, not a username — resolve `config.linear.people[person]` before calling (see `createLinearTracker`'s `claim`). Orca's CLI dropped `--assignee` for `assignee set` (still accepted by `list-issues`); verified live 2026-09-21 against orca 1.4.205: `Unknown flag --assignee for command: linear assignee set`. */
export const linearAssigneeSetArgv = (input: { readonly issue: string; readonly toId: string; readonly workspaceId: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'assignee', 'set', input.issue, '--to-id', input.toId, '--workspace', input.workspaceId, '--json']
export const linearAssigneeClearArgv = (input: { readonly issue: string; readonly workspaceId: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'assignee', 'clear', input.issue, '--workspace', input.workspaceId, '--json']

export const linearStatusSetArgv = (input: { readonly issue: string; readonly to: string; readonly workspaceId: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'status', 'set', input.issue, '--to', input.to, '--workspace', input.workspaceId, '--json']
export const linearCommentAddArgv = (input: { readonly issue: string; readonly body: string; readonly workspaceId: string; readonly writeId?: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'comment', 'add', input.issue, '--body', input.body, '--workspace', input.workspaceId, ...(input.writeId ? ['--write-id', input.writeId] : []), '--json']
export const linearLabelArgv = (input: { readonly issue: string; readonly labels: readonly string[]; readonly workspaceId: string; readonly action: 'add' | 'remove' }, bin = 'orca'): readonly string[] => [bin, 'linear', 'label', input.action, input.issue, ...input.labels.flatMap((label) => ['--label', label]), '--workspace', input.workspaceId, '--json']
export const linearAttachArgv = (input: { readonly issue: string; readonly url: string; readonly title?: string; readonly workspaceId: string; readonly writeId?: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'attach', input.issue, '--url', input.url, ...(input.title ? ['--title', input.title] : []), '--workspace', input.workspaceId, ...(input.writeId ? ['--write-id', input.writeId] : []), '--json']

export const linearSaveIssueArgv = (input: { readonly team: string; readonly title: string; readonly description?: string; readonly state?: string; readonly labels?: readonly string[]; readonly priority?: string; readonly project?: string; readonly parentId?: string; readonly workspaceId: string; readonly writeId?: string }, bin = 'orca'): readonly string[] => [bin, 'linear', 'save-issue', '--team', input.team, '--title', input.title,
  ...(input.description ? ['--description', input.description] : []),
  ...(input.state ? ['--state', input.state] : []),
  ...(input.priority ? ['--priority', input.priority] : []),
  ...(input.project ? ['--project', input.project] : []),
  ...(input.parentId ? ['--parent-id', input.parentId] : []),
  ...(input.labels ?? []).flatMap((label) => ['--label', label]),
  '--workspace', input.workspaceId,
  ...(input.writeId ? ['--write-id', input.writeId] : []),
  '--json']

/** Create one issue. `dedupeKey` becomes Orca's `--write-id`, so a retried decompose cannot create the same issue twice. */
export const linearSaveIssue = async (runner: CommandRunner, input: { readonly team: string; readonly title: string; readonly description?: string; readonly state?: string; readonly labels?: readonly string[]; readonly priority?: string; readonly project?: string; readonly parentId?: string; readonly dedupeKey?: string }, options: LinearWriteOptions): Promise<{ readonly identifier: string | null; readonly url: string | null }> => {
  const result = await orcaJson(runner, linearSaveIssueArgv({ ...input, workspaceId: options.workspaceId, ...(input.dedupeKey ? { writeId: writeIdFor(input.dedupeKey) } : {}) }).slice(1), scoped(options))
  const record = isRecord(result) ? (isRecord(result['issue']) ? result['issue'] : result) : {}
  return { identifier: typeof record['identifier'] === 'string' ? record['identifier'] : null, url: typeof record['url'] === 'string' ? record['url'] : null }
}

export const linearStatusSet = async (runner: CommandRunner, input: { readonly issue: string; readonly to: string }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearStatusSetArgv({ ...input, workspaceId: options.workspaceId }).slice(1), scoped(options))
export const linearCommentAdd = async (runner: CommandRunner, input: { readonly issue: string; readonly body: string; readonly dedupeKey?: string }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearCommentAddArgv({ issue: input.issue, body: input.body, workspaceId: options.workspaceId, ...(input.dedupeKey ? { writeId: writeIdFor(input.dedupeKey) } : {}) }).slice(1), scoped(options))
/**
 * Claim an issue for this machine. Under `queueOwnership: 'unassigned'` this is what takes the issue
 * OUT of every other machine's queue, so it runs right after the dispatch succeeds — never before, or a
 * failed dispatch would leave the item claimed by nobody's worker.
 */
export const linearAssigneeSet = async (runner: CommandRunner, input: { readonly issue: string; readonly toId: string }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearAssigneeSetArgv({ ...input, workspaceId: options.workspaceId }).slice(1), scoped(options))
/** Release the claim, putting the issue back in the unassigned queue. Pairs with `linearAssigneeSet`. */
export const linearAssigneeClear = async (runner: CommandRunner, input: { readonly issue: string }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearAssigneeClearArgv({ ...input, workspaceId: options.workspaceId }).slice(1), scoped(options))

export const linearLabelAdd = async (runner: CommandRunner, input: { readonly issue: string; readonly labels: readonly string[] }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearLabelArgv({ ...input, action: 'add', workspaceId: options.workspaceId }).slice(1), scoped(options))
export const linearLabelRemove = async (runner: CommandRunner, input: { readonly issue: string; readonly labels: readonly string[] }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearLabelArgv({ ...input, action: 'remove', workspaceId: options.workspaceId }).slice(1), scoped(options))
export const linearAttach = async (runner: CommandRunner, input: { readonly issue: string; readonly url: string; readonly title?: string; readonly dedupeKey?: string }, options: LinearWriteOptions): Promise<unknown> => orcaJson(runner, linearAttachArgv({ issue: input.issue, url: input.url, ...(input.title ? { title: input.title } : {}), workspaceId: options.workspaceId, ...(input.dedupeKey ? { writeId: writeIdFor(input.dedupeKey) } : {}) }).slice(1), scoped(options))

/** Harness `TrackingAdapter` over Linear: each transition becomes one `status set`, deduped by the harness idempotency key. */
export const createLinearTrackingAdapter = (runner: CommandRunner, options: LinearWriteOptions & { readonly dryRun?: boolean }): TrackingAdapter => createTrackingAdapter('linear', async (transition) => { await linearStatusSet(runner, { issue: transition.issue, to: transition.to }, options) }, { ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) })
