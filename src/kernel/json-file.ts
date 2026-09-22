import { existsSync, readFileSync } from 'node:fs'
import type { ZodType } from 'zod'

/**
 * Read a JSON file the harness itself wrote, and prove it is what the caller expects before handing it over.
 *
 * `JSON.parse(readFileSync(path)) as T` was the shape everywhere before this: a claim about a file on disk that
 * nothing had checked. A record missing a field, or holding a string where a number belonged, passed the cast and
 * failed somewhere else entirely — as a missing property on a value the type said was present. State files are
 * edited by hand, truncated by a full disk, and written by older versions of this package, so the claim is not
 * safe to make for free.
 *
 * `null` is the answer for absent, unparseable and invalid alike. Every caller already had a path for "no file
 * here", so invalid content joining it needs no new branch — and a corrupt file reading as absent is the
 * behaviour this codebase already chose for unparseable JSON.
 *
 * The schemas passed here assert the load-bearing core, not the whole type: the fields a caller dereferences
 * without a guard. Restating an entire interface in zod makes the schema a second source of truth that drifts,
 * and turns a record the loop handles today (an optional field an older version never wrote) into an absent one.
 */
export const readJsonFile = <T>(path: string, schema: ZodType<T>): T | null => {
  if (!existsSync(path)) return null
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  const result = schema.safeParse(raw)
  return result.success ? result.data : null
}
