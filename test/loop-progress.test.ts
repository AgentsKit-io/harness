import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOutcomeProgress } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempWorktree = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-progress-')); cleanups.push(dir); return dir }

describe('readOutcomeProgress', () => {
  it('returns null when no worktree path is given', () => {
    expect(readOutcomeProgress(null)).toBeNull()
    expect(readOutcomeProgress(undefined)).toBeNull()
  })

  it('returns null when progress.json does not exist', () => {
    expect(readOutcomeProgress(tempWorktree())).toBeNull()
  })

  it('reads a valid progress.json', () => {
    const dir = tempWorktree()
    writeFileSync(join(dir, 'progress.json'), JSON.stringify({ o1: 'done', o2: 'in-progress' }), 'utf8')
    expect(readOutcomeProgress(dir)).toEqual({ o1: 'done', o2: 'in-progress' })
  })

  it('drops entries with an invalid status and returns null if none remain', () => {
    const dir = tempWorktree()
    writeFileSync(join(dir, 'progress.json'), JSON.stringify({ o1: 'done', o2: 'started' }), 'utf8')
    expect(readOutcomeProgress(dir)).toEqual({ o1: 'done' })

    const dir2 = tempWorktree()
    writeFileSync(join(dir2, 'progress.json'), JSON.stringify({ o1: 'started' }), 'utf8')
    expect(readOutcomeProgress(dir2)).toBeNull()
  })

  it('returns null for malformed JSON or a non-object shape instead of throwing', () => {
    const dir = tempWorktree()
    writeFileSync(join(dir, 'progress.json'), 'not json', 'utf8')
    expect(readOutcomeProgress(dir)).toBeNull()

    const dir2 = tempWorktree()
    writeFileSync(join(dir2, 'progress.json'), JSON.stringify(['o1', 'o2']), 'utf8')
    expect(readOutcomeProgress(dir2)).toBeNull()
  })
})
