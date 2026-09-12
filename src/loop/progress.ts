import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One outcome id (from the frozen contract) mapped to how far the worker has gotten on it. */
export type OutcomeProgressStatus = 'in-progress' | 'done'
export type OutcomeProgress = Readonly<Record<string, OutcomeProgressStatus>>

/**
 * The worker cannot be asked "what have you done so far" — it is an opaque CLI session, and the contract's
 * outcome list (`brief.ts`) is a static plan frozen before dispatch, not a live todo list. The brief documents a
 * lightweight convention instead: the worker writes `progress.json` at its worktree root, one entry per outcome id
 * it has started or finished, and we read it back best-effort. A missing, unreadable or malformed file is not an
 * error — it just means no progress has been reported yet — because nothing enforces that a worker keeps it
 * current, and older dispatches never wrote one at all.
 */
export const readOutcomeProgress = (worktreePath: string | null | undefined): OutcomeProgress | null => {
  if (!worktreePath) return null
  const path = join(worktreePath, 'progress.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, OutcomeProgressStatus] => entry[1] === 'in-progress' || entry[1] === 'done')
    return entries.length ? Object.fromEntries(entries) : null
  } catch { return null }
}
