import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceSnapshot, statusLineIsPath } from '../src/execution/source.js'

const git = (root: string, args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' }) }
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-source-'))
  git(root, ['init', '-q']); git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['config', 'user.name', 'Harness test'])
  writeFileSync(join(root, 'tracked.txt'), 'one\n'); git(root, ['add', 'tracked.txt']); git(root, ['commit', '-qm', 'initial'])
  return root
}

it('changes the Git evidence fingerprint for committed, dirty, and untracked content while excluding task state', async () => {
  const root = repository(); const stateDir = join(root, '.ak-harness', 'verification'); mkdirSync(stateDir, { recursive: true })
  const initial = await sourceSnapshot(root, stateDir)
  writeFileSync(join(root, 'tracked.txt'), 'two\n'); const dirty = await sourceSnapshot(root, stateDir)
  writeFileSync(join(root, 'untracked.txt'), 'three\n'); const untracked = await sourceSnapshot(root, stateDir)
  writeFileSync(join(stateDir, 'run.json'), 'state\n'); const stateOnly = await sourceSnapshot(root, stateDir)
  git(root, ['add', 'tracked.txt', 'untracked.txt']); git(root, ['commit', '-qm', 'changed'])
  const committed = await sourceSnapshot(root, stateDir)
  expect(dirty.statusHash).not.toBe(initial.statusHash)
  expect(untracked.statusHash).not.toBe(dirty.statusHash)
  expect(stateOnly.statusHash).toBe(untracked.statusHash)
  expect(committed.revision).not.toBe(initial.revision)
})

it('blocks current-source evidence outside a committed Git repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-source-non-git-test-'))
  await expect(sourceSnapshot(root, join(root, '.ak-harness', 'verification'))).rejects.toMatchObject({ code: 'GIT_REQUIRED' })
})

it('matches a git status line against a path written with either separator', () => {
  // Git always prints forward slashes; `path.relative()` returns the platform's separator. Comparing the two
  // without normalising made the harness's own config file look like a dirty worktree on Windows, so every
  // `plan` was refused there — on POSIX the same code passed, which is why it went unnoticed.
  expect(statusLineIsPath('?? .ak-harness/verification.json', '.ak-harness\\verification.json')).toBe(true)
  expect(statusLineIsPath('?? .ak-harness/verification.json', '.ak-harness/verification.json')).toBe(true)
  expect(statusLineIsPath(' M .ak-harness/verification.json', '.ak-harness\\verification.json')).toBe(true)
  // Git quotes a path with unusual characters; the quoted form names the same file.
  expect(statusLineIsPath('?? "docs/a b.md"', 'docs\\a b.md')).toBe(true)

  expect(statusLineIsPath('?? src/other.ts', '.ak-harness/verification.json')).toBe(false)
  expect(statusLineIsPath('?? anything', '')).toBe(false)
})
