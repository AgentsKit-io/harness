import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearIssueFailures, isIssuePaused, isStagePaused, listPausedIssues, pauseIssue, readIssueFailures,
  readStagePause, recordIssueFailure, recordStageRunResult, resumeIssue, resumeStage,
} from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-resilience-')); cleanups.push(dir); return dir }

describe('per-issue failure tracking', () => {
  it('starts empty, accumulates consecutive failures with capped history, and clears on progress', () => {
    const stateDir = tempStateDir()
    expect(readIssueFailures(stateDir, 'ENG-1')).toEqual({ issue: 'ENG-1', consecutive: 0, history: [], pausedAt: null, pausedReason: null })
    const now = new Date('2026-09-12T10:00:00.000Z')
    let state = recordIssueFailure(stateDir, 'ENG-1', 'contract.failed', 'exit 1: quota', now)
    expect(state.consecutive).toBe(1)
    expect(state.history[0]).toMatchObject({ kind: 'contract.failed', reason: 'exit 1: quota' })
    for (let i = 0; i < 15; i += 1) state = recordIssueFailure(stateDir, 'ENG-1', 'contract.failed', `attempt ${i}`, now)
    expect(state.consecutive).toBe(16)
    expect(state.history).toHaveLength(10) // capped
    expect(state.history[0]?.reason).toBe('attempt 14') // most recent first
    clearIssueFailures(stateDir, 'ENG-1')
    const cleared = readIssueFailures(stateDir, 'ENG-1')
    expect(cleared.consecutive).toBe(0)
    expect(cleared.pausedAt).toBeNull()
    expect(cleared.history).toHaveLength(10) // history is diagnostic-only and survives a clear
  })

  it('pauses/resumes independently per issue and lists every paused issue', () => {
    const stateDir = tempStateDir()
    expect(isIssuePaused(stateDir, 'ENG-1')).toBe(false)
    pauseIssue(stateDir, 'ENG-1', 'contract.failed: quota', new Date('2026-09-12T10:00:00.000Z'))
    recordIssueFailure(stateDir, 'ENG-2', 'worker.dispatch-failed', 'repo busy')
    expect(isIssuePaused(stateDir, 'ENG-1')).toBe(true)
    expect(isIssuePaused(stateDir, 'ENG-2')).toBe(false)
    expect(listPausedIssues(stateDir).map((state) => state.issue)).toEqual(['ENG-1'])
    resumeIssue(stateDir, 'ENG-1')
    expect(isIssuePaused(stateDir, 'ENG-1')).toBe(false)
    expect(readIssueFailures(stateDir, 'ENG-1').consecutive).toBe(0)
    expect(listPausedIssues(stateDir)).toEqual([])
  })

  it('lists no paused issues when the issues directory does not exist yet', () => {
    expect(listPausedIssues(tempStateDir())).toEqual([])
  })
})

describe('stage-level pause', () => {
  it('pauses a stage only once the failure threshold is crossed, and a success clears it', () => {
    const stateDir = tempStateDir()
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
    let entry = recordStageRunResult(stateDir, 'tick', { succeeded: false, reason: 'config load failed' }, 3)
    expect(entry.consecutiveFailures).toBe(1)
    expect(entry.pausedAt).toBeNull()
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
    entry = recordStageRunResult(stateDir, 'tick', { succeeded: false, reason: 'config load failed' }, 3)
    expect(entry.consecutiveFailures).toBe(2)
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
    entry = recordStageRunResult(stateDir, 'tick', { succeeded: false, reason: 'config load failed' }, 3)
    expect(entry.consecutiveFailures).toBe(3)
    expect(entry.pausedAt).not.toBeNull()
    expect(isStagePaused(stateDir, 'tick')).toBe(true)
    // deliver is tracked independently
    expect(isStagePaused(stateDir, 'deliver')).toBe(false)
    // a later success clears the pause and the counter
    recordStageRunResult(stateDir, 'tick', { succeeded: true }, 3)
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
    expect(readStagePause(stateDir).tick).toBeUndefined()
  })

  it('keeps the original pausedAt across repeated failures after crossing the threshold, and resumeStage clears everything', () => {
    const stateDir = tempStateDir()
    const first = new Date('2026-09-12T10:00:00.000Z')
    for (let i = 0; i < 3; i += 1) recordStageRunResult(stateDir, 'deliver', { succeeded: false, reason: 'boom' }, 3, first)
    const pausedAt = readStagePause(stateDir).deliver?.pausedAt
    expect(pausedAt).toBe(first.toISOString())
    const later = recordStageRunResult(stateDir, 'deliver', { succeeded: false, reason: 'boom again' }, 3, new Date('2026-09-12T11:00:00.000Z'))
    expect(later.pausedAt).toBe(pausedAt) // unchanged — records when the pause *started*, not the latest failure
    expect(later.consecutiveFailures).toBe(4)
    resumeStage(stateDir, 'deliver')
    expect(isStagePaused(stateDir, 'deliver')).toBe(false)
    expect(readStagePause(stateDir)).toEqual({})
  })

  it('tolerates a missing or corrupt paused.json', () => {
    const stateDir = tempStateDir()
    expect(readStagePause(stateDir)).toEqual({})
    resumeStage(stateDir, 'tick') // no-op, must not throw
    expect(isStagePaused(stateDir, 'tick')).toBe(false)
  })
})
