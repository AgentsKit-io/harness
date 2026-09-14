import { describe, expect, it } from 'vitest'
import { githubComment, githubCommentExists, githubLabelRemove, githubOpenPullRequests, githubPullRequest, parsePullRequest, touchesProtectedPaths } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const recorder = (respond: (argv: readonly string[]) => CommandResult): CommandRunner & { readonly calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (argv) => { calls.push([...argv]); return respond(argv) } }
}
const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })

describe('parsePullRequest: defaults for missing/unusual fields', () => {
  it('defaults author to null, state/mergeable to UNKNOWN, and empty arrays when absent', () => {
    const snapshot = parsePullRequest({ number: 1 })
    expect(snapshot).toMatchObject({ author: null, authorIsBot: false, state: 'UNKNOWN', mergeable: 'UNKNOWN', labels: [], files: [], checks: [], updatedAt: null })
  })

  it('reads plain string labels/files as well as object-shaped ones, dropping blanks', () => {
    const snapshot = parsePullRequest({ number: 1, labels: ['a', { name: 'b' }, { name: '' }], files: ['x.ts', { path: 'y.ts' }, {}] })
    expect(snapshot.labels).toEqual(['a', 'b'])
    expect(snapshot.files).toEqual(['x.ts', 'y.ts'])
  })

  it('classifies a neutral check outcome and a status-only (non-rollup) pending shape', () => {
    const snapshot = parsePullRequest({ number: 1, statusCheckRollup: [{ __typename: 'CheckRun', name: 'a', conclusion: 'NEUTRAL' }, { __typename: 'StatusContext', context: 'b', state: 'PENDING' }, { __typename: 'StatusContext', context: 'c', status: 'IN_PROGRESS' }] })
    expect(snapshot.checks.map((c) => c.outcome)).toEqual(['neutral', 'pending', 'pending'])
    expect(snapshot.checks.map((c) => c.kind)).toEqual(['check-run', 'status', 'status'])
  })

  it('falls back to "unnamed" when a check has neither name nor context', () => {
    const snapshot = parsePullRequest({ number: 1, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })
    expect(snapshot.checks[0]).toMatchObject({ name: 'unnamed', kind: 'unknown' })
  })

  it('classifies a check with no conclusion and no status at all as unknown', () => {
    const snapshot = parsePullRequest({ number: 1, statusCheckRollup: [{ name: 'weird' }] })
    expect(snapshot.checks[0]?.outcome).toBe('unknown')
  })
})

describe('touchesProtectedPaths: ** glob prefix', () => {
  it('matches a leading "**/*.md" pattern at any depth including the root', () => {
    expect(touchesProtectedPaths(['README.md', 'docs/nested/deep.md', 'src/index.ts'], ['**/*.md'])).toEqual(['README.md', 'docs/nested/deep.md'])
  })
})

describe('ghJson: timeout classification', () => {
  it('fails closed with a timeout-specific message', async () => {
    const runner: CommandRunner = { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, durationMs: 1 }) }
    await expect(githubPullRequest(runner, { repo: 'o/r', number: 1 })).rejects.toThrow(/timed out/)
  })
})

describe('githubOpenPullRequests', () => {
  it('lists open PRs with a default limit, and an optional label filter', async () => {
    const runner = recorder(() => ok([{ number: 1 }, { number: 2 }]))
    const results = await githubOpenPullRequests(runner, { repo: 'o/r' })
    expect(results).toHaveLength(2)
    expect(runner.calls[0]).toEqual(expect.arrayContaining(['--limit', '50']))
    expect(runner.calls[0]).not.toContain('--label')
    await githubOpenPullRequests(runner, { repo: 'o/r', limit: 10, label: 'ready' })
    expect(runner.calls[1]).toEqual(expect.arrayContaining(['--limit', '10', '--label', 'ready']))
  })

  it('tolerates a non-array list result', async () => {
    const runner = recorder(() => ok({ not: 'an array' }))
    expect(await githubOpenPullRequests(runner, { repo: 'o/r' })).toEqual([])
  })
})

describe('githubLabelRemove', () => {
  it('builds the edit --remove-label argv and succeeds on exit 0', async () => {
    const runner = recorder(() => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }))
    await githubLabelRemove(runner, { repo: 'o/r', number: 5, label: 'blocked' })
    expect(runner.calls[0]).toEqual(['gh', 'pr', 'edit', '5', '--repo', 'o/r', '--remove-label', 'blocked'])
  })

  it('fails closed on a non-zero exit', async () => {
    const runner: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'not found', timedOut: false, durationMs: 1 }) }
    await expect(githubLabelRemove(runner, { repo: 'o/r', number: 5, label: 'blocked' })).rejects.toThrow(/not found/)
  })
})

describe('githubComment', () => {
  it('succeeds on exit 0 and fails closed on a non-zero exit', async () => {
    const runner = recorder(() => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }))
    await githubComment(runner, { repo: 'o/r', number: 5, body: 'hi' })
    expect(runner.calls[0]).toEqual(['gh', 'pr', 'comment', '5', '--repo', 'o/r', '--body', 'hi'])
    const failing: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }) }
    await expect(githubComment(failing, { repo: 'o/r', number: 5, body: 'hi' })).rejects.toThrow(/boom/)
  })
})

describe('githubCommentExists', () => {
  it('returns true when a comment body contains the marker, false otherwise', async () => {
    const withMarker = recorder(() => ok(['unrelated', 'contains loop:ENG-1 marker']))
    expect(await githubCommentExists(withMarker, { repo: 'o/r', number: 1, marker: 'loop:ENG-1' })).toBe(true)
    const withoutMarker = recorder(() => ok(['unrelated']))
    expect(await githubCommentExists(withoutMarker, { repo: 'o/r', number: 1, marker: 'loop:ENG-1' })).toBe(false)
  })

  it('tolerates a non-array response', async () => {
    const runner = recorder(() => ok('not an array'))
    expect(await githubCommentExists(runner, { repo: 'o/r', number: 1, marker: 'x' })).toBe(false)
  })
})
