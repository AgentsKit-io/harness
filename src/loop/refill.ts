import type { LoopConfig } from './config.js'
import type { TrackerConnector } from './connectors.js'
import { HarnessError } from '../kernel/errors.js'
import { isTrackerRateLimit, TrackerCooldownError } from './tracker-cooldown.js'

/**
 * What one `linear.refill` pass did. `held` is how many open issues `person` already had in the queue's states and
 * projects; `assigned` went through, `planned` is what a dry run would have assigned; every failure is a note.
 */
export interface RefillOutcome {
  readonly person: string
  readonly target: number
  readonly held: number
  readonly assigned: readonly string[]
  readonly planned: readonly string[]
  readonly notes: readonly string[]
  /** The tracker started (or is in) a rate-limit cooldown during the pass: the caller's next read will be refused. */
  readonly cooling: boolean
}

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
const isCooling = (error: unknown): boolean => error instanceof TrackerCooldownError || isTrackerRateLimit(error)

/** Whether `linear.refill` applies at all: enabled, and only on a `person` queue (`unassigned` already drains the pool). */
export const refillApplies = (config: LoopConfig): boolean => config.linear.refill.enabled && config.linear.queueOwnership === 'person'

/**
 * Top `person`'s queue up to `linear.refill.target` from the unassigned pool, in queue order (priority first).
 *
 * Both reads go through the same `tracker.queue` filter the tick uses — states, projects, labels and `order` — so
 * "held" means exactly what the person queue would list (in-flight issues included: the tick filters busy ones
 * later, the queue read does not) and the pool is ordered exactly like the queue that will dispatch it. Never
 * throws: a refill that cannot read or write the tracker is a note, and the tick goes on with what it has.
 */
export const runRefill = async (input: { readonly config: LoopConfig; readonly tracker: TrackerConnector; readonly person: string; readonly dryRun: boolean }): Promise<RefillOutcome | null> => {
  const { config, tracker, person, dryRun } = input
  if (!refillApplies(config)) return null
  const { target, skipLabels } = config.linear.refill
  const notes: string[] = []
  const outcome = (held: number, assigned: readonly string[], planned: readonly string[], cooling = false): RefillOutcome => ({ person, target, held, assigned, planned, notes, cooling })
  // Resolved up front, like `claim` does it: a missing id would otherwise fail every single assignment the same way.
  if (!config.linear.people[person]) { notes.push(`refill skipped: no Linear user id for "${person}" (linear.people.${person})`); return outcome(0, [], []) }
  let held: number
  let pool: readonly { readonly identifier: string }[]
  try {
    held = (await tracker.queue({ assignee: person, ownership: 'person' })).length
    if (held >= target) return outcome(held, [], [])
    pool = await tracker.queue({ assignee: person, ownership: 'unassigned', excludeLabels: skipLabels })
  } catch (error) {
    notes.push(`refill skipped: tracker read failed: ${message(error)}`)
    return outcome(0, [], [], isCooling(error))
  }
  const picks = pool.slice(0, target - held).map((issue) => issue.identifier)
  if (dryRun) return outcome(held, [], picks)
  const assigned: string[] = []
  for (const issue of picks) {
    try { await tracker.claim(issue, person); assigned.push(issue) } catch (error) {
      notes.push(`refill: assigning ${issue} to ${person} failed: ${message(error)}`)
      // Every further write would hit the same limit; the guard already recorded the cooldown.
      if (isCooling(error)) return outcome(held, assigned, [], true)
    }
  }
  return outcome(held, assigned, [])
}
