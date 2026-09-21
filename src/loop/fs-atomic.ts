import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRY_DELAYS_MS: readonly number[] = [5, 15, 40, 80]

/** Synchronous because the whole write is: an async pause here would reopen the very window the rename closes. */
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * Rename, retrying briefly on the sharing-violation codes.
 *
 * On POSIX the first attempt always succeeds, so this is a no-op there. On Windows `MoveFileEx` fails with
 * `EPERM`/`EBUSY`/`EACCES` while another process holds the *destination* open without `FILE_SHARE_DELETE` —
 * which is exactly how `readFileSync` opens it, and `readDeliveryState`/`readDispatchRecord` read these files
 * on every `tick`/`deliver`. A few short waits outlast a concurrent read; anything else rethrows unchanged.
 */
const renameWithRetry = (from: string, to: string): void => {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error
      sleepSync(delay)
    }
  }
  renameSync(from, to)
}

/**
 * Write JSON to `path` atomically: write to a temp file in the same directory, then rename over the target.
 * `dispatch.json`/`delivery.json`/`contract.json` are each read fresh on every `tick`/`deliver` run — a direct
 * `writeFileSync` to the final path leaves a window where a crash mid-write, or a concurrent read, sees a
 * truncated file. The reader here (`readDeliveryState` and friends) already treats malformed JSON as "no state
 * yet" rather than erroring, which would silently reset fixRounds/nudges/finalOutcome instead of surfacing the
 * corruption — so preventing the truncated write in the first place matters more than usual. `renameSync` within
 * one directory is atomic on POSIX; on Windows it replaces the destination but can fail outright while a reader
 * holds it open, hence the bounded retry in `renameWithRetry`.
 */
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameWithRetry(tmp, path)
}
