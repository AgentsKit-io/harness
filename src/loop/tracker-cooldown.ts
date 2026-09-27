import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cooldownUntil } from '../adapters/providers.js'
import type { TrackerConnector } from './connectors.js'
import { writeJsonAtomic } from './fs-atomic.js'

/**
 * The tracker's own rate limit, the way `provider-cooldowns.json` is a provider's: one file, one entry, a doubling
 * backoff. Without it a rate-limited Linear kept failing every tick until the stage auto-paused for good, and deliver
 * kept writing into the limit.
 */
export interface TrackerCooldown { readonly attempts: number; readonly until: string; readonly reason: string; readonly markedAt: string }

// ponytail: fixed backoff, not config; 15 min doubling to a 2 h cap covers Linear's hourly window.
const INITIAL_MIN = 15
const MAX_MIN = 120

/** A rate-limit answer, not any failure: a bare "429" inside a hash or an id must not match. */
export const TRACKER_RATE_LIMIT = /rate.?limit|too many requests|\bHTTP 429\b|\b429 Too Many/i

const text = (error: unknown): string => error instanceof Error ? error.message : String(error)
export const isTrackerRateLimit = (error: unknown): boolean => TRACKER_RATE_LIMIT.test(text(error))

export const trackerCooldownPath = (stateDir: string): string => join(stateDir, 'tracker-cooldown.json')

const readEntry = (stateDir: string): TrackerCooldown | null => {
  const path = trackerCooldownPath(stateDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrackerCooldown> | null
    return parsed && typeof parsed.until === 'string' ? { attempts: parsed.attempts ?? 0, until: parsed.until, reason: parsed.reason ?? '', markedAt: parsed.markedAt ?? parsed.until } : null
  } catch { return null }
}

/** The cooldown in force now, or null. */
export const activeTrackerCooldown = (stateDir: string, now: Date = new Date()): TrackerCooldown | null => {
  const entry = readEntry(stateDir)
  return entry && Date.parse(entry.until) > now.getTime() ? entry : null
}

export const markTrackerRateLimited = (stateDir: string, reason: string, now: Date = new Date()): TrackerCooldown => {
  const previous = readEntry(stateDir)
  const attempts = previous && Date.parse(previous.until) > now.getTime() - MAX_MIN * 60_000 ? previous.attempts + 1 : 0
  const entry: TrackerCooldown = { attempts, until: cooldownUntil(attempts, INITIAL_MIN, MAX_MIN, now), reason: reason.slice(0, 300), markedAt: now.toISOString() }
  writeJsonAtomic(trackerCooldownPath(stateDir), entry)
  return entry
}

/** Thrown instead of calling a tracker that is cooling down: the call was skipped, not attempted. */
export class TrackerCooldownError extends Error {}

/**
 * The same connector, but every call first checks the cooldown (and is skipped with `TrackerCooldownError` while one
 * is in force), and a call that fails with a rate limit starts one. `onRateLimited` is where the caller logs it.
 */
export const guardTracker = (tracker: TrackerConnector, input: { readonly stateDir: string; readonly now: () => Date; readonly dryRun?: boolean; readonly onRateLimited?: (entry: TrackerCooldown) => void }): TrackerConnector => {
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const active = activeTrackerCooldown(input.stateDir, input.now())
    if (active) throw new TrackerCooldownError(`${tracker.id} is rate-limited; cooling down until ${active.until}, call skipped`)
    try { return await call(...args) } catch (error) {
      if (!input.dryRun && isTrackerRateLimit(error)) input.onRateLimited?.(markTrackerRateLimited(input.stateDir, text(error), input.now()))
      throw error
    }
  }
  return {
    ...tracker,
    queue: guard(tracker.queue),
    issue: guard(tracker.issue),
    comment: guard(tracker.comment),
    addLabels: guard(tracker.addLabels),
    removeLabels: guard(tracker.removeLabels),
    setState: guard(tracker.setState),
    claim: guard(tracker.claim),
    release: guard(tracker.release),
    attach: guard(tracker.attach),
    createIssue: guard(tracker.createIssue),
    transitions: { ...tracker.transitions, transition: guard(tracker.transitions.transition) },
  }
}
