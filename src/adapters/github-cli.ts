import { fail } from '../kernel/errors.js'
import type { CommandRunner } from './command.js'

export interface GitHubCliOptions { readonly bin?: string; readonly timeoutMs?: number; readonly cwd?: string }

export type CheckOutcome = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | 'unknown'

export interface PullRequestCheck { readonly name: string; readonly outcome: CheckOutcome; readonly kind: 'check-run' | 'status' | 'unknown' }

export interface PullRequestSnapshot {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN'
  readonly isDraft: boolean
  readonly author: string | null
  readonly authorIsBot: boolean
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  readonly mergeState: string
  readonly reviewDecision: string
  readonly labels: readonly string[]
  readonly files: readonly string[]
  /** Lines added and removed across the PR's files; 0 when the host did not report them. */
  readonly changedLines: number
  readonly checks: readonly PullRequestCheck[]
  readonly updatedAt: string | null
}

export interface ChecksAssessment {
  readonly status: 'green' | 'pending' | 'red' | 'missing'
  readonly failing: readonly string[]
  readonly pending: readonly string[]
  readonly missingRequired: readonly string[]
}

export const PR_FIELDS = ['number', 'url', 'title', 'state', 'isDraft', 'author', 'headRefName', 'headRefOid', 'baseRefName', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'labels', 'files', 'statusCheckRollup', 'updatedAt'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback

const outcomeOf = (item: Record<string, unknown>): CheckOutcome => {
  const raw = str(item['conclusion'], str(item['state'])).toUpperCase()
  const status = str(item['status']).toUpperCase()
  if (raw === 'SUCCESS') return 'success'
  if (raw === 'SKIPPED') return 'skipped'
  if (raw === 'NEUTRAL') return 'neutral'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(raw)) return 'failure'
  if (raw === 'PENDING' || raw === 'EXPECTED' || (status && status !== 'COMPLETED') || (!raw && status)) return 'pending'
  return 'unknown'
}

export const parsePullRequest = (value: unknown): PullRequestSnapshot => {
  if (!isRecord(value) || typeof value['number'] !== 'number') fail('Pull request payload must contain a numeric number.', 'INVALID_INPUT')
  const record = value as Record<string, unknown>
  const author = isRecord(record['author']) ? record['author'] : null
  const rollup = Array.isArray(record['statusCheckRollup']) ? record['statusCheckRollup'].filter(isRecord) : []
  const state = str(record['state']).toUpperCase()
  const mergeable = str(record['mergeable']).toUpperCase()
  return {
    number: record['number'] as number,
    url: str(record['url']),
    title: str(record['title']),
    state: state === 'OPEN' || state === 'CLOSED' || state === 'MERGED' ? state : 'UNKNOWN',
    isDraft: record['isDraft'] === true,
    author: author ? str(author['login']) || null : null,
    authorIsBot: author ? author['is_bot'] === true : false,
    headRef: str(record['headRefName']),
    headSha: str(record['headRefOid']),
    baseRef: str(record['baseRefName']),
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    mergeState: str(record['mergeStateStatus'], 'UNKNOWN'),
    reviewDecision: str(record['reviewDecision']),
    labels: Array.isArray(record['labels']) ? record['labels'].map((label: unknown) => isRecord(label) ? str(label['name']) : str(label)).filter(Boolean) : [],
    files: Array.isArray(record['files']) ? record['files'].map((file: unknown) => isRecord(file) ? str(file['path']) : str(file)).filter(Boolean) : [],
    changedLines: Array.isArray(record['files']) ? record['files'].reduce((total: number, file: unknown) => total + (isRecord(file) ? (typeof file['additions'] === 'number' ? file['additions'] : 0) + (typeof file['deletions'] === 'number' ? file['deletions'] : 0) : 0), 0) : 0,
    checks: rollup.map((item) => ({ name: str(item['name'], str(item['context'], 'unnamed')), outcome: outcomeOf(item), kind: item['__typename'] === 'CheckRun' ? 'check-run' : item['__typename'] === 'StatusContext' ? 'status' : 'unknown' })),
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : null,
  }
}

/** Green only when every non-skipped check succeeded (or was neutral) and every required name was observed. A missing required check is never "green". */
export const assessChecks = (checks: readonly PullRequestCheck[], required: readonly string[] = [], ignore: readonly string[] = []): ChecksAssessment => {
  const considered = checks.filter((check) => !ignore.includes(check.name))
  const failing = considered.filter((check) => check.outcome === 'failure' || check.outcome === 'unknown').map((check) => check.name)
  const pending = considered.filter((check) => check.outcome === 'pending').map((check) => check.name)
  const observed = new Set(considered.map((check) => check.name))
  const missingRequired = required.filter((name) => !observed.has(name))
  const status = failing.length ? 'red' : missingRequired.length ? 'missing' : pending.length ? 'pending' : 'green'
  return { status, failing, pending, missingRequired }
}

const globToRegex = (pattern: string): RegExp => {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') { if (pattern[index + 2] === '/') { out += '(?:.*/)?'; index += 2 } else { out += '.*'; index += 1 } } else out += '[^/]*'
    } else out += /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${out}$`)
}

/** Files matched by the configured self-edit globs (`**` = any depth, `*` = one path segment). */
export const touchesProtectedPaths = (files: readonly string[], patterns: readonly string[]): readonly string[] => {
  const regexes = patterns.map(globToRegex)
  return files.filter((file) => regexes.some((regex) => regex.test(file)))
}

const ghJson = async (runner: CommandRunner, args: readonly string[], options: GitHubCliOptions): Promise<unknown> => {
  const argv = [options.bin ?? 'gh', ...args]
  const outcome = await runner.run(argv, { timeoutMs: options.timeoutMs ?? 30_000, ...(options.cwd ? { cwd: options.cwd } : {}) })
  if (outcome.timedOut) return fail(`${argv.slice(0, 3).join(' ')} timed out.`, 'HARNESS_ERROR')
  if (outcome.code !== 0) return fail(`${argv.slice(0, 3).join(' ')} exited ${outcome.code ?? 'null'}: ${outcome.stderr.trim().slice(0, 300)}`, 'HARNESS_ERROR')
  try { return JSON.parse(outcome.stdout) as unknown } catch { return fail(`${argv.slice(0, 3).join(' ')} did not return JSON.`, 'HARNESS_ERROR') }
}

export const githubPullRequest = async (runner: CommandRunner, input: { readonly repo: string; readonly number: number }, options: GitHubCliOptions = {}): Promise<PullRequestSnapshot> => parsePullRequest(await ghJson(runner, ['pr', 'view', String(input.number), '--repo', input.repo, '--json', PR_FIELDS.join(',')], options))

/** Open PRs whose head branch equals `head` (exact match); empty when none. */
export const githubPullRequestsForBranch = async (runner: CommandRunner, input: { readonly repo: string; readonly head: string; readonly state?: 'open' | 'merged' | 'closed' | 'all' }, options: GitHubCliOptions = {}): Promise<readonly PullRequestSnapshot[]> => {
  const list = await ghJson(runner, ['pr', 'list', '--repo', input.repo, '--head', input.head, '--state', input.state ?? 'open', '--json', PR_FIELDS.join(',')], options)
  return (Array.isArray(list) ? list : []).map(parsePullRequest).filter((pr) => pr.headRef === input.head)
}

export const githubOpenPullRequests = async (runner: CommandRunner, input: { readonly repo: string; readonly limit?: number; readonly label?: string }, options: GitHubCliOptions = {}): Promise<readonly PullRequestSnapshot[]> => {
  const list = await ghJson(runner, ['pr', 'list', '--repo', input.repo, '--state', 'open', '--limit', String(input.limit ?? 50), ...(input.label ? ['--label', input.label] : []), '--json', PR_FIELDS.join(',')], options)
  return (Array.isArray(list) ? list : []).map(parsePullRequest)
}

/** PRs natively associated with a GitHub issue through GitHub's issue search/index. */
export const githubPullRequestsForIssue = async (runner: CommandRunner, input: { readonly repo: string; readonly issue: number; readonly state?: 'open' | 'closed' | 'all' }, options: GitHubCliOptions = {}): Promise<readonly PullRequestSnapshot[]> => {
  const list = await ghJson(runner, ['pr', 'list', '--repo', input.repo, '--state', input.state ?? 'all', '--search', `is:pr #${input.issue}`, '--limit', '50', '--json', PR_FIELDS.join(',')], options)
  return (Array.isArray(list) ? list : []).map(parsePullRequest)
}

export interface GitHubIssueSnapshot {
  readonly number: number
  readonly identifier: string
  readonly url: string
  readonly title: string
  readonly state: 'OPEN' | 'CLOSED'
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export const ISSUE_FIELDS = ['number', 'url', 'title', 'state', 'labels', 'assignees', 'createdAt', 'updatedAt'] as const
export const ISSUE_DETAIL_FIELDS = [...ISSUE_FIELDS, 'body', 'comments'] as const

export const parseGitHubIssue = (value: unknown, repo: string): GitHubIssueSnapshot => {
  if (!isRecord(value) || !Number.isInteger(value['number']) || (value['number'] as number) < 1) fail('GitHub issue payload must contain a positive numeric number.', 'INVALID_INPUT')
  const record = value as Record<string, unknown>
  const url = str(record['url'])
  const title = str(record['title'])
  const state = str(record['state']).toUpperCase()
  const createdAt = str(record['createdAt'])
  const updatedAt = str(record['updatedAt'])
  if (!url || !title || (state !== 'OPEN' && state !== 'CLOSED') || !createdAt || !updatedAt) fail(`GitHub issue #${record['number']} payload is incomplete.`, 'INVALID_INPUT')
  const labels = Array.isArray(record['labels']) ? record['labels'].map((label) => isRecord(label) ? str(label['name']) : str(label)).filter(Boolean) : []
  const assignees = Array.isArray(record['assignees']) ? record['assignees'].map((assignee) => isRecord(assignee) ? str(assignee['login']) : str(assignee)).filter(Boolean) : []
  return { number: record['number'] as number, identifier: `${repo}#${record['number'] as number}`, url, title, state: state as 'OPEN' | 'CLOSED', labels, assignees, createdAt, updatedAt }
}

/** Open issues only; the caller may request one extra row to detect a bounded board truncation. */
export const githubOpenIssues = async (runner: CommandRunner, input: { readonly repo: string; readonly limit: number }, options: GitHubCliOptions = {}): Promise<readonly GitHubIssueSnapshot[]> => {
  const list = await ghJson(runner, ['issue', 'list', '--repo', input.repo, '--state', 'open', '--limit', String(input.limit), '--search', 'sort:updated-desc', '--json', ISSUE_FIELDS.join(',')], options)
  return (Array.isArray(list) ? list : []).map((issue) => parseGitHubIssue(issue, input.repo)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export interface GitHubIssueComment {
  readonly author: string | null
  readonly body: string
  readonly createdAt: string
}

export interface GitHubIssueDetail extends GitHubIssueSnapshot {
  readonly description: string
  readonly comments: readonly GitHubIssueComment[]
  readonly raw: unknown
}

const issueComments = (value: unknown): readonly GitHubIssueComment[] => Array.isArray(value) ? value.filter(isRecord).map((item) => {
  const author = isRecord(item['author']) ? str(item['author']['login']) : str(item['user'])
  return { author: author || null, body: str(item['body']), createdAt: str(item['createdAt']) }
}).filter((comment) => comment.body || comment.createdAt) : []

const issueNumber = (identifier: string): number => {
  const match = identifier.match(/(?:#|\/issues\/)(\d+)$/) ?? identifier.match(/^(\d+)$/)
  const number = match ? Number(match[1]) : Number.NaN
  if (!Number.isInteger(number) || number < 1) fail(`Invalid GitHub issue identifier "${identifier}".`, 'INVALID_INPUT')
  return number
}

export const githubIssueNumber = issueNumber

export const parseGitHubIssueDetail = (value: unknown, repo: string): GitHubIssueDetail => {
  const issue = parseGitHubIssue(value, repo)
  const record = isRecord(value) ? value : {}
  return { ...issue, description: str(record['body']), comments: issueComments(record['comments']), raw: value }
}

export const githubIssue = async (runner: CommandRunner, input: { readonly repo: string; readonly identifier: string }, options: GitHubCliOptions = {}): Promise<GitHubIssueDetail> =>
  parseGitHubIssueDetail(await ghJson(runner, ['issue', 'view', String(issueNumber(input.identifier)), '--repo', input.repo, '--json', ISSUE_DETAIL_FIELDS.join(',')], options), input.repo)

const ghRun = async (runner: CommandRunner, argv: readonly string[], options: GitHubCliOptions, timeoutMs = 30_000): Promise<string> => {
  const outcome = await runner.run([options.bin ?? 'gh', ...argv], { timeoutMs, ...(options.cwd ? { cwd: options.cwd } : {}) })
  if (outcome.timedOut) return fail(`${argv.slice(0, 2).join(' ')} timed out.`, 'HARNESS_ERROR')
  if (outcome.code !== 0) return fail(`${argv.slice(0, 2).join(' ')} exited ${outcome.code ?? 'null'}: ${outcome.stderr.trim().slice(0, 300)}`, 'HARNESS_ERROR')
  return outcome.stdout.trim()
}

export const githubIssueEditArgv = (input: { readonly identifier: string; readonly repo: string; readonly addLabels?: readonly string[]; readonly removeLabels?: readonly string[]; readonly addAssignees?: readonly string[]; readonly removeAssignees?: readonly string[] }, bin = 'gh'): readonly string[] => [bin, 'issue', 'edit', String(issueNumber(input.identifier)), '--repo', input.repo, ...(input.addLabels ?? []).flatMap((label) => ['--add-label', label]), ...(input.removeLabels ?? []).flatMap((label) => ['--remove-label', label]), ...(input.addAssignees ?? []).flatMap((assignee) => ['--add-assignee', assignee]), ...(input.removeAssignees ?? []).flatMap((assignee) => ['--remove-assignee', assignee])]

export const githubIssueEdit = async (runner: CommandRunner, input: Parameters<typeof githubIssueEditArgv>[0], options: GitHubCliOptions = {}): Promise<void> => {
  const args = githubIssueEditArgv(input, options.bin)
  if (args.length <= 6) return
  await ghRun(runner, args.slice(1), options)
}

export const githubIssueCommentArgv = (input: { readonly repo: string; readonly identifier: string; readonly body: string }, bin = 'gh'): readonly string[] => [bin, 'issue', 'comment', String(issueNumber(input.identifier)), '--repo', input.repo, '--body', input.body]

export const githubIssueComment = async (runner: CommandRunner, input: Parameters<typeof githubIssueCommentArgv>[0], options: GitHubCliOptions = {}): Promise<void> => { await ghRun(runner, githubIssueCommentArgv(input, options.bin).slice(1), options) }

export const githubIssueCommentExists = async (runner: CommandRunner, input: { readonly repo: string; readonly identifier: string; readonly marker: string }, options: GitHubCliOptions = {}): Promise<boolean> => {
  const list = await ghJson(runner, ['api', '--paginate', `repos/${input.repo}/issues/${issueNumber(input.identifier)}/comments`, '--jq', '[.[].body]'], options)
  return Array.isArray(list) && list.some((body) => typeof body === 'string' && body.includes(input.marker))
}

export const githubIssueClose = async (runner: CommandRunner, input: { readonly repo: string; readonly identifier: string }, options: GitHubCliOptions = {}): Promise<void> => { await ghRun(runner, ['issue', 'close', String(issueNumber(input.identifier)), '--repo', input.repo], options) }
export const githubIssueReopen = async (runner: CommandRunner, input: { readonly repo: string; readonly identifier: string }, options: GitHubCliOptions = {}): Promise<void> => { await ghRun(runner, ['issue', 'reopen', String(issueNumber(input.identifier)), '--repo', input.repo], options) }

export const githubIssueCreate = async (runner: CommandRunner, input: { readonly repo: string; readonly title: string; readonly body: string; readonly labels?: readonly string[]; readonly assignee?: string | null; readonly dedupeKey?: string }, options: GitHubCliOptions = {}): Promise<{ readonly identifier: string | null; readonly url: string | null }> => {
  if (input.dedupeKey) {
    const existing = await ghJson(runner, ['issue', 'list', '--repo', input.repo, '--state', 'all', '--limit', '20', '--search', input.dedupeKey, '--json', 'number,url'], options)
    const first = Array.isArray(existing) && isRecord(existing[0]) ? existing[0] : null
    if (first && typeof first['number'] === 'number') return { identifier: `${input.repo}#${first['number']}`, url: str(first['url']) || null }
  }
  const output = await ghRun(runner, ['issue', 'create', '--repo', input.repo, '--title', input.title, '--body', input.body, ...(input.labels ?? []).flatMap((label) => ['--label', label]), ...(input.assignee ? ['--assignee', input.assignee] : [])], options)
  const url = output.match(/https?:\/\/[^\s]+/)?.[0] ?? null
  const number = url ? url.match(/\/issues\/(\d+)(?:$|\s)/)?.[1] : null
  return { identifier: number ? `${input.repo}#${number}` : null, url }
}

export const githubCurrentUser = async (runner: CommandRunner, options: GitHubCliOptions = {}): Promise<string> => {
  const value = await ghJson(runner, ['api', 'user'], options)
  const login = isRecord(value) ? str(value['login']) : ''
  return login || fail('GitHub did not return the authenticated user login.', 'HARNESS_ERROR')
}

export const githubPreflight = async (runner: CommandRunner, input: { readonly repo: string; readonly labels?: readonly string[] }, options: GitHubCliOptions = {}): Promise<{ readonly login: string; readonly permission: string }> => {
  await ghRun(runner, ['auth', 'status'], options)
  const value = await ghJson(runner, ['repo', 'view', input.repo, '--json', 'nameWithOwner,viewerPermission'], options)
  const record = isRecord(value) ? value : {}
  const permission = str(record['viewerPermission']).toUpperCase()
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission)) fail(`GitHub user has "${permission || 'unknown'}" permission for ${input.repo}; write access is required.`, 'POLICY_BLOCKED')
  if (input.labels?.length) {
    const listed = await ghJson(runner, ['label', 'list', '--repo', input.repo, '--limit', '1000', '--json', 'name'], options)
    const available = new Set(Array.isArray(listed) ? listed.filter(isRecord).map((label) => str(label['name'])).filter(Boolean) : [])
    const missing = input.labels.filter((label) => !available.has(label))
    if (missing.length) fail(`GitHub lifecycle labels are missing in ${input.repo}: ${missing.join(', ')}.`, 'INVALID_CONFIG')
  }
  return { login: await githubCurrentUser(runner, options), permission }
}

export interface DiffStat { readonly files: readonly string[]; readonly changedLines: number }

/** Files and changed-line count between two commits — used to size a fix-round review off what actually changed
 * since the last reviewed head, instead of the whole PR's cumulative diff from its base. */
export const githubCompare = async (runner: CommandRunner, input: { readonly repo: string; readonly base: string; readonly head: string }, options: GitHubCliOptions = {}): Promise<DiffStat> => {
  const value = await ghJson(runner, ['api', `repos/${input.repo}/compare/${input.base}...${input.head}`], options)
  const files = isRecord(value) && Array.isArray(value['files']) ? value['files'].filter(isRecord) : []
  return {
    files: files.map((file) => str(file['filename'])).filter(Boolean),
    changedLines: files.reduce((total, file) => total + (typeof file['additions'] === 'number' ? file['additions'] : 0) + (typeof file['deletions'] === 'number' ? file['deletions'] : 0), 0),
  }
}

/** Remove a label from a PR (best-effort — `gh` succeeds even if the label was already gone). */
export const githubLabelRemove = async (runner: CommandRunner, input: { readonly repo: string; readonly number: number; readonly label: string }, options: GitHubCliOptions = {}): Promise<void> => {
  const argv = [options.bin ?? 'gh', 'pr', 'edit', String(input.number), '--repo', input.repo, '--remove-label', input.label]
  const outcome = await runner.run(argv, { timeoutMs: options.timeoutMs ?? 30_000, ...(options.cwd ? { cwd: options.cwd } : {}) })
  if (outcome.code !== 0) fail(`gh pr edit --remove-label exited ${outcome.code ?? 'null'}: ${outcome.stderr.trim().slice(0, 300)}`, 'HARNESS_ERROR')
}

/** Squash/merge via REST with optimistic concurrency on the reviewed head SHA; GitHub refuses when the head moved. */
export const githubMergeArgv = (input: { readonly repo: string; readonly number: number; readonly headSha: string; readonly method: 'squash' | 'merge' | 'rebase'; readonly title?: string }, bin = 'gh'): readonly string[] => [bin, 'api', '--method', 'PUT', `repos/${input.repo}/pulls/${input.number}/merge`, '-f', `merge_method=${input.method}`, '-f', `sha=${input.headSha}`, ...(input.title ? ['-f', `commit_title=${input.title}`] : [])]

export const githubMerge = async (runner: CommandRunner, input: Parameters<typeof githubMergeArgv>[0], options: GitHubCliOptions = {}): Promise<{ readonly merged: boolean; readonly sha: string | null; readonly message: string }> => {
  const argv = githubMergeArgv(input, options.bin)
  const outcome = await runner.run(argv, { timeoutMs: options.timeoutMs ?? 60_000, ...(options.cwd ? { cwd: options.cwd } : {}) })
  let body: unknown = null
  try { body = JSON.parse(outcome.stdout) } catch { body = null }
  const record = isRecord(body) ? body : {}
  if (outcome.code !== 0 || record['merged'] !== true) return { merged: false, sha: null, message: str(record['message'], outcome.stderr.trim() || `gh api exited ${outcome.code ?? 'null'}`) }
  return { merged: true, sha: str(record['sha']) || null, message: str(record['message'], 'merged') }
}

export const githubCommentArgv = (input: { readonly repo: string; readonly number: number; readonly body: string }, bin = 'gh'): readonly string[] => [bin, 'pr', 'comment', String(input.number), '--repo', input.repo, '--body', input.body]

export const githubComment = async (runner: CommandRunner, input: Parameters<typeof githubCommentArgv>[0], options: GitHubCliOptions = {}): Promise<void> => {
  const argv = githubCommentArgv(input, options.bin)
  const outcome = await runner.run(argv, { timeoutMs: options.timeoutMs ?? 30_000, ...(options.cwd ? { cwd: options.cwd } : {}) })
  if (outcome.code !== 0) fail(`gh pr comment exited ${outcome.code ?? 'null'}: ${outcome.stderr.trim().slice(0, 300)}`, 'HARNESS_ERROR')
}

/** Issue/PR comments whose body contains `marker` — used for one-comment-per-head dedupe. */
export const githubCommentExists = async (runner: CommandRunner, input: { readonly repo: string; readonly number: number; readonly marker: string }, options: GitHubCliOptions = {}): Promise<boolean> => {
  const list = await ghJson(runner, ['api', '--paginate', `repos/${input.repo}/issues/${input.number}/comments`, '--jq', '[.[].body]'], options)
  return Array.isArray(list) && list.some((body) => typeof body === 'string' && body.includes(input.marker))
}
