import { describe, expect, it } from 'vitest'
import { githubComment, githubCommentExists, githubCompare, githubIssueCommentExists, githubIssueCreate, githubLabelRemove, githubOpenPullRequests, githubPullRequest, parsePullRequest, touchesProtectedPaths } from '../src/index.js'
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

describe('githubCompare', () => {
  it('calls gh api compare and sums additions/deletions per file', async () => {
    const runner = recorder(() => ok({ files: [{ filename: 'a.ts', additions: 3, deletions: 1 }, { filename: 'b.md', additions: 5, deletions: 0 }] }))
    const diff = await githubCompare(runner, { repo: 'o/r', base: 'sha1', head: 'sha2' })
    expect(runner.calls[0]).toEqual(['gh', 'api', 'repos/o/r/compare/sha1...sha2'])
    expect(diff).toEqual({ files: ['a.ts', 'b.md'], changedLines: 9 })
  })

  it('tolerates a response with no files array', async () => {
    const runner = recorder(() => ok({}))
    expect(await githubCompare(runner, { repo: 'o/r', base: 'sha1', head: 'sha2' })).toEqual({ files: [], changedLines: 0 })
  })
})

describe('paginated comment listings (regression: gh applies --jq per page)', () => {
  // Real `gh api --paginate` output for 31+ comments: the filter's output for page 1, then page 2, concatenated.
  const pages = (filter: string, first: readonly string[], second: readonly string[]): string =>
    filter === '[.[].body]' ? `${JSON.stringify(first)}\n${JSON.stringify(second)}\n` : [...first, ...second].map((body) => JSON.stringify(body)).join('\n') + '\n'
  const paged = (first: readonly string[], second: readonly string[]) => recorder((argv) => ({ code: 0, stdout: pages(argv[argv.indexOf('--jq') + 1] ?? '', first, second), stderr: '', timedOut: false, durationMs: 1 }))
  const page1 = Array.from({ length: 30 }, (_, index) => `comment ${index}`)

  it('githubCommentExists finds a marker on the second page instead of throwing "did not return JSON"', async () => {
    expect(await githubCommentExists(paged(page1, ['has <!-- loop:ENG-1 --> "quoted"\nmultiline']), { repo: 'o/r', number: 1, marker: '<!-- loop:ENG-1 -->' })).toBe(true)
    expect(await githubCommentExists(paged(page1, ['other']), { repo: 'o/r', number: 1, marker: '<!-- loop:ENG-1 -->' })).toBe(false)
  })

  it('githubIssueCommentExists finds a marker on the second page instead of throwing "did not return JSON"', async () => {
    expect(await githubIssueCommentExists(paged(page1, ['<!-- harness:k -->']), { repo: 'o/r', identifier: 'o/r#7', marker: '<!-- harness:k -->' })).toBe(true)
  })

  it('still fails closed when gh exits non-zero', async () => {
    const failing = recorder(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }))
    await expect(githubIssueCommentExists(failing, { repo: 'o/r', identifier: 'o/r#7', marker: 'x' })).rejects.toThrow(/boom/)
  })
})

describe('githubIssueCreate dedupe (regression: fuzzy search hit treated as duplicate)', () => {
  const tracker = (hits: readonly unknown[]) => recorder((argv) => argv[2] === 'list' ? ok(hits) : { code: 0, stdout: 'https://github.com/o/r/issues/99\n', stderr: '', timedOut: false, durationMs: 1 })
  const input = { repo: 'o/r', title: 'Plan', body: 'x\n\n<!-- harness:plan-ENG-1 -->', dedupeKey: 'plan-ENG-1' }

  it('creates the issue when the search hit does not carry the marker', async () => {
    const runner = tracker([{ number: 5, url: 'https://github.com/o/r/issues/5', body: 'unrelated issue mentioning plan ENG 1' }])
    expect(await githubIssueCreate(runner, input)).toEqual({ identifier: 'o/r#99', url: 'https://github.com/o/r/issues/99' })
    expect(runner.calls.some((argv) => argv[2] === 'create')).toBe(true)
  })

  it('dedupes onto the hit whose body carries the marker', async () => {
    const runner = tracker([{ number: 5, url: 'u5', body: 'unrelated' }, { number: 6, url: 'u6', body: 'x\n\n<!-- harness:plan-ENG-1 -->' }])
    expect(await githubIssueCreate(runner, input)).toEqual({ identifier: 'o/r#6', url: 'u6' })
    expect(runner.calls.some((argv) => argv[2] === 'create')).toBe(false)
  })
})
