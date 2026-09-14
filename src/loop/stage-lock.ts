import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type StageLockMetadata = { readonly pid?: unknown; readonly stage?: unknown }

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
    const value = JSON.parse(readFileSync(path, 'utf8')) as StageLockMetadata
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null
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
