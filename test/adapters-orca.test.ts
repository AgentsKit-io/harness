import { describe, expect, it } from 'vitest'
import { createOrcaDispatchPlan, createOrcaLifecycleProjection } from '../src/index.js'
import type { OrcaDispatchInput } from '../src/index.js'

const base: OrcaDispatchInput = { repository: 'org/repo', worktree: 'eng-1', branch: 'codex/eng-1', baseBranch: 'main', goalFile: 'GOAL.md' }

describe('createOrcaDispatchPlan', () => {
  it('builds an argv with a prompt file, the default agent, and a JSON output flag', () => {
    const plan = createOrcaDispatchPlan(base)
    expect(plan.argv).toEqual(['orca', 'worktree', 'create', '--repo', 'org/repo', '--name', 'eng-1', '--base-branch', 'main', '--agent', 'default', '--prompt-file', 'GOAL.md', '--json'])
    expect(plan.commandDigest).toHaveLength(64)
    expect(plan.idempotencyKey).toHaveLength(64)
  })

  it('builds an argv with an inline prompt instead of a prompt file', () => {
    const plan = createOrcaDispatchPlan({ repository: 'org/repo', worktree: 'eng-1', branch: 'b', baseBranch: 'main', prompt: 'do the thing' })
    expect(plan.argv).toContain('--prompt')
    expect(plan.argv).not.toContain('--prompt-file')
  })

  it('includes linearIssue, comment, custom orcaBin, and --no-parent when provided', () => {
    const plan = createOrcaDispatchPlan({ ...base, linearIssue: 'ENG-1', comment: 'note', orcaBin: '/usr/local/bin/orca', noParent: true })
    expect(plan.argv[0]).toBe('/usr/local/bin/orca')
    expect(plan.argv).toEqual(expect.arrayContaining(['--linear-issue', 'ENG-1', '--comment', 'note', '--no-parent']))
  })

  it('builds a worktree-only plan with no agent and no prompt flags', () => {
    const plan = createOrcaDispatchPlan({ repository: 'org/repo', worktree: 'eng-1', branch: 'b', baseBranch: 'main', launch: 'worktree-only' })
    expect(plan.argv).not.toContain('--agent')
    expect(plan.argv).not.toContain('--prompt-file')
    expect(plan.argv).not.toContain('--prompt')
  })

  it('rejects a blank repository/worktree/branch/baseBranch', () => {
    expect(() => createOrcaDispatchPlan({ ...base, repository: '' })).toThrow(/repository is required/)
    expect(() => createOrcaDispatchPlan({ ...base, worktree: '' })).toThrow(/worktree is required/)
    expect(() => createOrcaDispatchPlan({ ...base, branch: '' })).toThrow(/branch is required/)
    expect(() => createOrcaDispatchPlan({ ...base, baseBranch: '' })).toThrow(/baseBranch is required/)
  })

  it('rejects a worktree-only plan that also specifies a goalFile or prompt', () => {
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'm', launch: 'worktree-only', goalFile: 'GOAL.md' })).toThrow(/takes no goalFile or prompt/)
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'm', launch: 'worktree-only', prompt: 'x' })).toThrow(/takes no goalFile or prompt/)
  })

  it('rejects specifying both goalFile and prompt, or neither, for an agent launch', () => {
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'm', goalFile: 'GOAL.md', prompt: 'x' })).toThrow(/Exactly one of goalFile or prompt/)
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'm' })).toThrow(/Exactly one of goalFile or prompt/)
  })

  it('rejects a blank goalFile, prompt, linearIssue, comment, or agent when explicitly provided', () => {
    expect(() => createOrcaDispatchPlan({ ...base, goalFile: '  ' })).toThrow(/goalFile is required/)
    expect(() => createOrcaDispatchPlan({ repository: 'r', worktree: 'w', branch: 'b', baseBranch: 'm', prompt: '  ' })).toThrow(/prompt is required/)
    expect(() => createOrcaDispatchPlan({ ...base, linearIssue: '  ' })).toThrow(/linearIssue is required/)
    expect(() => createOrcaDispatchPlan({ ...base, comment: '  ' })).toThrow(/comment is required/)
    expect(() => createOrcaDispatchPlan({ ...base, agent: '  ' })).toThrow(/agent is required/)
  })
})

describe('createOrcaLifecycleProjection', () => {
  it('rejects a blank issueRef/repository/worktree/branch', () => {
    const good = { issueRef: 'ENG-1', repository: 'org/repo', worktree: 'w', branch: 'b', leaseState: 'acquired' as const, issueLock: 'held' as const }
    expect(() => createOrcaLifecycleProjection({ ...good, issueRef: '' })).toThrow(/issueRef is required/)
    expect(() => createOrcaLifecycleProjection({ ...good, repository: '' })).toThrow(/repository is required/)
    expect(() => createOrcaLifecycleProjection({ ...good, worktree: '' })).toThrow(/worktree is required/)
    expect(() => createOrcaLifecycleProjection({ ...good, branch: '' })).toThrow(/branch is required/)
  })

  it('rejects an invalid leaseState or issueLock', () => {
    const good = { issueRef: 'ENG-1', repository: 'org/repo', worktree: 'w', branch: 'b', leaseState: 'acquired' as const, issueLock: 'held' as const }
    expect(() => createOrcaLifecycleProjection({ ...good, leaseState: 'unknown' as never })).toThrow(/leaseState is invalid/)
    expect(() => createOrcaLifecycleProjection({ ...good, issueLock: 'unknown' as never })).toThrow(/issueLock is invalid/)
  })
})
