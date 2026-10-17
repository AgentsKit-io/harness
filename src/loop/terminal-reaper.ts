import { join } from 'node:path'
import { toPosix } from '@agentskit/cross-platform'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { orcaTerminalClose, orcaTerminalList, type OrcaTerminal, type OrcaWorktree } from '../adapters/orca-cli.js'
import { readJsonFile } from '../kernel/json-file.js'
import { HarnessError } from '../kernel/errors.js'
import type { LoopConfig } from './config.js'
import type { DeliveryState, DeliverOutcome } from './deliver-state.js'
import type { LoopEventPayload } from './event-bus.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { DispatchRecordFile } from './tick.js'

/**
 * Worker terminals are whole agent sessions. Nothing used to close one unless its worktree was removed on merge, so
 * every blocked, stuck or waiting worker kept its session forever: 48 idle terminals exhausted a machine's memory
 * and made `orca terminal create` time out on every dispatch (2026-10-16). This closes them — only terminals the
 * loop itself recorded, in worktrees the loop itself created, never the worktree itself.
 */

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
/** Orca saying the terminal is already gone: the close we wanted already happened. */
const ALREADY_GONE = /selector_not_found|terminal_handle_stale/

// ponytail: fixed, not config; a pass closes at most this many, the rest wait for the next pass (minutes later).
const MAX_CLOSES_PER_PASS = 20
// ponytail: fixed; a superseded or orphaned terminal still printing within this window is left for a later pass.
const QUIET_GRACE_MIN = 10
/** The only outcomes of this pass under which a live worker may be idle-reaped: the loop itself is only waiting
 * (CI, review, a person). A fix round, nudge, handoff or HITL answer means the worker was just given work. */
const WAITING_OUTCOMES = new Set<DeliverOutcome>(['waiting', 'held'])

const normalizePath = (path: string): string => toPosix(path).replace(/\/+$/, '').toLowerCase()
const terminalPath = (terminal: OrcaTerminal): string => {
  const raw = terminal.raw['worktreePath']
  if (typeof raw === 'string' && raw) return raw
  const id = terminal.worktreeId ?? ''
  return id.includes('::') ? id.slice(id.indexOf('::') + 2) : ''
}

export interface ReapInput {
  readonly runner: CommandRunner
  readonly config: LoopConfig
  /** The project's main checkout: a terminal there is never touched, whatever a record says. */
  readonly root: string
  readonly records: readonly DispatchRecordFile[]
  readonly stateOf: (issue: string) => DeliveryState
  readonly leasedIssues: ReadonlySet<string>
  /** Issues `finish()` closed out in this pass (their state may not be on disk in a dry run). */
  readonly finishedThisPass: ReadonlyMap<string, string>
  /** What this pass decided per issue, to tell a worker that is only waiting from one that was just sent work. */
  readonly results: readonly { readonly issue: string; readonly outcome: DeliverOutcome; readonly pr?: number }[]
  readonly now: Date
  readonly dryRun: boolean
  readonly emit: (payload: LoopEventPayload) => void
}

export interface ReapReport {
  readonly closed: readonly { readonly issue: string; readonly terminal: string; readonly reason: string }[]
  readonly failed: number
  readonly notes: readonly string[]
}

// An unparseable timestamp counts as 0 (just active): every caller guards with `<`, which NaN would pass.
const minutesSince = (now: Date, at: number | string | null | undefined): number => {
  if (at === null || at === undefined) return Number.POSITIVE_INFINITY
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) ? (now.getTime() - ms) / 60_000 : 0
}

/**
 * One cheap pass at the end of `deliver`: close what `finish()` ended this pass, then list Orca's terminals once and
 * close (a) terminals of issues that are finished or hold no lease, (b) terminals a later worker superseded, and
 * (c) the worker of an issue whose PR is open and that only waits, silent past `delivery.reapIdleTerminalsMinutes`.
 * Best-effort: never throws, tolerates handles that are already gone, and a dry run only reports.
 */
export const reapWorkerTerminals = async (input: ReapInput): Promise<ReapReport> => {
  const { config, now, dryRun } = input
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const closed: { issue: string; terminal: string; reason: string }[] = []
  const notes: string[] = []
  const handled = new Set<string>()
  let failed = 0
  const counts = { orphaned: 0, idle: 0, superseded: 0 }
  const root = normalizePath(input.root)

  const close = async (record: DispatchRecordFile, terminal: string, reason: string, kind: keyof typeof counts): Promise<void> => {
    if (handled.has(terminal) || closed.length + failed >= MAX_CLOSES_PER_PASS) return
    handled.add(terminal)
    if (dryRun) { closed.push({ issue: record.issue, terminal, reason }); counts[kind] += 1; notes.push(`${record.issue}: would close worker terminal ${terminal} (${reason})`); return }
    try { await orcaTerminalClose(input.runner, { terminal }, orca) } catch (error) {
      if (!ALREADY_GONE.test(message(error))) { failed += 1; notes.push(`${record.issue}: closing worker terminal ${terminal} failed: ${message(error)}`); return }
    }
    closed.push({ issue: record.issue, terminal, reason })
    counts[kind] += 1
    input.emit({ type: 'worker.terminal-closed', issue: record.issue, terminal, reason, worktreeId: record.worktreeId })
  }

  const byIssue = new Map(input.records.map((record) => [record.issue, record]))
  const idleAfter = config.delivery.reapIdleTerminalsMinutes
  if (!config.delivery.closeTerminalOnFinish && idleAfter === 0) return { closed, failed, notes }
  let terminals: readonly OrcaTerminal[]
  try { terminals = await orcaTerminalList(input.runner, {}, orca) } catch (error) {
    notes.push(`terminal reaper skipped: terminal list failed: ${message(error)}`)
    return { closed, failed, notes }
  }
  const byWorktree = new Map(input.records.map((record) => [record.worktreeId, record]))
  // What finish() ended this pass: close its recorded terminal (no grace) through the same root / main-worktree /
  // ownership guards as the list pass, using the listed terminal rather than the bare record handle.
  const safe = (terminal: OrcaTerminal, record: DispatchRecordFile): boolean => {
    if (terminal.worktreeId !== record.worktreeId) return false
    const path = normalizePath(terminalPath(terminal))
    return Boolean(path) && path !== root && terminal.raw['isMainWorktree'] !== true
  }
  if (config.delivery.closeTerminalOnFinish) {
    for (const [issue, outcome] of input.finishedThisPass) {
      const record = byIssue.get(issue)
      const listed = record?.terminal ? terminals.find((item) => item.handle === record.terminal) : undefined
      if (record && listed && safe(listed, record)) await close(record, listed.handle, `finished: ${outcome}`, 'orphaned')
    }
  }
  const resultOf = new Map(input.results.map((result) => [result.issue, result]))
  for (const terminal of terminals) {
    if (handled.has(terminal.handle)) continue
    // Only worktrees the loop created for this project, never its main checkout.
    const record = terminal.worktreeId ? byWorktree.get(terminal.worktreeId) : undefined
    if (!record) continue
    const path = normalizePath(terminalPath(terminal))
    if (!path || path === root || terminal.raw['isMainWorktree'] === true) continue
    const state = input.stateOf(record.issue)
    // Only terminals the loop opened: the dispatch's current handle and the handoff terminals it recorded. A shell a
    // person opened in the same worktree to look around is theirs.
    const handoffs = new Set(state.handoffs.map((handoff) => handoff.terminal))
    const current = terminal.handle === record.terminal
    if (!current && !handoffs.has(terminal.handle)) continue
    const quiet = minutesSince(now, terminal.lastOutputAt)
    const finished = Boolean(state.finishedAt) || input.finishedThisPass.has(record.issue)
    if (finished || !input.leasedIssues.has(record.issue)) {
      if (!config.delivery.closeTerminalOnFinish) continue
      if (!current && quiet < QUIET_GRACE_MIN) continue
      await close(record, terminal.handle, finished ? `orphaned: issue finished (${state.finalOutcome ?? input.finishedThisPass.get(record.issue) ?? 'finished'})` : 'orphaned: no active dispatch lease', 'orphaned')
      continue
    }
    if (!current) {
      if (!config.delivery.closeTerminalOnFinish || quiet < QUIET_GRACE_MIN) continue
      await close(record, terminal.handle, `superseded by worker terminal ${record.terminal ?? 'none'}`, 'superseded')
      continue
    }
    // The current worker of a live issue: only when a PR is open, the pass only waited, nothing was sent to it within
    // the window, and its terminal printed nothing for that long. A worker building or fixing is never idle here.
    if (idleAfter === 0 || terminal.lastOutputAt === null || quiet < idleAfter) continue
    const result = resultOf.get(record.issue)
    if (!result || !WAITING_OUTCOMES.has(result.outcome)) continue
    if (result.pr === undefined && state.prNumber === null) continue
    if (minutesSince(now, state.nudges.at(-1)?.at) < idleAfter) continue
    await close(record, terminal.handle, `idle ${Math.round(quiet)} min with PR open (${result.outcome})`, 'idle')
  }
  if (closed.length || failed) {
    notes.push(`terminal reaper: ${dryRun ? 'would close' : 'closed'} ${closed.length} worker terminal(s) (${counts.orphaned} orphaned, ${counts.idle} idle, ${counts.superseded} superseded)${failed ? `, ${failed} failed` : ''}`)
    if (!dryRun) input.emit({ type: 'terminals.reaped', closed: closed.length, orphaned: counts.orphaned, idle: counts.idle, superseded: counts.superseded, failed })
  }
  return { closed, failed, notes }
}

// ---- dispatch capacity (tick) -------------------------------------------------------------------

/** `orca terminal create` timing out is the machine out of room for another agent session, not this issue failing. */
export const isTerminalCapacityError = (error: unknown): boolean => {
  const text = message(error)
  return /Timed out waiting for terminal handle/i.test(text) || (/terminal create/i.test(text) && /timed out/i.test(text))
}

// ponytail: fixed; a capacity timeout pauses dispatching this long, then the next tick tries again.
export const CAPACITY_COOLDOWN_MIN = 10
export const terminalCapacityPath = (stateDir: string): string => join(stateDir, 'terminal-capacity.json')

export const markTerminalCapacity = (stateDir: string, reason: string, now: Date): string => {
  const until = new Date(now.getTime() + CAPACITY_COOLDOWN_MIN * 60_000).toISOString()
  writeJsonAtomic(terminalCapacityPath(stateDir), { until, reason, markedAt: now.toISOString() })
  return until
}

export const activeTerminalCapacityCooldown = (stateDir: string, now: Date): { readonly until: string; readonly reason: string } | null => {
  const entry = readJsonFile(terminalCapacityPath(stateDir), z.object({ until: z.string(), reason: z.string().default('') }).loose())
  return entry && Date.parse(entry.until) > now.getTime() ? { until: entry.until, reason: entry.reason } : null
}

/** Live terminals in the worktrees the loop dispatched into (from `worktree ps`, no extra Orca call). */
export const liveLoopTerminals = (worktrees: readonly OrcaWorktree[], loopWorktreeIds: ReadonlySet<string>): number =>
  worktrees.filter((worktree) => !worktree.isArchived && !worktree.isMainWorktree && loopWorktreeIds.has(worktree.id)).reduce((sum, worktree) => sum + worktree.liveTerminalCount, 0)
