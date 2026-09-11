import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assessChecks, createLinearTrackingAdapter, createOrcaDispatchPlan, githubCommentArgv, githubMerge, githubMergeArgv, githubPullRequest, githubPullRequestsForBranch, linearAttachArgv, linearCommentAddArgv, linearLabelArgv, linearStatusSetArgv,
  orcaAutomationCreateArgv, orcaAutomationEditArgv, orcaTerminalSend, orcaWorktreeCreate, orcaWorktreeSetArgv, parseLinearIssueDetail, parseOrcaAutomations, parseOrcaSendReceipt, parseOrcaTerminals, parseOrcaWorktreeCreate, parsePullRequest, touchesProtectedPaths, writeIdFor,
} from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/loop', `${name}.json`), 'utf8')) as unknown
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const recorder = (respond: (argv: readonly string[]) => CommandResult): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return respond(argv) } }
}

describe('orca dispatch plan', () => {
  it('renders linear-issue, inline prompt, comment and no-parent as discrete argv and keeps the identity stable', () => {
    const plan = createOrcaDispatchPlan({ repository: 'path:/repo', worktree: 'eng-1-demo', branch: 'person/eng-1-demo', baseBranch: 'main', agent: 'codex', prompt: 'Implement ENG-1; run tests', linearIssue: 'ENG-1', comment: 'loop: ENG-1', noParent: true })
    expect(plan.argv).toEqual(['orca', 'worktree', 'create', '--repo', 'path:/repo', '--name', 'eng-1-demo', '--base-branch', 'main', '--agent', 'codex', '--prompt', 'Implement ENG-1; run tests', '--linear-issue', 'ENG-1', '--comment', 'loop: ENG-1', '--no-parent', '--json'])
    const again = createOrcaDispatchPlan({ repository: 'path:/repo', worktree: 'eng-1-demo', branch: 'person/eng-1-demo', baseBranch: 'main', agent: 'codex', prompt: 'Implement ENG-1; run tests', linearIssue: 'ENG-1', comment: 'different comment', noParent: true })
    expect(again.idempotencyKey).toBe(plan.idempotencyKey)
    expect(again.commandDigest).not.toBe(plan.commandDigest)
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'main' })).toThrow(/Exactly one of goalFile or prompt/)
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'main', goalFile: 'GOAL.md', prompt: 'x' })).toThrow(/Exactly one/)
    expect(() => createOrcaDispatchPlan({ repository: 'r; rm -rf /', worktree: 'w', branch: 'b', baseBranch: 'main', prompt: 'x' })).toThrow(/shell metacharacters/)
    const bare = createOrcaDispatchPlan({ repository: 'path:/repo', worktree: 'w', branch: 'b', baseBranch: 'main', launch: 'worktree-only', linearIssue: 'ENG-1' })
    expect(bare.argv).toEqual(['orca', 'worktree', 'create', '--repo', 'path:/repo', '--name', 'w', '--base-branch', 'main', '--linear-issue', 'ENG-1', '--json'])
    expect(() => createOrcaDispatchPlan({ repository: 'path:/repo', worktree: 'w', branch: 'b', baseBranch: 'main', launch: 'worktree-only', prompt: 'x' })).toThrow(/worktree-only/)
  })

  it('parses worktree create results across runtime shapes and executes the plan argv', async () => {
    expect(parseOrcaWorktreeCreate({ worktreeId: 'repo-1::/w/eng-1', path: '/w/eng-1', branch: 'refs/heads/person/eng-1', agentTerminalHandle: 'term_1' })).toMatchObject({ id: 'repo-1::/w/eng-1', branch: 'person/eng-1', agentTerminalHandle: 'term_1' })
    expect(parseOrcaWorktreeCreate({ worktree: { id: 'repo-1::/w/eng-2', branch: 'x' }, startupTerminal: { handle: 'term_2' } })).toMatchObject({ id: 'repo-1::/w/eng-2', path: '/w/eng-2', agentTerminalHandle: 'term_2' })
    expect(() => parseOrcaWorktreeCreate({})).toThrow(/no worktree id/)
    const runner = recorder(() => ok({ ok: true, result: { worktreeId: 'repo-1::/w/eng-1', agentTerminalHandle: 'term_1' } }))
    const plan = createOrcaDispatchPlan({ repository: 'path:/repo', worktree: 'eng-1', branch: 'b', baseBranch: 'main', agent: 'claude', prompt: 'go', linearIssue: 'ENG-1' })
    const created = await orcaWorktreeCreate(runner, plan.argv)
    expect(created.agentTerminalHandle).toBe('term_1')
    expect(runner.calls[0]).toEqual(plan.argv)
  })

  it('builds worktree set argv, parses terminals and send receipts', async () => {
    expect(orcaWorktreeSetArgv({ worktree: 'id:repo-1::/w', comment: 'stuck', workspaceStatus: 'in-review', linearIssue: null })).toEqual(['orca', 'worktree', 'set', '--worktree', 'id:repo-1::/w', '--comment', 'stuck', '--workspace-status', 'in-review', '--linear-issue', 'null', '--json'])
    const terminals = parseOrcaTerminals({ terminals: [{ handle: 'term_a', title: 'codex', worktreeId: 'repo-1::/w', branch: 'refs/heads/x', connected: true, orphaned: false, lastOutputAt: 5, preview: '❯ ' }, { handle: 'term_b', orphaned: true }, { nope: true }] })
    expect(terminals).toHaveLength(2)
    expect(terminals[0]).toMatchObject({ handle: 'term_a', status: 'connected', branch: 'x', preview: '❯ ' })
    expect(terminals[1]).toMatchObject({ status: 'orphaned' })
    expect(parseOrcaSendReceipt({ receipt: { accepted: true, requestId: 'req-1', stages: ['input_accepted', 'turn_started'] }, warnings: [] })).toMatchObject({ accepted: true, requestId: 'req-1' })
    expect(parseOrcaSendReceipt({ stages: [{ stage: 'input_accepted' }] }).accepted).toBe(true)
    expect(parseOrcaSendReceipt({}).accepted).toBe(true)
    expect(parseOrcaSendReceipt(null).accepted).toBe(true)
    expect(parseOrcaSendReceipt({ accepted: false }).accepted).toBe(false)
    const runner = recorder(() => ok({ ok: true, result: { accepted: true, requestId: 'r' } }))
    await orcaTerminalSend(runner, { terminal: 'term_a', text: 'continue', waitSubmitSeconds: 5 })
    expect(runner.calls[0]).toEqual(['orca', 'terminal', 'send', '--terminal', 'term_a', '--text', 'continue', '--enter', '--wait-submit', '5', '--json'])
  })

  it('builds idempotent automation create/edit argv and parses listings', () => {
    const spec = { name: 'loop-tick', trigger: '*/5 * * * *', prompt: 'run tick', provider: 'claude', precheck: 'ak-harness loop precheck tick', precheckTimeoutSec: 120, workspace: 'path:/repo', reuseSession: true }
    expect(orcaAutomationCreateArgv(spec)).toEqual(['orca', 'automations', 'create', '--name', 'loop-tick', '--trigger', '*/5 * * * *', '--prompt', 'run tick', '--provider', 'claude', '--precheck', 'ak-harness loop precheck tick', '--precheck-timeout', '120', '--workspace', 'path:/repo', '--workspace-mode', 'existing', '--reuse-session', '--enabled', '--json'])
    expect(orcaAutomationEditArgv('auto-1', { ...spec, workspace: undefined, repo: 'id:repo-1', enabled: false }).slice(0, 4)).toEqual(['orca', 'automations', 'edit', 'auto-1'])
    expect(orcaAutomationEditArgv('auto-1', { ...spec, workspace: undefined, repo: 'id:repo-1', enabled: false })).toContain('--disabled')
    expect(parseOrcaAutomations({ automations: [{ id: 'a1', name: 'loop-tick', enabled: true, trigger: '*/5 * * * *', provider: 'claude' }], items: [] })).toEqual([expect.objectContaining({ id: 'a1', name: 'loop-tick', enabled: true })])
  })
})

describe('linear writes', () => {
  it('builds status/comment/label/attach argv with workspace scoping and deterministic write ids', () => {
    expect(linearStatusSetArgv({ issue: 'ENG-1', to: 'In Progress', workspaceId: 'ws' })).toEqual(['orca', 'linear', 'status', 'set', 'ENG-1', '--to', 'In Progress', '--workspace', 'ws', '--json'])
    expect(linearCommentAddArgv({ issue: 'ENG-1', body: 'hello', workspaceId: 'ws', writeId: writeIdFor('k') })).toContain('--write-id')
    expect(linearLabelArgv({ issue: 'ENG-1', labels: ['blocked', 'needs-info'], workspaceId: 'ws', action: 'add' })).toEqual(['orca', 'linear', 'label', 'add', 'ENG-1', '--label', 'blocked', '--label', 'needs-info', '--workspace', 'ws', '--json'])
    expect(linearAttachArgv({ issue: 'ENG-1', url: 'https://github.com/o/r/pull/1', title: 'PR', workspaceId: 'ws' })).toContain('--title')
    expect(writeIdFor('same')).toBe(writeIdFor('same'))
    expect(writeIdFor('same')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(writeIdFor('other')).not.toBe(writeIdFor('same'))
  })

  it('parses issue detail with comments and drives a deduped tracking adapter', async () => {
    const todo = (fixture('list-issues-todo') as { readonly result: { readonly issues: unknown[] } }).result.issues[0]
    const detail = parseLinearIssueDetail({ issue: todo, comments: [{ user: { displayName: 'person' }, body: 'note', createdAt: '2026-01-01T00:00:00.000Z' }] })
    expect(detail).toMatchObject({ identifier: 'ENG-10', description: 'redacted' })
    expect(detail.comments[0]).toMatchObject({ author: 'person', body: 'note' })
    const runner = recorder(() => ok({ ok: true, result: {} }))
    const adapter = createLinearTrackingAdapter(runner, { workspaceId: 'ws' })
    await adapter.transition({ tracker: 'linear', issue: 'ENG-10', to: 'In Progress', reason: 'dispatched' })
    await adapter.transition({ tracker: 'linear', issue: 'ENG-10', to: 'In Progress', reason: 'dispatched' })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]).toEqual(['orca', 'linear', 'status', 'set', 'ENG-10', '--to', 'In Progress', '--workspace', 'ws', '--json'])
    const dry = createLinearTrackingAdapter(recorder(() => ok({ ok: true, result: {} })), { workspaceId: 'ws', dryRun: true })
    await dry.transition({ tracker: 'linear', issue: 'ENG-11', to: 'Done', reason: 'merged' })
    expect(dry.telemetry?.()).toMatchObject({ externalMutations: 0 })
  })
})

describe('github cli', () => {
  const pr = fixture('gh-pr-view')

  it('parses pr view output, classifies checks, and protects self-edit paths', () => {
    const snapshot = parsePullRequest(pr)
    expect(snapshot).toMatchObject({ number: 6111, state: 'OPEN', isDraft: false, author: 'person', mergeable: 'MERGEABLE', mergeState: 'CLEAN', headRef: 'person/eng-1-demo' })
    expect(snapshot.checks.map((check) => check.outcome)).toEqual(['skipped', 'success', 'success', 'pending', 'failure'])
    expect(assessChecks(snapshot.checks)).toMatchObject({ status: 'red', failing: ['Lint'], pending: ['Vercel – app'] })
    expect(assessChecks(snapshot.checks, [], ['Lint'])).toMatchObject({ status: 'pending' })
    expect(assessChecks(snapshot.checks.filter((check) => check.outcome !== 'failure' && check.outcome !== 'pending'), ['ci / test'])).toMatchObject({ status: 'missing', missingRequired: ['ci / test'] })
    expect(assessChecks(snapshot.checks.filter((check) => check.outcome === 'success' || check.outcome === 'skipped'))).toMatchObject({ status: 'green' })
    expect(assessChecks([])).toMatchObject({ status: 'green' })
    expect(touchesProtectedPaths(snapshot.files, ['loop.config.yaml', '.github/**', 'CODEOWNERS'])).toEqual(['.github/workflows/ci.yml'])
    expect(touchesProtectedPaths(['packages/a/src/x.ts'], ['.github/**'])).toEqual([])
    expect(touchesProtectedPaths(['docs/x.md', 'docs/nested/y.md'], ['docs/*.md'])).toEqual(['docs/x.md'])
    expect(() => parsePullRequest({})).toThrow(/numeric number/)
  })

  it('fetches PRs with fixed json fields and merges with optimistic sha', async () => {
    const runner = recorder((argv) => argv.includes('view') ? ok(pr) : argv.includes('list') ? ok([pr]) : argv.includes('api') ? ok({ merged: true, sha: 'abc123', message: 'Pull Request successfully merged' }) : ok({}))
    const snapshot = await githubPullRequest(runner, { repo: 'o/r', number: 6111 })
    expect(snapshot.number).toBe(6111)
    expect(runner.calls[0]?.slice(0, 5)).toEqual(['gh', 'pr', 'view', '6111', '--repo'])
    expect(runner.calls[0]?.[runner.calls[0].length - 1]).toContain('statusCheckRollup')
    const byBranch = await githubPullRequestsForBranch(runner, { repo: 'o/r', head: 'person/eng-1-demo' })
    expect(byBranch).toHaveLength(1)
    expect(await githubPullRequestsForBranch(runner, { repo: 'o/r', head: 'other' })).toHaveLength(0)
    expect(githubMergeArgv({ repo: 'o/r', number: 1, headSha: 'abc', method: 'squash', title: 'feat: x (#1)' })).toEqual(['gh', 'api', '--method', 'PUT', 'repos/o/r/pulls/1/merge', '-f', 'merge_method=squash', '-f', 'sha=abc', '-f', 'commit_title=feat: x (#1)'])
    expect(await githubMerge(runner, { repo: 'o/r', number: 1, headSha: 'abc', method: 'squash' })).toMatchObject({ merged: true, sha: 'abc123' })
    const refused = recorder(() => ({ code: 1, stdout: JSON.stringify({ message: 'Head branch was modified. Review and try the merge again.' }), stderr: '', timedOut: false, durationMs: 1 }))
    expect(await githubMerge(refused, { repo: 'o/r', number: 1, headSha: 'abc', method: 'squash' })).toMatchObject({ merged: false, message: expect.stringContaining('Head branch was modified') })
    expect(githubCommentArgv({ repo: 'o/r', number: 1, body: 'hi' })).toEqual(['gh', 'pr', 'comment', '1', '--repo', 'o/r', '--body', 'hi'])
    const failing = recorder(() => ({ code: 1, stdout: '', stderr: 'gh: not logged in', timedOut: false, durationMs: 1 }))
    await expect(githubPullRequest(failing, { repo: 'o/r', number: 1 })).rejects.toThrow(/not logged in/)
  })
})
