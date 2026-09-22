import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessRunner, excludeArtifactsFromGit } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('excludeArtifactsFromGit', () => {
  it('keeps .ak-loop/ out of a worker commit, in a linked worktree, once', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agentskit-exclude-')); dirs.push(repo)
    git(repo, 'init', '-q', '-b', 'main'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const worktree = join(repo, 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    const runner = createProcessRunner()
    expect(await excludeArtifactsFromGit(runner, worktree)).toBe(true)
    expect(await excludeArtifactsFromGit(runner, worktree)).toBe(true)
    // One shared file for every worktree, one line however many dispatches.
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line === '/.ak-loop/')).toHaveLength(1)
    mkdirSync(join(worktree, '.ak-loop')); writeFileSync(join(worktree, '.ak-loop', 'verify.json'), '{}'); writeFileSync(join(worktree, 'real.ts'), 'x')
    git(worktree, 'add', '-A')
    expect(git(worktree, 'diff', '--cached', '--name-only').trim().split('\n')).toEqual(['real.ts'])
  })
})
