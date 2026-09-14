import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Write JSON to `path` atomically: write to a temp file in the same directory, then rename over the target.
 * `dispatch.json`/`delivery.json`/`contract.json` are each read fresh on every `tick`/`deliver` run — a direct
 * `writeFileSync` to the final path leaves a window where a crash mid-write, or a concurrent read, sees a
 * truncated file. The reader here (`readDeliveryState` and friends) already treats malformed JSON as "no state
 * yet" rather than erroring, which would silently reset fixRounds/nudges/finalOutcome instead of surfacing the
 * corruption — so preventing the truncated write in the first place matters more than usual. `renameSync` within
 * one directory is atomic on POSIX and, since Node 10+, overwrites the destination on Windows too.
 */
export const writeJsonAtomic = (path: string, value: unknown): void => {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
