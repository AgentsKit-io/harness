import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative as relativePath } from 'node:path'
import { z } from 'zod'
import { sha256 } from '../kernel/hash.js'
import { scanForPii } from '../kernel/pii.js'
import { readJsonFile } from '../kernel/json-file.js'
import { acquireFileLock, releaseFileLock, writeJsonAtomic } from './fs-atomic.js'
import { readStoredContract } from './contract.js'
import { readStoredPlan } from './plan-vote.js'
import { toPosix } from '@agentskit/cross-platform'

/**
 * One issue, one run: `<stateDir>/runs/<issue>-<n>/` holds what the event log and `issues/<id>/` do not — what each
 * step was handed, what it produced, and what the machine passed on to the next step (ADR-0041).
 *
 * Nothing here is a source of truth. `state.json` is a projection of the issue's events, folded as they are
 * appended; the handoffs are written by the machine from state it already holds, never by a model. Recording is
 * best-effort: a run directory that cannot be written never fails the stage that emitted the event.
 */
export const RUNS_DIR = 'runs'
export const AGENT_RUN_SCHEMA_VERSION = 1 as const

export type AgentRunStage = 'intake' | 'contract' | 'plan' | 'build' | 'fix' | 'verify' | 'dod' | 'review' | 'merge' | 'closed'
export type AgentRunStatus = 'running' | 'awaiting-human' | 'completed' | 'blocked' | 'stuck' | 'abandoned' | 'failed' | 'superseded'

export interface AgentRunIoEntry {
  readonly file: string
  readonly direction: 'input' | 'output'
  readonly stage: AgentRunStage
  readonly role: string
  readonly sha256: string
  readonly bytes: number
  /** Set when the same content was already recorded in this run: the file is a pointer, not a second copy. */
  readonly sameAs?: string
}

export interface AgentRunEvidence {
  readonly kind: string
  readonly path: string
  readonly sha256: string
  readonly at: string
}

export interface AgentRunState {
  readonly schemaVersion: typeof AGENT_RUN_SCHEMA_VERSION
  readonly runId: string
  readonly issue: string
  readonly sequence: number
  readonly supersedes: string | null
  readonly openedAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly currentStage: AgentRunStage
  readonly status: AgentRunStatus
  /** Fix rounds sent back to the worker (CI, review, conflict). */
  readonly loopCount: number
  /** The fix-round ceiling frozen at dispatch; null until a worker was dispatched. */
  readonly maxLoopCount: number | null
  /** The last output recorded, relative to the state dir. */
  readonly lastOutput: string | null
  /** What a person has to decide before the run moves again; null when nothing is waiting on a human. */
  readonly nextRequiredApproval: string | null
  readonly pr: number | null
  readonly head: string | null
  readonly dispatches: number
  readonly eventCount: number
  readonly io: readonly AgentRunIoEntry[]
  readonly evidence: readonly AgentRunEvidence[]
  readonly handoffs: readonly string[]
  /** I/O recorded since the last handoff: exactly what the next stage is handed. Flushed into each handoff. */
  readonly pending: readonly string[]
  /** Digest of the last run summary posted on the PR, so an unchanged run is not re-posted. */
  readonly summaryDigest?: string
}

/** Paths recorded in a run are `/`-separated on every OS, so a run reads the same wherever it is opened. */
const relative = (from: string, to: string): string => toPosix(relativePath(from, to))

const StateSchema = z.object({ schemaVersion: z.literal(AGENT_RUN_SCHEMA_VERSION), runId: z.string().min(1), issue: z.string().min(1), sequence: z.number().int(), io: z.array(z.unknown()), evidence: z.array(z.unknown()), handoffs: z.array(z.unknown()), pending: z.array(z.unknown()) }).loose()

export const runsRoot = (stateDir: string): string => join(stateDir, RUNS_DIR)
export const runDirFor = (stateDir: string, runId: string): string => join(runsRoot(stateDir), runId)
const statePathFor = (stateDir: string, runId: string): string => join(runDirFor(stateDir, runId), 'state.json')
const safeIssue = (issue: string): string => issue.replace(/[^A-Za-z0-9._-]/g, '_')
const lockPath = (stateDir: string): string => join(runsRoot(stateDir), '.lock')

let reportedFailure = false
/** A record that failed says so once per process on stderr — the stage report / worker log — instead of vanishing. */
const recordFailed = (what: string, error: unknown): null => {
  if (!reportedFailure) {
    reportedFailure = true
    process.stderr.write(`ak-harness: ${what} failed; runs/ is incomplete from here: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return null
}

const withRunsLock = <T>(stateDir: string, fn: () => T): T => {
  // ponytail: a lock still contended after ~0.5s is written through anyway; the worst case is one lost fold of a
  // local, derived view — never of the event log it is projected from.
  const fd = acquireFileLock(lockPath(stateDir), { attempts: 50 })
  try { return fn() } finally { releaseFileLock(lockPath(stateDir), fd) }
}

export const readAgentRun = (stateDir: string, runId: string): AgentRunState | null => {
  const path = statePathFor(stateDir, runId)
  return existsSync(path) ? readJsonFile(path, StateSchema) as AgentRunState | null : null
}

/** Every run of one issue, oldest first. */
export const listIssueRuns = (stateDir: string, issue: string): readonly AgentRunState[] => {
  const prefix = `${safeIssue(issue)}-`
  let names: readonly string[]
  try { names = readdirSync(runsRoot(stateDir)) } catch { return [] }
  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => readAgentRun(stateDir, name))
    .filter((run): run is AgentRunState => run !== null && run.issue === issue)
    .sort((left, right) => left.sequence - right.sequence)
}

/** Every run on disk, newest activity first, capped at `limit` (windowed). */
export const listAgentRuns = (stateDir: string, limit = 50): readonly AgentRunState[] => {
  let names: readonly string[]
  try { names = readdirSync(runsRoot(stateDir)) } catch { return [] }
  return names
    .filter((name) => !name.startsWith('.'))
    .map((name) => readAgentRun(stateDir, name))
    .filter((run): run is AgentRunState => run !== null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit)
}

export const latestIssueRun = (stateDir: string, issue: string): AgentRunState | null => listIssueRuns(stateDir, issue).at(-1) ?? null

/** Resolve a CLI argument that may be a run id or an issue identifier (its latest run). */
export const resolveAgentRun = (stateDir: string, idOrIssue: string): AgentRunState | null => readAgentRun(stateDir, idOrIssue) ?? latestIssueRun(stateDir, idOrIssue)

const openRun = (stateDir: string, issue: string, at: string, previous: AgentRunState | null): AgentRunState => {
  const sequence = (previous?.sequence ?? 0) + 1
  const runId = `${safeIssue(issue)}-${sequence}`
  const run: AgentRunState = {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION, runId, issue, sequence, supersedes: previous?.runId ?? null,
    openedAt: at, updatedAt: at, closedAt: null, currentStage: 'intake', status: 'running', loopCount: 0, maxLoopCount: null,
    lastOutput: null, nextRequiredApproval: null, pr: null, head: null, dispatches: 0, eventCount: 0, io: [], evidence: [], handoffs: [], pending: [],
  }
  for (const dir of ['inputs', 'outputs', 'handoffs', 'evidence']) mkdirSync(join(runDirFor(stateDir, runId), dir), { recursive: true })
  return run
}

/** Events that start a new run when the issue's latest one is already closed. Anything else that arrives late
 * (a cleanup, a tracker sync) is appended to the closed run rather than opening an empty one. */
const OPENING_EVENTS: ReadonlySet<string> = new Set([
  'ui.run-enqueued', 'intake.filed', 'maintain.filed', 'memory.recalled', 'security.pii-detected', 'provider.call',
  'contract.generated', 'contract.failed', 'contract.escalated', 'plan.voted', 'plan.failed', 'plan.escalated',
  'worker.dispatched', 'worker.reopened', 'human.hitl-requested', 'queue.claim-failed',
])

interface Transition {
  readonly stage?: AgentRunStage
  readonly status?: AgentRunStatus
  /** undefined = leave as is; null = clear. */
  readonly approval?: string | null
  readonly close?: boolean
}

const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(String).join('; ') : ''
// Redacted before clipping: this text reaches `nextRequiredApproval`, and from there the PR comment (runs.prSummary).
const short = (value: string, max = 240): string => { const clean = scanForPii(value).redacted; return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean }

/** The stage machine's view of one event. Pure: the whole projection is this function folded over the log. */
export const classifyRunEvent = (event: Readonly<Record<string, unknown>>): Transition => {
  const type = String(event['type'])
  const reason = short(text(event['reason']) || text(event['reasons']) || text(event['error']) || text(event['unresolved']))
  switch (type) {
    case 'intake.filed': case 'maintain.filed': case 'ui.run-enqueued': return { stage: 'intake' }
    case 'contract.generated': return { stage: 'contract', status: 'running', approval: null }
    case 'contract.failed': return { stage: 'contract', status: 'failed' }
    case 'contract.escalated': return { stage: 'contract', status: 'awaiting-human', approval: `contract: ${reason || 'a human must settle the contract'}` }
    case 'plan.voted': return { stage: 'plan', status: 'running', approval: null }
    case 'plan.failed': return { stage: 'plan', status: 'failed' }
    case 'plan.escalated': return { stage: 'plan', status: 'awaiting-human', approval: `plan: ${reason || 'unresolved objections'}` }
    case 'human.hitl-requested': return { status: 'awaiting-human', approval: `decision: ${short(text(event['question']))}` }
    case 'human.hitl-answered': case 'human.hitl-batch-ready': case 'worker.hitl-resumed': case 'pr.human-approved': return { status: 'running', approval: null }
    case 'worker.dispatched': case 'worker.setup': case 'worker.reactivated': case 'worker.handed-off': case 'worker.nudged': return { stage: 'build', status: 'running' }
    case 'worker.permission-wait': return { stage: 'build', status: 'awaiting-human', approval: `permission prompt in the worker terminal: ${reason}` }
    case 'worker.ci-round': case 'worker.review-round': case 'worker.conflict-round': case 'worker.fix-round': return { stage: 'fix', status: 'running', approval: null }
    case 'verify.passed': return { stage: 'verify' }
    case 'dod.assessed': return { stage: 'dod' }
    case 'pr.reviewed': return { stage: 'review' }
    case 'pr.merge-refused': case 'pr.smoke-failed': case 'pr.merged': return { stage: 'merge' }
    case 'worker.held': case 'worker.needs-input': return { status: 'awaiting-human', approval: `${type === 'worker.held' ? 'held' : 'input'}: ${reason}` }
    case 'worker.waiting': case 'worker.reviewed': return { status: 'running' }
    case 'issue.paused': return { status: 'awaiting-human', approval: `paused: ${reason}` }
    case 'worker.merged': return { stage: 'closed', status: 'completed', approval: null, close: true }
    case 'pr.closed': return { stage: 'closed', status: 'abandoned', approval: 'close the issue for good, or reopen it for a fresh run', close: true }
    case 'worker.abandoned': return { stage: 'closed', status: 'abandoned', close: true }
    case 'worker.blocked': return { stage: 'closed', status: 'blocked', approval: `blocked: ${reason}`, close: true }
    case 'worker.stuck': return { stage: 'closed', status: 'stuck', approval: `stuck: ${reason}`, close: true }
    case 'worker.failed': return { stage: 'closed', status: 'failed', close: true }
    default: return {}
  }
}

const nextFile = (dir: string, name: string): { readonly path: string; readonly n: number } => {
  let n = 1
  try { n = readdirSync(dir).filter((file) => /^\d{2,}-/.test(file)).length + 1 } catch { /* fresh dir */ }
  for (;; n += 1) {
    const path = join(dir, `${String(n).padStart(2, '0')}-${name}`)
    if (!existsSync(path)) return { path, n }
  }
}

const eventFields = (event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'at' && key !== 'type').map(([key, value]) => [key,
    typeof value === 'string' ? short(value, 600)
      : value !== null && typeof value === 'object' ? short(JSON.stringify(value), 600)
        : value]))

/** What the next stage is handed, written by the machine from state it already holds — never by a model. */
const writeHandoff = (stateDir: string, run: AgentRunState, from: AgentRunStage, to: AgentRunStage, event: Readonly<Record<string, unknown>>): AgentRunState => {
  const contract = readStoredContract(stateDir, run.issue)
  const plan = readStoredPlan(stateDir, run.issue)
  const dir = join(runDirFor(stateDir, run.runId), 'handoffs')
  const { path } = nextFile(dir, `${from}-to-${to}.json`)
  writeJsonAtomic(path, {
    runId: run.runId, issue: run.issue, at: String(event['at'] ?? new Date().toISOString()), from, to,
    trigger: { type: event['type'], ...eventFields(event) },
    status: run.status, loopCount: run.loopCount, maxLoopCount: run.maxLoopCount, nextRequiredApproval: run.nextRequiredApproval,
    handed: run.pending.map((file) => run.io.find((entry) => entry.file === file) ?? { file }),
    contract: contract ? { digest: contract.digest, outcomes: contract.contract.outcomes.map((outcome) => outcome.id) } : null,
    plan: plan ? { digest: plan.digest, status: plan.status, unresolved: plan.unresolved } : null,
    evidence: run.evidence.map((item) => ({ kind: item.kind, sha256: item.sha256 })),
  })
  return { ...run, handoffs: [...run.handoffs, relative(runDirFor(stateDir, run.runId), path)], pending: [] }
}

/** Fold one event into its issue's run. Pure except for the handoff file a stage change writes. */
const foldEvent = (stateDir: string, run: AgentRunState, event: Readonly<Record<string, unknown>>): AgentRunState => {
  const at = String(event['at'] ?? new Date().toISOString())
  const type = String(event['type'])
  const transition = classifyRunEvent(event)
  const round = typeof event['round'] === 'number' ? event['round'] : null
  const loopCount = /^worker\.(?:ci|review|conflict)-round$/.test(type) ? Math.max(run.loopCount + 1, round ?? 0) : run.loopCount
  let next: AgentRunState = {
    ...run,
    updatedAt: at,
    eventCount: run.eventCount + 1,
    loopCount,
    ...(type === 'worker.dispatched' ? { dispatches: run.dispatches + 1, ...(typeof event['maxFixRounds'] === 'number' ? { maxLoopCount: event['maxFixRounds'] } : {}) } : {}),
    ...(typeof event['pr'] === 'number' ? { pr: event['pr'] } : {}),
    ...(typeof event['head'] === 'string' ? { head: event['head'] } : {}),
    ...(run.closedAt ? {} : {
      ...(transition.status ? { status: transition.status } : {}),
      ...(transition.approval !== undefined ? { nextRequiredApproval: transition.approval } : {}),
    }),
  }
  if (!run.closedAt && transition.stage && transition.stage !== run.currentStage) {
    next = writeHandoff(stateDir, { ...next, currentStage: transition.stage }, run.currentStage, transition.stage, event)
    next = { ...next, currentStage: transition.stage }
  }
  if (!run.closedAt && transition.close) next = { ...next, closedAt: at }
  if (type === 'pr.reviewed' && typeof event['head'] === 'string') next = addEvidence(next, 'review', join(stateDir, 'issues', run.issue, `review-${event['head'].slice(0, 12)}.json`), stateDir, at)
  return next
}

const addEvidence = (run: AgentRunState, kind: string, absolutePath: string, stateDir: string, at: string): AgentRunState => {
  let content: Buffer
  try { content = readFileSync(absolutePath) } catch { return run }
  const digest = sha256(content)
  if (run.evidence.some((item) => item.sha256 === digest)) return run
  const path = relative(stateDir, absolutePath).startsWith('..') ? absolutePath : relative(stateDir, absolutePath)
  return { ...run, evidence: [...run.evidence, { kind, path, sha256: digest, at }] }
}

const save = (stateDir: string, run: AgentRunState): void => {
  writeJsonAtomic(statePathFor(stateDir, run.runId), run)
  writeJsonAtomic(join(runDirFor(stateDir, run.runId), 'evidence', 'index.json'), run.evidence)
}

/** The run an event (or I/O) for this issue belongs to, opening one when there is none to join. */
const currentRun = (stateDir: string, issue: string, type: string | null, at: string): AgentRunState => {
  const latest = latestIssueRun(stateDir, issue)
  if (!latest) return openRun(stateDir, issue, at, null)
  const redispatch = type === 'worker.dispatched' && latest.dispatches > 0
  if (redispatch && !latest.closedAt) {
    // A second dispatch is a new attempt: close the old one as superseded, never fold two attempts into one run.
    save(stateDir, { ...latest, status: 'superseded', closedAt: at, updatedAt: at })
    return openRun(stateDir, issue, at, latest)
  }
  if (latest.closedAt && (type === null || OPENING_EVENTS.has(type))) return openRun(stateDir, issue, at, latest)
  return latest
}

/** Called for every loop event after it is appended. Events without an issue (stage, release, config) are not run events. */
export const recordRunEvent = (stateDir: string, event: Readonly<Record<string, unknown>>): AgentRunState | null => {
  const issue = event['issue']
  if (typeof issue !== 'string' || !issue.trim()) return null
  try {
    return withRunsLock(stateDir, () => {
      const at = String(event['at'] ?? new Date().toISOString())
      const run = foldEvent(stateDir, currentRun(stateDir, issue, String(event['type']), at), event)
      save(stateDir, run)
      return run
    })
  } catch (error) { return recordFailed('recording a run event', error) }
}

export interface RunIoInput {
  readonly direction: 'input' | 'output'
  readonly stage: AgentRunStage
  /** Who produced or received it: orchestrator, planner, voter, worker, reviewer. */
  readonly role: string
  readonly content: string
  readonly extension?: 'md' | 'json' | 'txt'
  /** Byte ceiling: an input keeps its head, an output its tail (the end of a log is where it failed). */
  readonly maxBytes?: number
}

export const DEFAULT_RUN_IO_MAX_BYTES = 256 * 1024

/**
 * Record what one step was handed or produced, redacted before it touches disk. digest: identical content already
 * in this run is written once; a second occurrence under another name is a pointer file. The same content for the
 * same stage and role (a deliver pass re-reading an unchanged `verify.json`) is not recorded again at all.
 */
export const recordRunIo = (stateDir: string, issue: string, input: RunIoInput, now: () => Date = () => new Date()): AgentRunIoEntry | null => {
  if (!issue.trim() || !input.content) return null
  try {
    return withRunsLock(stateDir, () => {
      const at = now().toISOString()
      const run = currentRun(stateDir, issue, null, at)
      const max = input.maxBytes ?? DEFAULT_RUN_IO_MAX_BYTES
      const redacted = scanForPii(input.content).redacted
      const bounded = redacted.length <= max ? redacted : input.direction === 'input' ? `${redacted.slice(0, max)}\n…[truncated ${redacted.length - max} chars]` : `…[truncated ${redacted.length - max} chars]\n${redacted.slice(-max)}`
      const digest = sha256(bounded)
      const same = run.io.find((entry) => entry.sha256 === digest && !entry.sameAs)
      if (same && same.direction === input.direction && same.stage === input.stage && same.role === input.role) return same
      const dir = join(runDirFor(stateDir, run.runId), input.direction === 'input' ? 'inputs' : 'outputs')
      const name = `${input.stage}-${input.role}`
      const target = same ? nextFile(dir, `${name}.ref.json`) : nextFile(dir, `${name}.${input.extension ?? 'md'}`)
      if (same) writeJsonAtomic(target.path, { sha256: digest, sameAs: same.file })
      else writeFileSync(target.path, bounded, 'utf8')
      const file = relative(runDirFor(stateDir, run.runId), target.path)
      const entry: AgentRunIoEntry = { file, direction: input.direction, stage: input.stage, role: input.role, sha256: digest, bytes: Buffer.byteLength(bounded), ...(same ? { sameAs: same.file } : {}) }
      save(stateDir, {
        ...run, updatedAt: at, io: [...run.io, entry], pending: [...run.pending, file],
        ...(input.direction === 'output' ? { lastOutput: relative(stateDir, target.path) } : {}),
      })
      return entry
    })
  } catch (error) { return recordFailed('recording run I/O', error) }
}

/** Link a proof file (verify.json, the DoD evidence) into the run by hash; the file itself stays where it is. */
export const recordRunEvidence = (stateDir: string, issue: string, kind: string, path: string, now: () => Date = () => new Date()): void => {
  if (!issue.trim() || !existsSync(path)) return
  try {
    withRunsLock(stateDir, () => {
      const at = now().toISOString()
      const run = currentRun(stateDir, issue, null, at)
      const next = addEvidence(run, kind, path, stateDir, at)
      if (next !== run) save(stateDir, { ...next, updatedAt: at })
    })
  } catch (error) { recordFailed('linking run evidence', error) }
}

export const markRunSummaryPosted = (stateDir: string, runId: string, digest: string): void => {
  try {
    withRunsLock(stateDir, () => {
      const run = readAgentRun(stateDir, runId)
      if (run) save(stateDir, { ...run, summaryDigest: digest })
    })
  } catch (error) { recordFailed('marking the run summary posted', error) }
}

/**
 * windowed: keep the newest `keep` runs per issue, and drop closed runs older than `maxAgeDays`. The run an issue
 * is currently in is never pruned, whatever its age.
 */
export const pruneAgentRuns = (stateDir: string, options: { readonly keep: number; readonly maxAgeDays: number; readonly now?: Date }): readonly string[] => {
  const nowMs = (options.now ?? new Date()).getTime()
  let names: readonly string[]
  try { names = readdirSync(runsRoot(stateDir)) } catch { return [] }
  const runs = names.filter((name) => !name.startsWith('.')).map((name) => readAgentRun(stateDir, name)).filter((run): run is AgentRunState => run !== null)
  const byIssue = new Map<string, AgentRunState[]>()
  for (const run of runs) byIssue.set(run.issue, [...(byIssue.get(run.issue) ?? []), run])
  const removed: string[] = []
  for (const list of byIssue.values()) {
    const ordered = [...list].sort((left, right) => right.sequence - left.sequence)
    ordered.forEach((run, index) => {
      if (index === 0 && !run.closedAt) return
      const expired = run.closedAt !== null && nowMs - Date.parse(run.closedAt) > options.maxAgeDays * 86_400_000
      if (index >= Math.max(1, options.keep) || expired) {
        try { rmSync(runDirFor(stateDir, run.runId), { recursive: true, force: true }); removed.push(run.runId) } catch { /* best-effort */ }
      }
    })
  }
  return removed
}

export interface AgentRunReport {
  readonly state: AgentRunState
  readonly dir: string
  readonly handoffs: readonly Readonly<Record<string, unknown>>[]
}

/** Everything on disk for one run, for `loop run show`. The event-level timeline is `loop issue-timeline`. */
export const readAgentRunReport = (stateDir: string, idOrIssue: string): AgentRunReport | null => {
  const state = resolveAgentRun(stateDir, idOrIssue)
  if (!state) return null
  const dir = runDirFor(stateDir, state.runId)
  const handoffs = state.handoffs.map((file) => readJsonFile(join(dir, file), z.record(z.string(), z.unknown())) ?? { file, unreadable: true })
  return { state, dir, handoffs }
}

export const renderAgentRunMarkdown = (report: AgentRunReport): string => {
  const { state } = report
  const lines = [
    `# Run ${state.runId}`,
    '',
    `- issue: ${state.issue}${state.supersedes ? ` (supersedes ${state.supersedes})` : ''}`,
    `- stage: ${state.currentStage} · status: ${state.status}`,
    `- fix rounds: ${state.loopCount}${state.maxLoopCount === null ? '' : `/${state.maxLoopCount}`}`,
    `- next required approval: ${state.nextRequiredApproval ?? 'none'}`,
    ...(state.pr === null ? [] : [`- PR: #${state.pr}${state.head ? ` at ${state.head.slice(0, 12)}` : ''}`]),
    `- opened ${state.openedAt}${state.closedAt ? ` · closed ${state.closedAt}` : ''}`,
    '',
    '## Steps',
    '',
    ...(report.handoffs.length ? report.handoffs.map((handoff, index) => `${index + 1}. ${String(handoff['from'])} → ${String(handoff['to'])} (${String((handoff['trigger'] as Record<string, unknown> | undefined)?.['type'] ?? '?')})`) : ['- none yet']),
    '',
    '## Inputs and outputs',
    '',
    ...(state.io.length ? state.io.map((entry) => `- ${entry.file} — ${entry.role}, ${entry.bytes} B${entry.sameAs ? `, same as ${entry.sameAs}` : ''}`) : ['- none recorded']),
    '',
    '## Evidence',
    '',
    ...(state.evidence.length ? state.evidence.map((item) => `- ${item.kind}: ${item.path} (sha256 ${item.sha256.slice(0, 12)})`) : ['- none linked']),
  ]
  return `${lines.join('\n')}\n`
}

export const runSummaryMarker = (issue: string): string => `<!-- loop:run-summary:${issue} -->`

/**
 * The run as a PR reader needs it: where it stands, what each stage handed the next, and the evidence by hash.
 * Built from the run on disk only, so the same run renders the same body and an unchanged run is never re-posted.
 */
export const renderRunSummaryMarkdown = (report: AgentRunReport): string => {
  const { state } = report
  const rows = report.handoffs.map((handoff, index) => {
    const trigger = (handoff['trigger'] as Record<string, unknown> | undefined) ?? {}
    const handed = Array.isArray(handoff['handed']) ? handoff['handed'].length : 0
    return `| ${index + 1} | ${String(handoff['from'])} → ${String(handoff['to'])} | \`${String(trigger['type'] ?? '?')}\` | ${handed} | ${String(handoff['at'] ?? '').slice(0, 19).replace('T', ' ')} |`
  })
  return [
    `**Loop run \`${state.runId}\`** — stage \`${state.currentStage}\`, status \`${state.status}\`, fix rounds ${state.loopCount}${state.maxLoopCount === null ? '' : `/${state.maxLoopCount}`}${state.supersedes ? `, supersedes \`${state.supersedes}\`` : ''}`,
    ...(state.nextRequiredApproval ? ['', `**Waiting on a human:** ${state.nextRequiredApproval}`] : []),
    '',
    '<details><summary>How this was built</summary>',
    '',
    '| # | Handoff | Trigger | Items handed | At (UTC) |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| – | none yet | | | |']),
    '',
    `Inputs/outputs recorded: ${state.io.length}. Evidence: ${state.evidence.length ? state.evidence.map((item) => `${item.kind} \`${item.sha256.slice(0, 12)}\``).join(', ') : 'none linked yet'}.`,
    '',
    `Reconstruct locally: \`ak-harness loop run show ${state.runId}\``,
    '',
    '</details>',
    '',
    runSummaryMarker(state.issue),
  ].join('\n')
}
