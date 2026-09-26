import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { join } from 'node:path'
import { readJsonFile } from '../kernel/json-file.js'

type StageLockMetadata = { readonly pid?: unknown; readonly stage?: unknown }

export interface StageLockStatus {
  /** True only when a lock file exists AND its owner is a live process within the recovery window (see
   * `acquireStageLock`'s doc comment) — the same "still genuinely held" test `acquireStageLock` itself applies,
   * just without creating, deleting, or otherwise mutating anything. */
  readonly held: boolean
  readonly pid: number | null
  readonly ageMs: number | null
}

const ownerIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readOwner = (path: string): number | null => {
  try {
    const value = readJsonFile(path, z.object({ pid: z.number().int().positive() }).loose())
    return value ? value.pid : null
  } catch {
    return null
  }
}

/**
 * Acquire one stage lock and recover a lock whose owner process is gone.
 *
 * The scheduler kills timed-out prechecks. Waiting for a fixed 30-minute
 * lease after that turns a bounded timeout into a multi-cycle outage, so a
 * dead PID is enough evidence to recover immediately. The age ceiling remains
 * as a PID-reuse/malformed-lock backstop.
 */
export const acquireStageLock = (stateDir: string, stage: string): (() => void) | null => {
  const path = join(stateDir, `.stage-${stage}.lock`)
  mkdirSync(stateDir, { recursive: true })
  try {
    const fd = openSync(path, 'wx')
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, stage, at: new Date().toISOString() })}\n`, 'utf8')
    closeSync(fd)
    return () => { try { unlinkSync(path) } catch { /* another run recovered the stale lock */ } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      const ageMs = Date.now() - statSync(path).mtimeMs
      const owner = readOwner(path)
      if ((owner !== null && !ownerIsAlive(owner)) || ageMs > 30 * 60_000) {
        unlinkSync(path)
        return acquireStageLock(stateDir, stage)
      }
    } catch { /* lock disappeared; next scheduled run retries */ }
    return null
  }
}

/**
 * Read-only equivalent of `acquireStageLock`'s "is this still genuinely held" test — a stale lock (dead owner,
 * or older than the 30-minute backstop) reports `held: false` without recovering it, so a caller that only wants
 * to know whether real work is already in flight (e.g. a fast precheck deciding whether to spawn a background
 * worker) never races the worker that will do the actual acquire.
 */
export const peekStageLock = (stateDir: string, stage: string): StageLockStatus => {
  const path = join(stateDir, `.stage-${stage}.lock`)
  if (!existsSync(path)) return { held: false, pid: null, ageMs: null }
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs
    const pid = readOwner(path)
    const held = (pid === null || ownerIsAlive(pid)) && ageMs <= 30 * 60_000
    return { held, pid, ageMs }
  } catch {
    return { held: false, pid: null, ageMs: null }
  }
}
