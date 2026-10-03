import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { type CodeReviewOutcome } from '../adapters/code-review.js'
import { fail } from '../kernel/errors.js'
import { readJsonFile } from '../kernel/json-file.js'
import { toPosix } from '@agentskit/cross-platform'
import type { DispatchRecordFile } from './tick.js'
import { appendLoopEvent, dispatchRecordPath, readDispatchRecord } from './tick.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { LoadedLoopConfig } from './config.js'

export type DeliverOutcome = 'waiting' | 'reviewed' | 'fix-round' | 'nudged' | 'handed-off' | 'merged' | 'held' | 'needs-input' | 'blocked' | 'stuck' | 'abandoned' | 'failed' | 'restarted' | 'dry-run'

export interface DeliveryHandoff {
  readonly at: string
  readonly fromProvider: string
  readonly fromModel: string
  readonly toProvider: string
  readonly toModel: string
  readonly reason: string
  readonly terminal: string | null
}

export interface DeliveryState {
  readonly issue: string
  readonly prNumber: number | null
  readonly reviews: Readonly<Record<string, { readonly status: CodeReviewOutcome['status']; readonly at: string; readonly provider: string; readonly model: string | null; readonly blocking: number; readonly attempts: number; readonly reason?: string }>>
  readonly fixRounds: number
  readonly nudges: readonly { readonly kind: 'idle' | 'conflict' | 'ci' | 'review' | 'handoff' | 'permission' | 'brief' | 'hitl'; readonly at: string; readonly head: string | null }[]
  readonly handoffs: readonly DeliveryHandoff[]
  readonly heldFor: string | null
  /** A person's attested approval of a PR held for protected paths — valid only for this exact head. */
  readonly humanApproval?: { readonly head: string; readonly by: string; readonly at: string } | null
  readonly finishedAt: string | null
  readonly finalOutcome: DeliverOutcome | null
  /** Cancellation is a UI/control-plane terminal marker, not a delivery outcome. */
  readonly cancelledAt?: string | null
  /** Passes in a row that threw (gh/Orca/review exception); reset by a pass that does not. */
  readonly consecutiveErrors?: number
  /** The PR head seen when the errors finished the issue as `failed`, so a new push can resume it. */
  readonly failedAtHead?: string | null
  /** The tracker state this loop last set for the open PR, so it is not re-set on every pass. */
  readonly trackerState?: string | null
  /** When a pass first saw lost-track evidence before any PR; a restart needs a second pass to confirm it. */
  readonly lostTrackSince?: string | null
}

export const deliveryStatePath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'delivery.json')

export const readDeliveryState = (stateDir: string, identifier: string): DeliveryState => {
  const path = deliveryStatePath(stateDir, identifier)
  const empty: DeliveryState = { issue: identifier, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null, cancelledAt: null }
  if (!existsSync(path)) return empty
  const parsed = readJsonFile(path, z.object({}).loose()) as Partial<DeliveryState> | null
  if (!parsed) return empty
  return { ...empty, ...parsed, handoffs: parsed.handoffs ?? [], nudges: parsed.nudges ?? [] }
}

/** Keep a cancelled dispatch visible as historical evidence without letting it consume a worker slot. */
export const markDispatchCancelled = (stateDir: string, identifier: string, at = new Date()): DeliveryState => {
  const state = readDeliveryState(stateDir, identifier)
  // Keep an existing mark only while it still postdates the delivery it cancels; one left over from an earlier attempt
  // (older than this delivery's finishedAt) would make the new cancellation invisible to every reader (vivva #217).
  const current = state.cancelledAt && (!state.finishedAt || state.cancelledAt >= state.finishedAt) ? state.cancelledAt : null
  const next: DeliveryState = { ...state, finishedAt: state.finishedAt ?? at.toISOString(), heldFor: null, cancelledAt: current ?? at.toISOString() }
  writeJsonAtomic(deliveryStatePath(stateDir, identifier), next)
  return next
}

/**
 * Record that a person reviewed a PR the loop held for protected paths, bound to the head they reviewed.
 *
 * The loop's own review and merge gates then run as for any PR; a new push changes the head and the approval no
 * longer applies. It is an attestation in the audit trail, not a secret: anything with a shell on this machine can
 * run it, so `by` is recorded in the event log and the approval says who vouched for which commit — never
 * a label on the PR, which a worker holding the same credentials could add to its own pull request.
 */
export const approveHeldDelivery = (loaded: LoadedLoopConfig, issue: string, input: { readonly head: string; readonly by: string; readonly now?: Date }): DeliveryState => {
  const state = readDeliveryState(loaded.stateDir, issue)
  const by = input.by.trim()
  if (!by) return fail('An approval names who approves (--by).', 'INVALID_INPUT')
  if (!state.heldFor) return fail(`${issue} is not held for a human; nothing to approve.`, 'INVALID_STATE')
  if (!state.heldFor.startsWith(input.head) || input.head.length < 7) return fail(`${issue} is held at ${state.heldFor.slice(0, 12)}, not ${input.head}; review that head (or wait for the loop to see the new one) and approve it by its SHA.`, 'STALE')
  const at = (input.now ?? new Date()).toISOString()
  const next: DeliveryState = { ...state, humanApproval: { head: state.heldFor, by, at } }
  writeJsonAtomic(deliveryStatePath(loaded.stateDir, issue), next)
  appendLoopEvent(loaded.stateDir, { at, type: 'pr.human-approved', issue, head: state.heldFor, by, pr: state.prNumber })
  return next
}

/** Every issue the loop ever dispatched (finished or not) — callers that only care about in-flight work must filter on `readDeliveryState(...).finishedAt` themselves. */
export const listDispatched = (stateDir: string): readonly DispatchRecordFile[] => {
  const dir = join(stateDir, 'issues')
  if (!existsSync(dir)) return []
  const paths: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'dispatch.json') paths.push(path)
    }
  }
  visit(dir)
  return paths.map((path) => {
    // Provider identifiers such as `owner/repository#217` are stored as nested folders.
    // Reconstruct the identifier before using the canonical dispatch reader.
    const identifier = toPosix(relative(dir, dirname(path)))
    return readDispatchRecord(stateDir, identifier)
  }).filter((record): record is DispatchRecordFile => record !== null && existsSync(dispatchRecordPath(stateDir, record.issue)))
}

export const MAX_LOST_TRACKING_RESTARTS = 2
export const restartsPath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'restarts.json')

/** Restarts survive a redispatch (delivery.json is reset then), so the cap holds across attempts. */
export const readRestarts = (stateDir: string, issue: string): readonly string[] =>
  readJsonFile(restartsPath(stateDir, issue), z.object({ at: z.array(z.string()) }))?.at ?? []

/** A person's Retry starts the restart budget over: the cap counts automatic restarts since a human last looked. */
export const clearRestarts = (stateDir: string, issue: string): void => rmSync(restartsPath(stateDir, issue), { force: true })
