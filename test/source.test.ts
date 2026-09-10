import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sourceSnapshot } from '../src/execution/source.js'

const git = (root: string, args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' }) }
const repository = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'agentskit-harness-source-'))
  git(root, ['init', '-q']); git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['config', 'user.name', 'Harness test'])
  writeFileSync(join(root, 'tracked.txt'), 'one\n'); git(root, ['add', 'tracked.txt']); git(root, ['commit', '-qm', 'initial'])
  return root
}

it('changes the Git evidence fingerprint for committed, dirty, and untracked content while excluding task state', async () => {
  const root = repository(); const stateDir = join(root, '.codex', 'verification'); mkdirSync(stateDir, { recursive: true })
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
  await expect(sourceSnapshot(root, join(root, '.codex', 'verification'))).rejects.toMatchObject({ code: 'GIT_REQUIRED' })
})
