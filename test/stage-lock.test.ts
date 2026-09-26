import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acquireStageLock, peekStageLock } from '../src/loop/stage-lock.js'

it('recovers a stage lock whose owner process is gone', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-stage-lock-'))
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, '.stage-deliver.lock'), JSON.stringify({ pid: 2_147_483_647, stage: 'deliver' }))
  const release = acquireStageLock(stateDir, 'deliver')
  expect(release).toEqual(expect.any(Function))
  release?.()
})

it('keeps a lock owned by this process', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-stage-lock-'))
  const release = acquireStageLock(stateDir, 'tick')
  expect(release).toEqual(expect.any(Function))
  expect(acquireStageLock(stateDir, 'tick')).toBeNull()
  release?.()
})

it('peekStageLock reports held:false with no lock file, and never creates one', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-stage-lock-'))
  expect(peekStageLock(stateDir, 'tick')).toEqual({ held: false, pid: null, ageMs: null })
  expect(existsSync(join(stateDir, '.stage-tick.lock'))).toBe(false)
})

it('peekStageLock reports held:true for a lock owned by this (live) process, without acquiring or releasing it', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-stage-lock-'))
  const release = acquireStageLock(stateDir, 'tick')
  const status = peekStageLock(stateDir, 'tick')
  expect(status.held).toBe(true)
  expect(status.pid).toBe(process.pid)
  // Filesystem mtime resolution/rounding can put this a hair below zero on some platforms; only the magnitude
  // (nowhere near the 30-minute staleness ceiling) matters here, not its sign.
  expect(Math.abs(status.ageMs ?? Infinity)).toBeLessThan(5_000)
  // Peeking must not consume the lock: the real owner still holds it, and releasing still works.
  expect(acquireStageLock(stateDir, 'tick')).toBeNull()
  release?.()
})

it('peekStageLock reports held:false for a lock whose owner process is gone, without recovering (deleting) it', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentskit-harness-stage-lock-'))
  mkdirSync(stateDir, { recursive: true })
  const lockPath = join(stateDir, '.stage-deliver.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, stage: 'deliver' }))
  const status = peekStageLock(stateDir, 'deliver')
  expect(status.held).toBe(false)
  expect(status.pid).toBe(2_147_483_647)
  // Unlike acquireStageLock, a peek is read-only: the stale file is left for the real acquire to recover.
  expect(existsSync(lockPath)).toBe(true)
})
