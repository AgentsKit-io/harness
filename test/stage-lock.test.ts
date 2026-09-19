import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acquireStageLock } from '../src/loop/stage-lock.js'

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
