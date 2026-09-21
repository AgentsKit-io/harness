import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'

/**
 * The rename retry only fires on Windows sharing violations, so the failure is injected instead of gated on
 * `process.platform`: the assertions below hold on every platform.
 */
const rename = vi.hoisted(() => ({ failures: 0, code: 'EPERM' as string, attempts: 0 }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]): void => {
      rename.attempts += 1
      if (rename.failures > 0) {
        rename.failures -= 1
        throw Object.assign(new Error('sharing violation'), { code: rename.code })
      }
      actual.renameSync(from, to)
    },
  }
})

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { rename.failures = 0; rename.code = 'EPERM'; rename.attempts = 0 })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-fs-atomic-retry-')); cleanups.push(dir); return dir }

describe('writeJsonAtomic rename retry', () => {
  it('retries a rename that fails with a Windows sharing violation while a reader holds the destination open', () => {
    const dir = tempDir()
    const path = join(dir, 'delivery.json')
    rename.failures = 2
    writeJsonAtomic(path, { fixRounds: 2, finalOutcome: 'merged' })
    expect(rename.attempts).toBe(3)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ fixRounds: 2, finalOutcome: 'merged' })
    expect(readdirSync(dir)).toEqual(['delivery.json'])
  })

  it.each(['EBUSY', 'EACCES'])('retries on %s as well', (code) => {
    const dir = tempDir()
    const path = join(dir, 'dispatch.json')
    rename.code = code
    rename.failures = 1
    writeJsonAtomic(path, { issue: 'ENG-1' })
    expect(rename.attempts).toBe(2)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ issue: 'ENG-1' })
  })

  it('rethrows an error that is not a sharing violation without retrying', () => {
    const dir = tempDir()
    rename.code = 'ENOSPC'
    rename.failures = 1
    expect(() => writeJsonAtomic(join(dir, 'contract.json'), { schemaVersion: 1 })).toThrow(/sharing violation/)
    expect(rename.attempts).toBe(1)
  })

  it('gives up after a bounded number of attempts instead of spinning forever', () => {
    const dir = tempDir()
    rename.failures = Number.MAX_SAFE_INTEGER
    expect(() => writeJsonAtomic(join(dir, 'delivery.json'), { fixRounds: 0 })).toThrow(/sharing violation/)
    expect(rename.attempts).toBe(5)
  })

  it('renames once on the happy path, so POSIX behaviour is unchanged', () => {
    const dir = tempDir()
    writeJsonAtomic(join(dir, 'delivery.json'), { fixRounds: 0 })
    expect(rename.attempts).toBe(1)
  })
})
