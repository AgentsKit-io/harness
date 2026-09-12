import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverIntake, intakeIssueId, intakePath, listIntake, readIntake } from '../src/index.js'
import type { CommandResult, CommandRunner } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-github-intake-')); cleanups.push(dir); return dir }

const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '', timedOut: false, durationMs: 1 })
const pr = (number: number, headRef: string): Record<string, unknown> => ({ number, url: `https://github.com/o/r/pull/${number}`, title: 't', state: 'OPEN', isDraft: false, author: { login: 'someone' }, headRefName: headRef, headRefOid: 'sha', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', labels: [{ name: 'loop:review' }], files: [], statusCheckRollup: [], updatedAt: null })

describe('intakeIssueId / intakePath', () => {
  it('derives a stable pr-<n> identifier and path', () => {
    expect(intakeIssueId(77)).toBe('pr-77')
    expect(intakePath('/state', 77)).toBe(join('/state', 'issues', 'pr-77', 'intake.json'))
  })
})

describe('readIntake / listIntake', () => {
  it('returns null/empty when nothing is tracked yet', () => {
    const stateDir = tempStateDir()
    expect(readIntake(stateDir, 1)).toBeNull()
    expect(listIntake(stateDir)).toEqual([])
  })
})

describe('discoverIntake', () => {
  it('lists open PRs with the label and starts tracking each one exactly once', async () => {
    const stateDir = tempStateDir()
    const calls: string[][] = []
    const runner: CommandRunner = { run: async (argv) => { calls.push([...argv]); return ok([pr(1, 'a'), pr(2, 'b')]) } }
    const now = () => new Date('2026-09-12T10:00:00.000Z')
    const added = await discoverIntake(runner, { repo: 'o/r', label: 'loop:review', stateDir, now })
    expect(added).toEqual([
      { pr: 1, headRef: 'a', source: 'github-label', addedAt: '2026-09-12T10:00:00.000Z' },
      { pr: 2, headRef: 'b', source: 'github-label', addedAt: '2026-09-12T10:00:00.000Z' },
    ])
    expect(calls[0]).toEqual(expect.arrayContaining(['gh', 'pr', 'list', '--repo', 'o/r', '--state', 'open', '--limit', '100', '--label', 'loop:review']))
    expect(existsSync(intakePath(stateDir, 1))).toBe(true)
    expect(readIntake(stateDir, 2)).toMatchObject({ pr: 2, headRef: 'b' })
    expect(listIntake(stateDir).map((record) => record.pr).sort()).toEqual([1, 2])

    // Second discovery with the same PRs (plus a new one) does not re-touch already-tracked records or duplicate them.
    const secondAdded = await discoverIntake(runner, { repo: 'o/r', label: 'loop:review', stateDir, now: () => new Date('2026-09-13T00:00:00.000Z') })
    expect(secondAdded).toEqual([])
    expect(listIntake(stateDir)).toHaveLength(2)
  })

  it('discovers nothing when the label search returns no PRs', async () => {
    const stateDir = tempStateDir()
    const runner: CommandRunner = { run: async () => ok([]) }
    const added = await discoverIntake(runner, { repo: 'o/r', label: 'loop:review', stateDir, now: () => new Date() })
    expect(added).toEqual([])
    expect(listIntake(stateDir)).toEqual([])
  })
})
