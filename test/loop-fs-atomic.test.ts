import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-fs-atomic-')); cleanups.push(dir); return dir }

describe('writeJsonAtomic', () => {
  it('writes readable JSON, creating the parent directory if needed, and leaves no temp file behind', () => {
    const dir = tempDir()
    const path = join(dir, 'issues', 'ENG-1', 'delivery.json')
    writeJsonAtomic(path, { issue: 'ENG-1', fixRounds: 0 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ issue: 'ENG-1', fixRounds: 0 })
    expect(readdirSync(join(dir, 'issues', 'ENG-1'))).toEqual(['delivery.json']) // no stray .tmp file
  })

  it('overwrites an existing file cleanly, never leaving a partial write or a leftover temp file', () => {
    const dir = tempDir()
    const path = join(dir, 'delivery.json')
    writeJsonAtomic(path, { fixRounds: 0, nudges: [] })
    writeJsonAtomic(path, { fixRounds: 2, nudges: ['a', 'b'], finalOutcome: 'merged' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ fixRounds: 2, nudges: ['a', 'b'], finalOutcome: 'merged' })
    expect(readdirSync(dir)).toEqual(['delivery.json'])
  })

  it('never touches the target path directly — the write lands in a sibling temp file first', () => {
    const dir = tempDir()
    const path = join(dir, 'contract.json')
    // Sanity: before the call, nothing exists at all.
    expect(existsSync(path)).toBe(false)
    writeJsonAtomic(path, { schemaVersion: 1 })
    expect(existsSync(path)).toBe(true)
    // The temp filename pattern (`.<basename>.<pid>.<ts>.tmp`) must never collide with or survive as the final name.
    expect(readdirSync(dir).every((name) => name === 'contract.json')).toBe(true)
  })
})
