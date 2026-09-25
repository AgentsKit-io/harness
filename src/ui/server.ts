import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { listDispatched, markDispatchCancelled, readDeliveryState } from '../loop/deliver.js'
import { loadLoopConfig, type LoadedLoopConfig } from '../loop/config.js'
import { readLoopEvents, type LoopEvent } from '../loop/retro.js'
import type { DispatchRecordFile } from '../loop/tick.js'
import { hashJson } from '../kernel/hash.js'
import { createProcessRunner } from '../loop/process.js'
import { createIssueBoardCache, createIssueBoardReader, type BoardSnapshot, type IssueBoardCache } from './board.js'
import { parseUiAction } from './actions.js'
import { createUiJobManager, UiJobConflictError, type UiJobManager, type UiJobRecord } from './jobs.js'
import { createIssueQueue, type EnqueueIssueRunInput, type IssueQueue, type IssueRun } from '../loop/queue.js'
import { createInboxStore, type InboxItem, type InboxStore } from '../loop/inbox.js'
import { createLifecycleStore, type IssueLifecycle } from '../loop/lifecycle.js'
import { parseModelRef, type ModelReference } from '../loop/config.js'
import { runTick } from '../loop/tick.js'
import { createDispatchLedger } from '../execution/coordination.js'
import { orcaTerminalClose, orcaWorktreeRemove } from '../adapters/orca-cli.js'
import { resolveConnectors } from '../loop/connectors.js'
import { contractIsFresh, readStoredContract, type StoredContract } from '../loop/contract.js'
import { detectProviders } from '../adapters/providers.js'
import { providerSpecs } from '../loop/doctor.js'
import { rankModels } from '../loop/routing.js'
import { renderIssueFirstHtml } from './render.js'
import { createUiWizardStore, parseUiWizardDraftPatch, type UiWizardStore } from './wizard.js'

const UI_SCHEMA_VERSION = 2 as const
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4321
const DEFAULT_WINDOW_HOURS = 24
const POLL_INTERVAL_MS = 1_000
const SESSION_HEADER = 'x-harness-session'
const MAX_RECENT_EVENTS = 80
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/

export interface UiIssueSnapshot {
  readonly issue: string
  readonly phase: string
  readonly outcome: string
  readonly provider: string | null
  readonly model: string | null
  readonly branch: string | null
  readonly worktree: string | null
  readonly dispatchedAt: string | null
  readonly finishedAt: string | null
  readonly fixRounds: number
  readonly pr: number | null
  readonly lastEvent: string | null
  readonly heldFor: string | null
}

export interface UiEventSnapshot {
  readonly at: string
  readonly type: string
  readonly issue: string | null
  readonly detail: string
}

export interface UiSnapshot {
  readonly schemaVersion: typeof UI_SCHEMA_VERSION
  readonly generatedAt: string
  readonly windowHours: number
  readonly project: {
    readonly name: string
    readonly repo: string
    readonly baseBranch: string
    readonly root: string
    readonly stateDir: string
    readonly configHash: string
  }
  readonly summary: {
    readonly totalIssues: number
    readonly inFlight: number
    readonly held: number
    readonly completed: number
    readonly blocked: number
    readonly eventCount: number
  }
  readonly issues: readonly UiIssueSnapshot[]
  readonly events: readonly UiEventSnapshot[]
  readonly board: BoardSnapshot | null
  readonly jobs: readonly UiJobRecord[]
  /** Issue-first projection. Optional in the type for compatibility with pre-queue consumers. */
  readonly availableIssues?: readonly (BoardSnapshot['issues'][number] & { readonly error?: string | null; readonly runId?: string | null })[]
  readonly runs?: readonly IssueRun[]
  readonly inbox?: readonly InboxItem[]
  readonly inboxUnread?: number
  readonly executingRuns?: readonly IssueRun[]
  readonly reviewIssues?: readonly IssueLifecycle[]
  readonly blockedRuns?: readonly IssueRun[]
  readonly historyRuns?: readonly IssueRun[]
  readonly archived?: readonly IssueRun[]
  readonly capacity?: { readonly maxAgents: number; readonly running: number; readonly free: number }
}

export interface UiSnapshotInput {
  readonly loaded: Pick<LoadedLoopConfig, 'root' | 'stateDir' | 'config' | 'configHash'>
  readonly now?: Date
  readonly windowHours?: number
  readonly board?: BoardSnapshot | null
  readonly jobs?: readonly UiJobRecord[]
  readonly queue?: IssueQueue
  readonly inbox?: InboxStore
}

export interface UiServerOptions {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly host?: string
  readonly port?: number
  readonly windowHours?: number
  /** Test seam and an adapter point for future persisted projections. */
  readonly snapshot?: (force?: boolean) => UiSnapshot | Promise<UiSnapshot>
  /** Optional board cache seam; production creates exactly the provider selected by the config. */
  readonly board?: IssueBoardCache
  readonly jobs?: UiJobManager
  readonly queue?: IssueQueue
  readonly inbox?: InboxStore
  readonly wizard?: UiWizardStore
}

export interface UiServerHandle {
  readonly url: string
  readonly token: string
  readonly close: () => Promise<void>
}

export interface UiStartIssueRequest {
  readonly issue: string
  readonly configHash?: string
  readonly flow?: string | null
  readonly builder: string
  readonly contractDigest: string
  readonly maxFixRounds?: number
  readonly perIssueTokens?: number
  readonly preflight: boolean
}

export interface UiRunCancelRequest {
  readonly confirmActive?: boolean
}

export interface UiRunCleanupRequest {
  readonly confirmCleanup?: boolean
}

export interface UiInboxResolutionRequest {
  readonly actor: string
  readonly action: string
  readonly data?: Readonly<Record<string, unknown>>
}

const detailOf = (event: LoopEvent): string => {
  if (typeof event['reason'] === 'string') return event['reason']
  if (typeof event['error'] === 'string') return event['error']
  if (typeof event['message'] === 'string') return event['message']
  if (typeof event['status'] === 'string') return event['status']
  return event.type
}

const issueId = (value: unknown): string | null => typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null

const phaseFor = (dispatch: DispatchRecordFile | null, outcome: string, heldFor: string | null, events: readonly LoopEvent[]): string => {
  if (outcome !== 'in-flight') return outcome
  if (heldFor) return 'held'
  const last = events.at(-1)?.type
  if (last?.startsWith('worker.')) return last.slice('worker.'.length)
  return dispatch ? 'dispatched' : 'observed'
}

const outcomeFor = (dispatch: DispatchRecordFile | null, delivery: ReturnType<typeof readDeliveryState>): string => {
  if (delivery.cancelledAt) return 'cancelled'
  if (delivery.finalOutcome) return delivery.finalOutcome
  if (delivery.heldFor) return 'held'
  return dispatch ? 'in-flight' : 'observed'
}

const issueSnapshot = (stateDir: string, issue: string, dispatch: DispatchRecordFile | null, events: readonly LoopEvent[]): UiIssueSnapshot => {
  const delivery = readDeliveryState(stateDir, issue)
  const outcome = outcomeFor(dispatch, delivery)
  return {
    issue,
    phase: phaseFor(dispatch, outcome, delivery.heldFor, events),
    outcome,
    provider: dispatch?.provider ?? null,
    model: dispatch?.model ?? null,
    branch: dispatch?.branch ?? null,
    worktree: dispatch?.worktreePath ?? dispatch?.worktree ?? null,
    dispatchedAt: dispatch?.dispatchedAt ?? null,
    finishedAt: delivery.finishedAt,
    fixRounds: delivery.fixRounds,
    pr: delivery.prNumber,
    lastEvent: events.at(-1)?.type ?? null,
    heldFor: delivery.heldFor,
  }
}

/**
 * Build the read model consumed by the local UI.
 *
 * The module deliberately reads the existing loop projection and does not create a second execution model. The
 * bounded event window is part of the interface: the UI is an operational view, not an archive browser.
 */
export const createUiSnapshot = (input: UiSnapshotInput): UiSnapshot => {
  const now = input.now ?? new Date()
  const windowHours = Math.max(1, input.windowHours ?? DEFAULT_WINDOW_HOURS)
  const sinceMs = now.getTime() - windowHours * 60 * 60 * 1_000
  const events = readLoopEvents(input.loaded.stateDir, sinceMs).filter((event) => {
    const at = Date.parse(event.at)
    return Number.isFinite(at) && at >= sinceMs && at <= now.getTime()
  })
  const queue = input.queue ?? createIssueQueue({ stateDir: input.loaded.stateDir })
  const inbox = input.inbox ?? createInboxStore(input.loaded.stateDir)
  const lifecycle = createLifecycleStore(input.loaded.stateDir)
  // windowed: Inbox projection only needs the recent decision-producing events, never the append-only log in full.
  inbox.syncEvents(events.slice(-MAX_RECENT_EVENTS))
  const dispatches = listDispatched(input.loaded.stateDir)
  const dispatchByIssue = new Map(dispatches.map((dispatch) => [dispatch.issue, dispatch]))
  const eventIssues = events.map((event) => issueId(event['issue'])).filter((value): value is string => value !== null)
  const queueRuns = queue.list()
  const issueIds = [...new Set([...input.board?.issues.map((issue) => issue.identifier) ?? [], ...queueRuns.map((run) => run.issue), ...dispatches.map((dispatch) => dispatch.issue), ...eventIssues, ...lifecycle.list().map((issue) => issue.issue)])]
  const issueEvents = new Map<string, LoopEvent[]>()
  for (const event of events) {
    const issue = issueId(event['issue'])
    if (!issue) continue
    const current = issueEvents.get(issue) ?? []
    current.push(event)
    issueEvents.set(issue, current)
  }
  // This is a read-model reconciliation only. Legacy dispatch/delivery files are observed and never replayed.
  for (const issue of issueIds) {
    const boardIssue = input.board?.issues.find((candidate) => candidate.identifier === issue)
    const latestRun = queue.getLatestByIssue(issue)
    const delivery = readDeliveryState(input.loaded.stateDir, issue)
    const dispatch = dispatchByIssue.get(issue)
    const eventList = issueEvents.get(issue) ?? []
    const prior = lifecycle.get(issue)
    const trackerPhase = boardIssue?.lane === 'review' ? 'review' : boardIssue?.lane === 'blocked' ? 'blocked' : boardIssue?.lane === 'todo' ? 'available' : undefined
    // Local run/delivery evidence outranks a stale board lane. A remote sync failure can leave the tracker in Todo
    // while the local PR is already in review; projecting the board lane unconditionally would move that issue back.
    const boardFallbackPhase = latestRun || dispatch || delivery.finalOutcome || delivery.prNumber ? undefined : trackerPhase
    lifecycle.upsert({
      issue,
      ...(boardFallbackPhase ? { phase: boardFallbackPhase as IssueLifecycle['phase'] } : {}),
      ...(boardIssue ? { title: boardIssue.title, url: boardIssue.url, trackerState: boardIssue.state } : {}),
      ...(latestRun ? { runId: latestRun.id, runStatus: latestRun.status, stage: latestRun.projection.stage, ...(latestRun.error ? { error: latestRun.error } : {}) } : {}),
      ...(dispatch && !latestRun ? { runStatus: delivery.finishedAt ? 'completed' : delivery.prNumber ? 'completed' : 'running', runId: null, stage: delivery.finalOutcome === 'abandoned' ? 'pr-closed' : delivery.finalOutcome === 'merged' ? 'merged' : delivery.prNumber ? 'pr-open' : 'running' } : {}),
      ...(delivery.finalOutcome ? { deliveryOutcome: delivery.finalOutcome } : {}),
      ...(delivery.prNumber ? { pullRequest: { number: delivery.prNumber, state: delivery.finalOutcome === 'merged' ? 'MERGED' as const : delivery.finalOutcome === 'abandoned' ? 'CLOSED' as const : 'OPEN' as const } } : {}),
      ...(latestRun?.projection.pullRequest && !delivery.finalOutcome ? { pullRequest: { number: latestRun.projection.pullRequest, state: prior?.pullRequest?.state ?? 'OPEN' as const } } : {}),
      ...(trackerPhase && !latestRun && !dispatch ? { stage: trackerPhase } : {}),
      ...(latestRun?.status === 'failed' ? { technicalFailure: true } : {}),
      ...(latestRun?.status === 'needs-input' ? { finalFailure: latestRun.projection.stage === 'cleanup-failed' || prior?.phase === 'blocked' } : {}),
      events: eventList as readonly { readonly type: string; readonly at?: string; readonly [key: string]: unknown }[],
      now,
    })
  }
  const lifecycleRows = lifecycle.list()
  const issues = issueIds
    .map((issue) => issueSnapshot(input.loaded.stateDir, issue, dispatchByIssue.get(issue) ?? null, issueEvents.get(issue) ?? []))
    .sort((left, right) => (right.dispatchedAt ?? right.issue).localeCompare(left.dispatchedAt ?? left.issue))
  const completed = issues.filter((issue) => ['merged', 'reviewed', 'completed'].includes(issue.outcome)).length
  const blocked = issues.filter((issue) => ['blocked', 'stuck', 'abandoned', 'failed'].includes(issue.outcome)).length
  const held = issues.filter((issue) => issue.outcome === 'held').length
  const inFlight = issues.filter((issue) => issue.outcome === 'in-flight').length
  const recentEvents = [...events]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, MAX_RECENT_EVENTS)
    .map((event) => ({ at: event.at, type: event.type, issue: issueId(event['issue']), detail: detailOf(event) }))
  return {
    schemaVersion: UI_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    windowHours,
    project: {
      name: input.loaded.config.project.name,
      repo: input.loaded.config.project.repo,
      baseBranch: input.loaded.config.project.baseBranch,
      root: input.loaded.root,
      stateDir: input.loaded.stateDir,
      configHash: input.loaded.configHash,
    },
    summary: { totalIssues: issues.length, inFlight, held, completed, blocked, eventCount: events.length },
    issues,
    events: recentEvents,
    board: input.board ?? null,
    jobs: input.jobs ?? [],
    availableIssues: (() => {
      const activeIssues = new Set(queueRuns.filter((run) => ['queued', 'dispatching', 'running'].includes(run.status)).map((run) => run.issue))
      const boardAvailable = (input.board?.issues ?? []).filter((issue) => !activeIssues.has(issue.identifier) && ['todo', 'unclassified'].includes(issue.lane) && (lifecycleRows.find((item) => item.issue === issue.identifier)?.phase ?? 'available') === 'available').map((issue) => {
        const local = lifecycleRows.find((item) => item.issue === issue.identifier)
        return { ...issue, ...(local?.error ? { error: local.error } : {}), ...(local?.runId ? { runId: local.runId } : {}) }
      })
      const projected = lifecycleRows.filter((item) => item.phase === 'available' && !boardAvailable.some((issue) => issue.identifier === item.issue)).map((item) => ({ identifier: item.issue, title: item.title ?? item.issue, url: item.url ?? '', state: item.trackerState ?? 'Available', lane: 'todo' as const, labels: [], assignees: [], createdAt: item.updatedAt, updatedAt: item.updatedAt, ...(item.error ? { error: item.error } : {}), runId: item.runId }))
      return [...boardAvailable, ...projected]
    })(),
    runs: queueRuns,
    inbox: inbox.list({ status: 'open' }),
    inboxUnread: inbox.unreadCount(),
    executingRuns: queueRuns.filter((run) => !run.archived && ['queued', 'dispatching', 'running'].includes(run.status)),
    reviewIssues: lifecycleRows.filter((item) => item.phase === 'review'),
    blockedRuns: queueRuns.filter((run) => !run.archived && lifecycleRows.some((item) => item.issue === run.issue && item.phase === 'blocked' && item.runId === run.id)),
    historyRuns: queueRuns.filter((run) => !run.archived && ['completed', 'failed', 'cancelled'].includes(run.status)),
    archived: queueRuns.filter((run) => run.archived),
    capacity: { maxAgents: input.loaded.config.machine?.ceiling ?? input.loaded.config.machine?.floor ?? 1, running: dispatches.filter((dispatch) => !readDeliveryState(input.loaded.stateDir, dispatch.issue).finishedAt).length, free: Math.max(0, (input.loaded.config.machine?.ceiling ?? input.loaded.config.machine?.floor ?? 1) - dispatches.filter((dispatch) => !readDeliveryState(input.loaded.stateDir, dispatch.issue).finishedAt).length) },
  }
}

const json = (value: unknown): string => JSON.stringify(value)

const uiCss = `
:root {
  --ag-font-body: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --ag-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ag-surface: #08090b; --ag-surface-alt: #111216; --ag-surface-dim: #0c0d11;
  --ag-panel: #15161b; --ag-panel-alt: #1b1c22; --ag-line: rgba(255,255,255,.12);
  --ag-line-soft: rgba(255,255,255,.08); --ag-line-ghost: rgba(255,255,255,.05);
  --ag-ink: #f5f5f7; --ag-ink-muted: #a1a1aa; --ag-ink-subtle: #8a8a92;
  --ag-accent: #34d399; --ag-accent-dim: rgba(52,211,153,.14); --ag-ink-on-accent: #0a0a0a;
  --ag-success: #30d158; --ag-success-dim: rgba(48,209,88,.14); --ag-warning: #ffd60a;
  --ag-warning-dim: rgba(255,214,10,.14); --ag-danger: #ff453a; --ag-danger-dim: rgba(255,69,58,.14);
  --ag-info: #0a84ff; --ag-radius-sm: 6px; --ag-radius-md: 10px; --ag-radius-lg: 14px;
  --ag-shadow-1: 0 1px 2px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.22);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; color: var(--ag-ink); background: var(--ag-surface); font-family: var(--ag-font-body); font-size: 13px; }
button { font: inherit; }
.shell { min-height: 100vh; display: grid; grid-template-columns: 232px 1fr; }
.rail { padding: 28px 18px; border-right: 1px solid var(--ag-line-soft); background: var(--ag-surface-dim); }
.brand { display: flex; align-items: center; gap: 10px; margin: 0 8px 48px; font-weight: 700; letter-spacing: -.02em; }
.brand-mark { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; color: var(--ag-ink-on-accent); background: var(--ag-accent); font-weight: 900; }
.rail-label { margin: 0 8px 10px; color: var(--ag-ink-subtle); font-size: 10px; text-transform: uppercase; letter-spacing: .12em; }
.rail-item { width: 100%; padding: 9px 10px; border: 0; border-radius: var(--ag-radius-sm); color: var(--ag-ink-muted); background: transparent; text-align: left; }
.rail-item.active { color: var(--ag-ink); background: var(--ag-accent-dim); }
.main { width: min(1440px, 100%); padding: 32px 42px 56px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 30px; }
.eyebrow { margin: 0 0 8px; color: var(--ag-accent); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .14em; }
h1 { margin: 0; font-size: clamp(24px, 3vw, 34px); letter-spacing: -.04em; }
.muted { color: var(--ag-ink-muted); }
.mono { font-family: var(--ag-font-mono); }
.refresh { border: 1px solid var(--ag-line); border-radius: var(--ag-radius-sm); padding: 9px 13px; color: var(--ag-ink); background: var(--ag-panel); cursor: pointer; }
.refresh:hover { border-color: var(--ag-accent); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.issue-first { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.issue-first .section { min-height: 180px; }
.wizard { border-color: rgba(52,211,153,.35); }
.wizard .action-form { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.advanced summary { cursor: pointer; list-style: none; }
.advanced summary::-webkit-details-marker { display: none; }
.run-card, .inbox-card, .available-card { padding: 13px 0; border-bottom: 1px solid var(--ag-line-ghost); }
.run-card:last-child, .inbox-card:last-child, .available-card:last-child { border-bottom: 0; }
.run-title { display: flex; justify-content: space-between; gap: 8px; font-weight: 650; }
.run-meta { margin-top: 6px; color: var(--ag-ink-muted); font-size: 11px; }
.run-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.run-actions button { padding: 5px 8px; color: var(--ag-ink); border: 1px solid var(--ag-line); border-radius: var(--ag-radius-sm); background: var(--ag-panel-alt); cursor: pointer; }
.card { border: 1px solid var(--ag-line-soft); border-radius: var(--ag-radius-md); background: var(--ag-panel); box-shadow: var(--ag-shadow-1); }
.metric { padding: 18px; }
.metric-label { color: var(--ag-ink-muted); font-size: 11px; }
.metric-value { margin-top: 8px; font-size: 27px; font-weight: 700; letter-spacing: -.04em; }
.metric-value.accent { color: var(--ag-accent); } .metric-value.warn { color: var(--ag-warning); } .metric-value.danger { color: var(--ag-danger); }
.section-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr); gap: 14px; margin-top: 14px; }
.section { overflow: hidden; } .section-head { display: flex; justify-content: space-between; align-items: baseline; padding: 17px 18px; border-bottom: 1px solid var(--ag-line-ghost); }
.section-title { margin: 0; font-size: 14px; } .section-body { padding: 0 18px; }
.issue { display: grid; grid-template-columns: minmax(100px, 1.1fr) 100px 100px minmax(0, 1fr); gap: 14px; align-items: center; padding: 15px 0; border-bottom: 1px solid var(--ag-line-ghost); }
.issue:last-child { border-bottom: 0; } .issue-id { font-weight: 650; } .issue-meta { min-width: 0; color: var(--ag-ink-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { display: inline-flex; width: fit-content; padding: 4px 8px; border-radius: 999px; color: var(--ag-ink-muted); background: var(--ag-surface-alt); font-size: 10px; font-family: var(--ag-font-mono); }
.pill.ok { color: var(--ag-success); background: var(--ag-success-dim); } .pill.warn { color: var(--ag-warning); background: var(--ag-warning-dim); } .pill.bad { color: var(--ag-danger); background: var(--ag-danger-dim); }
.timeline { max-height: 390px; overflow: auto; } .event { display: grid; grid-template-columns: 135px minmax(130px, .75fr) minmax(0, 1fr); gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--ag-line-ghost); font-size: 11px; }
.event:last-child { border-bottom: 0; } .event-type { color: var(--ag-accent); font-family: var(--ag-font-mono); } .event-detail { color: var(--ag-ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project { padding: 18px; } .project-row { display: flex; justify-content: space-between; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--ag-line-ghost); } .project-row:last-child { border: 0; }
.empty { padding: 34px 0; color: var(--ag-ink-muted); text-align: center; } .error { margin-top: 14px; padding: 14px; color: #ffd8d5; border: 1px solid rgba(255,69,58,.4); border-radius: var(--ag-radius-sm); background: var(--ag-danger-dim); }
.board-issue { padding: 15px 0; border-bottom: 1px solid var(--ag-line-ghost); } .board-issue:last-child { border-bottom: 0; }
.board-link { color: var(--ag-ink); text-decoration: none; font-weight: 650; } .board-link:hover { color: var(--ag-accent); }
.board-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 7px; color: var(--ag-ink-muted); font-size: 11px; }
.board-label, .board-lane { padding: 3px 6px; border-radius: 999px; color: var(--ag-ink-muted); background: var(--ag-surface-alt); font-family: var(--ag-font-mono); font-size: 10px; }
.action-form { display: grid; grid-template-columns: 150px minmax(100px, 1fr) minmax(100px, 1fr) auto; gap: 8px; padding: 18px; }
.action-form input, .action-form select { min-width: 0; padding: 9px 10px; color: var(--ag-ink); border: 1px solid var(--ag-line); border-radius: var(--ag-radius-sm); background: var(--ag-surface-alt); }
.action-form button, .job-button { padding: 9px 12px; color: var(--ag-ink-on-accent); border: 0; border-radius: var(--ag-radius-sm); background: var(--ag-accent); cursor: pointer; }
.job { display: grid; grid-template-columns: minmax(130px, 1fr) 110px 100px minmax(0, 1.5fr) auto; gap: 10px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--ag-line-ghost); font-size: 11px; }
.job:last-child { border-bottom: 0; } .job-id { font-family: var(--ag-font-mono); color: var(--ag-accent); overflow: hidden; text-overflow: ellipsis; }
.job-button { padding: 5px 8px; color: var(--ag-ink); background: var(--ag-panel-alt); border: 1px solid var(--ag-line); }
@media (max-width: 1100px) { .issue-first { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .rail { display: none; } .main { padding: 24px 18px 42px; } .grid, .issue-first { grid-template-columns: repeat(2, minmax(0,1fr)); } .section-grid { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .action-form { grid-template-columns: 1fr; } .job { grid-template-columns: 1fr 1fr; gap: 6px; } }
@media (max-width: 560px) { .topbar { display: block; } .refresh { margin-top: 16px; } .issue { grid-template-columns: 1fr 1fr; gap: 8px; } .event { grid-template-columns: 1fr; gap: 4px; } }
`

const uiScript = `
const token = window.__HARNESS_SESSION__;
const href = (value) => /^https?:\\/\\//i.test(String(value ?? '')) ? esc(value) : '#';
const esc = (value) => String(value ?? '').replace(/[&<>\"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[char]));
const date = (value) => value ? new Date(value).toLocaleString() : '—';
const pill = (value) => { const text = String(value ?? 'unknown'); const tone = ['merged','reviewed','completed'].includes(text) ? 'ok' : ['blocked','stuck','failed','abandoned'].includes(text) ? 'bad' : ['held','in-flight'].includes(text) ? 'warn' : ''; return '<span class="pill '+tone+'">'+esc(text)+'</span>'; };
const uiForm = document.querySelector('#action-form');
const extraTypes = [['loop.debrief','Debrief'],['loop.timeline','Timeline de issue'],['loop.precheck','Precheck'],['issue.labels','Atualizar labels']];
const typeSelect = uiForm.querySelector('select[name="type"]');
extraTypes.forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; typeSelect.appendChild(option); });
const submitButton = uiForm.querySelector('button[type="submit"]');
[['max','Máx. dispatches'],['add','Labels para adicionar (a,b)'],['remove','Labels para remover (a,b)']].forEach(([name, placeholder]) => { const input = document.createElement('input'); input.name = name; input.placeholder = placeholder; uiForm.insertBefore(input, submitButton); });
[['dryRun','dry-run'],['refresh','refresh'],['skipContract','ignorar contrato'],['probe','sondar providers'],['acceptObjections','aceitar objeções']].forEach(([name, labelText]) => { const label = document.createElement('label'); label.className = 'muted'; label.innerHTML = '<input type="checkbox" name="'+name+'"> '+labelText; uiForm.insertBefore(label, submitButton); });
const api = (path, options = {}) => fetch(path, { ...options, headers: { 'x-harness-session': token, ...(options.headers || {}) } }).then(async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(body.error || 'Harness UI request failed ('+response.status+')'); error.body = body; throw error; } return body; });
const wizard = document.querySelector('#issue-wizard');
const issueValue = () => String(wizard?.querySelector('[name="issue"]')?.value || '').trim();
const fillWizard = (data) => { const flow = wizard.querySelector('[name="flow"]'); const builder = wizard.querySelector('[name="builder"]'); flow.innerHTML = '<option value="">Flow do projeto</option>'+(data.flows || []).map((item) => '<option value="'+esc(item)+'">'+esc(item)+'</option>').join(''); if (data.defaultFlow) flow.value = data.defaultFlow; builder.innerHTML = '<option value="">Modelo builder</option>'+(data.builderModels || []).map((item) => { const value = item.provider+'/'+item.model; return '<option value="'+esc(value)+'">'+esc(value)+'</option>'; }).join(''); if (data.builderModels?.[0]) builder.value = data.builderModels[0].provider+'/'+data.builderModels[0].model; if (data.contract?.digest) wizard.querySelector('[name="contractDigest"]').value = data.contract.digest; if (data.limits) { wizard.querySelector('[name="maxFixRounds"]').value = data.limits.maxFixRounds; wizard.querySelector('[name="perIssueTokens"]').value = data.limits.perIssueTokens; } wizard.querySelector('[name="preflight"]').checked = data.preflight?.status === 'passed'; wizard.querySelector('button[type="submit"]').disabled = data.contract?.status !== 'valid' || !data.builderModels?.length; };
const render = (data) => {
  document.querySelector('#project-name').textContent = data.project.name;
  document.querySelector('#project-meta').textContent = data.project.repo+' · '+data.project.baseBranch;
  document.querySelector('#project-base').textContent = data.project.baseBranch;
  document.querySelector('#last-updated').textContent = 'Atualizado '+date(data.generatedAt);
  const summary = data.summary;
  document.querySelector('#metrics').innerHTML = [
    ['Tasks', summary.totalIssues, ''], ['Em execução', summary.inFlight, 'accent'], ['Aguardando decisão', summary.held, 'warn'], ['Bloqueadas', summary.blocked, 'danger']
  ].map(([label, value, tone]) => '<article class="card metric"><div class="metric-label">'+label+'</div><div class="metric-value '+tone+'">'+value+'</div></article>').join('');
  const issues = data.issues;
  const board = data.board;
  const boardStatus = board ? board.provider+' · '+board.status+(board.truncated ? ' · limite atingido' : '') : 'desativado';
  document.querySelector('#board-status').innerHTML = pill(boardStatus);
  document.querySelector('#board-error').innerHTML = board && board.error ? '<div class="error">'+esc(board.error)+'</div>' : '';
  document.querySelector('#board').innerHTML = board && board.issues.length ? board.issues.map((issue) => { const local = issues.find((item) => item.issue === issue.identifier); return '<div class="board-issue"><a class="board-link" href="'+href(issue.url)+'" target="_blank" rel="noreferrer">'+esc(issue.identifier)+' · '+esc(issue.title)+'</a><div class="board-meta"><span class="board-lane">lane: '+esc(issue.lane || 'unclassified')+'</span><span>'+esc(issue.state)+'</span><span>atualizado '+esc(date(issue.updatedAt))+'</span>'+(issue.assignees.length ? '<span>· '+esc(issue.assignees.join(', '))+'</span>' : '')+(local ? '<span>· local '+pill(local.outcome)+'</span>' : '')+issue.labels.map((label) => '<span class="board-label">'+esc(label)+'</span>').join('')+'</div></div>'; }).join('') : '<div class="empty">Nenhuma issue aberta encontrada.</div>';
  document.querySelector('#issues').innerHTML = issues.length ? issues.map((issue) => '<div class="issue"><div><div class="issue-id">'+esc(issue.issue)+'</div><div class="issue-meta">'+esc(issue.branch || issue.worktree || 'sem worktree')+'</div></div><div>'+pill(issue.phase)+'</div><div>'+pill(issue.outcome)+'</div><div class="issue-meta">'+esc(issue.lastEvent || 'nenhum evento')+'<br>'+esc(date(issue.dispatchedAt))+'</div></div>').join('') : '<div class="empty">Nenhuma task encontrada na janela atual.</div>';
  document.querySelector('#events').innerHTML = data.events.length ? data.events.map((event) => '<div class="event"><div class="muted mono">'+esc(date(event.at))+'</div><div class="event-type">'+esc(event.type)+'</div><div class="event-detail">'+esc(event.issue ? event.issue+' · ' : '')+esc(event.detail)+'</div></div>').join('') : '<div class="empty">Nenhum evento registrado na janela atual.</div>';
  document.querySelector('#config-hash').textContent = data.project.configHash.slice(0, 12);
  document.querySelector('#event-count').textContent = summary.eventCount+' eventos · janela de '+data.windowHours+'h';
  const runs = data.runs || [];
  const activeRuns = runs.filter((run) => ['queued','dispatching','running','needs-input'].includes(run.status));
  const history = runs.filter((run) => ['completed','failed','cancelled'].includes(run.status));
  document.querySelector('#capacity').textContent = data.capacity ? data.capacity.free+' slot(s) livres · '+data.capacity.running+'/'+data.capacity.maxAgents : 'capacidade desconhecida';
  document.querySelector('#runs').innerHTML = activeRuns.length ? activeRuns.map((run) => '<div class="run-card"><div class="run-title"><span>'+esc(run.issue)+' · '+esc(run.projection.stage)+'</span>'+pill(run.status)+'</div><div class="run-meta">'+esc(run.config.builder.provider+'/'+run.config.builder.model)+' · flow '+esc(run.config.flow || 'default')+' · '+esc(run.projection.branch || 'branch pendente')+'</div><div class="run-actions">'+(run.status === 'queued' ? '<button data-run-cancel="'+esc(run.id)+'">Cancelar</button>' : '')+(run.status === 'needs-input' ? '<span class="muted">aguardando Inbox</span>' : '')+'</div></div>').join('') : '<div class="empty">Nenhuma issue em execução.</div>';
  document.querySelector('#history').innerHTML = history.length ? history.map((run) => '<div class="run-card"><div class="run-title"><span>'+esc(run.issue)+'</span>'+pill(run.status)+'</div><div class="run-meta">'+esc(run.error || run.projection.stage)+' · tentativa '+esc(run.attempt)+'</div><div class="run-actions">'+(['failed','cancelled'].includes(run.status) ? '<button data-run-retry="'+esc(run.id)+'">Tentar novamente</button>' : '')+'</div></div>').join('') : '<div class="empty">Nenhum histórico.</div>';
  const available = data.availableIssues || [];
  document.querySelector('#available').innerHTML = available.length ? available.map((issue) => '<div class="available-card"><div class="run-title"><span>'+esc(issue.identifier)+' · '+esc(issue.title)+'</span><button data-select-issue="'+esc(issue.identifier)+'">Configurar</button></div><div class="run-meta">'+esc(issue.state)+' · '+esc((issue.labels || []).join(', '))+'</div></div>').join('') : '<div class="empty">Nenhuma issue disponível.</div>';
  const inbox = data.inbox || [];
  document.querySelector('#inbox-badge').textContent = inbox.length;
  document.querySelector('#inbox').innerHTML = inbox.length ? inbox.map((item) => '<div class="inbox-card"><div class="run-title"><span>'+esc(item.issue)+' · '+esc(item.title)+'</span>'+pill(item.gate)+'</div><div class="run-meta">'+esc(item.message)+'</div><div class="run-actions">'+(item.actions || []).map((action) => '<button data-inbox="'+esc(item.id)+'" data-inbox-action="'+esc(action)+'">'+esc(action)+'</button>').join('')+'</div></div>').join('') : '<div class="empty">Nenhuma pendência humana.</div>';
  const jobs = data.jobs || [];
  document.querySelector('#jobs').innerHTML = jobs.length ? jobs.map((job) => { const active = ['running','cancel-pending'].includes(job.status); return '<div class="job"><div><div class="job-id">'+esc(job.id.slice(0, 12))+'</div><div class="issue-meta">'+esc(job.action.type)+' · '+esc(job.actor)+'</div></div><div>'+pill(job.status)+'</div><div class="issue-meta">'+esc(job.phase)+'</div><div class="issue-meta">'+esc((job.events || []).at(-1)?.detail || job.error?.message || 'sem eventos')+'</div><div>'+(active ? '<button class="job-button" data-cancel="'+esc(job.id)+'">Cancelar</button>' : ['failed','interrupted','cancelled'].includes(job.status) ? '<button class="job-button" data-retry="'+esc(job.id)+'">Repetir</button>' : '')+'</div></div>'; }).join('') : '<div class="empty">Nenhum job iniciado pela UI.</div>';
};
const showError = (error) => { document.querySelector('#error').hidden = false; document.querySelector('#error').textContent = error.message || String(error); };
const load = (force = false) => api('/api/v1/state'+(force ? '?refresh=1' : '')).then(render).catch(showError);
document.querySelector('#refresh').addEventListener('click', () => load(true));
 document.querySelector('#action-form').addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const type = String(form.get('type')); const value = (name) => String(form.get(name) || '').trim(); const list = (name) => value(name).split(',').map((item) => item.trim()).filter(Boolean); const action = { type, ...(value('issue') ? { issue: value('issue') } : {}), ...(type === 'loop.contract' && value('issue') ? { identifier: value('issue') } : {}), ...(value('objective') ? { objective: value('objective') } : {}), ...(value('planId') ? { id: value('planId') } : {}), ...(value('answer') ? { answer: value('answer') } : {}), ...(value('state') ? { state: value('state') } : {}), ...(value('body') ? { body: value('body') } : {}), ...(value('head') ? { head: value('head') } : {}), ...(value('since') ? { since: value('since') } : {}), ...(value('stage') ? { stage: value('stage') } : {}), ...(value('parent') ? { parent: value('parent') } : {}), ...(value('project') ? { project: value('project') } : {}), ...(value('actor') ? { actor: value('actor') } : {}), ...(value('reason') ? { reason: value('reason') } : {}), ...(value('max') ? { max: Number(value('max')) } : {}), ...(type === 'issue.labels' ? { add: list('add'), remove: list('remove') } : {}), ...(type === 'plan.decompose' ? { create: form.get('create') === 'on', refresh: form.get('refresh') === 'on' } : {}), ...(['loop.doctor'].includes(type) ? { probe: form.get('probe') === 'on' } : {}), ...(['loop.tick'].includes(type) ? { skipContract: form.get('skipContract') === 'on' } : {}), ...(['loop.contract'].includes(type) ? { refresh: form.get('refresh') === 'on', dryRun: form.get('dryRun') === 'on' } : {}), ...(['loop.tick','loop.deliver','loop.stage','release.run'].includes(type) ? { dryRun: form.get('dryRun') === 'on' } : {}), ...(['plan.approve-design'].includes(type) ? { acceptObjections: form.get('acceptObjections') === 'on' } : {}), ...(['loop.tick','loop.deliver','loop.stage','loop.contract','loop.approve-delivery','loop.resume','plan.start','plan.answer','plan.approve','plan.architect','plan.approve-design','plan.decompose','release.approve','release.run','issue.transition','issue.comment','issue.labels'].includes(type) ? { confirm: form.get('confirm') === 'on' } : {}), ...(['release.approve','release.run'].includes(type) || (type === 'loop.stage' && value('stage') === 'release') ? { confirmRelease: form.get('confirmRelease') === 'on' } : {}) }; api('/api/v1/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }).then(() => { document.querySelector('#error').hidden = true; load(true); }).catch(showError); });
document.querySelector('#prepare-issue').addEventListener('click', () => { const issue = issueValue(); if (!issue) return showError(new Error('Informe a issue para preparar o wizard.')); api('/api/v1/issues/'+encodeURIComponent(issue)+'/wizard').then(fillWizard).catch(showError); });
wizard.addEventListener('submit', (event) => { event.preventDefault(); const form = new FormData(wizard); const body = { issue: issueValue(), flow: String(form.get('flow') || ''), builder: String(form.get('builder') || ''), contractDigest: String(form.get('contractDigest') || ''), maxFixRounds: Number(form.get('maxFixRounds')), perIssueTokens: Number(form.get('perIssueTokens')), preflight: form.get('preflight') === 'on' }; api('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(() => { wizard.reset(); load(true); }).catch(showError); });
document.querySelector('#available').addEventListener('click', (event) => { const target = event.target; if (target instanceof HTMLElement && target.dataset.selectIssue) { wizard.querySelector('[name="issue"]').value = target.dataset.selectIssue; document.querySelector('.wizard').scrollIntoView({ behavior: 'smooth' }); } });
document.querySelector('#runs').addEventListener('click', (event) => { const target = event.target; if (!(target instanceof HTMLElement)) return; const cancel = target.dataset.runCancel; const retry = target.dataset.runRetry; if (cancel) api('/api/v1/runs/'+encodeURIComponent(cancel)+'/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmActive: false }) }).then(() => load(true)).catch(showError); if (retry) api('/api/v1/runs/'+encodeURIComponent(retry)+'/retry', { method: 'POST' }).then(() => load(true)).catch(showError); });
document.querySelector('#history').addEventListener('click', (event) => { const target = event.target; if (target instanceof HTMLElement && target.dataset.runRetry) api('/api/v1/runs/'+encodeURIComponent(target.dataset.runRetry)+'/retry', { method: 'POST' }).then(() => load(true)).catch(showError); });
document.querySelector('#inbox').addEventListener('click', (event) => { const target = event.target; if (!(target instanceof HTMLElement) || !target.dataset.inbox) return; api('/api/v1/inbox/'+encodeURIComponent(target.dataset.inbox)+'/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'ui', action: target.dataset.inboxAction }) }).then(() => load(true)).catch(showError); });
document.querySelector('#jobs').addEventListener('click', (event) => { const target = event.target; if (!(target instanceof HTMLElement)) return; const cancel = target.dataset.cancel; const retry = target.dataset.retry; const id = cancel || retry; if (!id) return; api('/api/v1/jobs/'+encodeURIComponent(id)+'/'+(cancel ? 'cancel' : 'retry'), { method: 'POST' }).then(() => load(true)).catch(showError); });
load();
const stream = new EventSource('/api/v1/events?session='+encodeURIComponent(token));
stream.addEventListener('snapshot', (event) => { try { render(JSON.parse(event.data)); } catch (error) { showError(error); } });
stream.onerror = () => { document.querySelector('#connection').textContent = 'reconectando'; };
stream.onopen = () => { document.querySelector('#connection').textContent = 'conectado'; };
`

const renderLegacyUiHtml = (token: string): string => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harness · Operação</title><style>${uiCss}</style></head>
<body><div class="shell"><aside class="rail"><div class="brand"><span class="brand-mark">A</span><span>AgentsKit Harness</span></div><div class="rail-label">Workspace</div><button class="rail-item active">Operação</button><button class="rail-item" disabled>Tasks <span class="muted">· em breve</span></button><button class="rail-item" disabled>Evidências <span class="muted">· em breve</span></button></aside>
<main class="main"><header class="topbar"><div><p class="eyebrow">SDLC control surface</p><h1 id="project-name">Harness</h1><div id="project-meta" class="muted">carregando…</div></div><div><button id="refresh" class="refresh">Atualizar</button><div id="last-updated" class="muted" style="margin-top:8px;text-align:right">—</div></div></header>
<div id="metrics" class="grid"></div><div id="error" class="error" hidden></div><section class="issue-first"><section class="card section"><div class="section-head"><h2 class="section-title">Inbox <span id="inbox-badge" class="pill warn">0</span></h2><span class="muted">decisões humanas</span></div><div id="inbox" class="section-body"></div></section><section class="card section"><div class="section-head"><h2 class="section-title">Disponíveis</h2><span class="muted">selecione uma issue</span></div><div id="available" class="section-body"></div></section><section class="card section"><div class="section-head"><h2 class="section-title">Executando</h2><span id="capacity" class="muted">capacidade —</span></div><div id="runs" class="section-body"></div></section><section class="card section"><div class="section-head"><h2 class="section-title">Histórico</h2><span class="muted">concluídas, falhas e canceladas</span></div><div id="history" class="section-body"></div></section></section><section class="card section wizard" style="margin-top:14px"><div class="section-head"><h2 class="section-title">Configurar issue</h2><span class="muted">wizard · confirmação enfileira e retorna</span></div><form id="issue-wizard" class="action-form"><input name="issue" placeholder="Issue (ex.: ENG-123)" required><select name="flow"><option value="">Flow do projeto</option></select><select name="builder"><option value="">Modelo builder</option></select><input name="contractDigest" placeholder="Digest do contrato validado" required><input name="maxFixRounds" type="number" min="0" placeholder="maxFixRounds"><input name="perIssueTokens" type="number" min="0" placeholder="perIssueTokens"><label class="muted"><input type="checkbox" name="preflight"> preflight aprovado</label><button type="button" id="prepare-issue">1. Preparar</button><button type="submit" disabled>2. Confirmar e iniciar</button></form></section>
<div class="section-grid"><section class="card section"><div class="section-head"><h2 class="section-title">Tasks em contexto</h2><span id="connection" class="pill ok">conectando</span></div><div id="issues" class="section-body"></div></section><section class="card section"><div class="section-head"><h2 class="section-title">Projeto</h2><span id="event-count" class="muted">—</span></div><div class="project"><div class="project-row"><span class="muted">Config</span><span id="config-hash" class="mono">—</span></div><div class="project-row"><span class="muted">Base</span><span id="project-base" class="mono">—</span></div><div class="project-row"><span class="muted">Estado</span><span class="pill ok">local</span></div></div></section></div><details class="card section advanced" style="margin-top:14px"><summary class="section-head">Operações avançadas: doctor, tick, deliver e release</summary><form id="action-form" class="action-form"><select name="type"><option value="loop.tick">Executar tick</option><option value="loop.deliver">Executar deliver</option><option value="loop.doctor">Executar doctor</option><option value="loop.validate">Validar configuração</option><option value="loop.status">Status do loop</option><option value="loop.observability">Observabilidade</option><option value="loop.stage">Executar stage</option><option value="loop.contract">Gerar contrato</option><option value="loop.resume">Retomar</option><option value="release.status">Status do release</option><option value="release.run">Executar release</option></select><input name="issue" placeholder="Issue (opcional)"><input name="actor" placeholder="Actor"><input name="reason" placeholder="Motivo"><label class="muted"><input type="checkbox" name="confirm"> confirmar</label><button type="submit">Executar</button></form></details><section class="card section" style="margin-top:14px"><div class="section-head"><h2 class="section-title">Jobs da UI</h2><span class="muted">progresso e retry idempotente</span></div><div id="jobs" class="section-body"></div></section>
 <section class="card section" style="margin-top:14px"><div class="section-head"><h2 class="section-title">Board remoto</h2><span id="board-status" class="pill">carregando</span></div><div id="board-error"></div><div id="board" class="section-body"></div></section>
 <section class="card section" style="margin-top:14px"><div class="section-head"><h2 class="section-title">Timeline de eventos</h2><span class="muted">mais recentes primeiro</span></div><div id="events" class="section-body timeline"></div></section></main></div>
<script>window.__HARNESS_SESSION__=${json(token)};${uiScript}</script></body></html>`

export const renderUiHtml = (token: string): string => renderIssueFirstHtml(token)

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1'

const requestOrigin = (host: string, port: number): string => `http://${host === '::1' ? `[${host}]` : host}:${port}`

const sameLoopbackOrigin = (origin: string, expectedOrigin: string): boolean => {
  try {
    const actual = new URL(origin)
    const expected = new URL(expectedOrigin)
    return actual.protocol === expected.protocol && actual.port === expected.port && isLoopback(actual.hostname) && isLoopback(expected.hostname)
  } catch {
    return false
  }
}

const authorized = (request: IncomingMessage, token: string, expectedOrigin: string, url: URL): boolean => {
  const origin = request.headers.origin
  if (origin && origin !== expectedOrigin && !sameLoopbackOrigin(origin, expectedOrigin)) return false
  return request.headers[SESSION_HEADER] === token || url.searchParams.get('session') === token
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = json(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

const sendText = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

const readRequestBody = (request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk: string) => {
    body += chunk
    if (Buffer.byteLength(body) > maxBytes) reject(new Error('Request body is too large.'))
  })
  request.on('end', () => {
    if (!body.trim()) return resolve({})
    try { resolve(JSON.parse(body) as unknown) } catch { reject(new Error('Request body must be valid JSON.')) }
  })
  request.on('error', reject)
})

const snapshotFor = (options: UiServerOptions, jobs: UiJobManager | null): ((force?: boolean) => Promise<UiSnapshot>) => {
  if (options.snapshot) return async (force = false) => ({ ...(await options.snapshot!(force)), jobs: jobs?.list() ?? [] })
  const loaded = options.loaded ?? loadLoopConfig(options.configPath ?? 'loop.config.yaml')
  const board = options.board ?? createIssueBoardCache({ loaded, reader: createIssueBoardReader({ loaded, runner: createProcessRunner() }) })
  const queue = options.queue ?? createIssueQueue({ stateDir: loaded.stateDir })
  const inbox = options.inbox ?? createInboxStore(loaded.stateDir)
  return async (force = false) => createUiSnapshot({ loaded, windowHours: options.windowHours, board: await board.read(force), jobs: jobs?.list() ?? [], queue, inbox })
}

const listen = (server: Server, port: number, host: string): Promise<number> => new Promise((resolve, reject) => {
  const onError = (error: Error): void => { server.off('error', onError); reject(error) }
  server.once('error', onError)
  server.listen(port, host, () => {
    server.off('error', onError)
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('Harness UI did not receive a TCP address.'))
    resolve(address.port)
  })
})

const recordOf = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const stringOf = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const modelReferenceFor = (value: unknown, loaded: LoadedLoopConfig): ModelReference => {
  const raw = stringOf(value)
  const configured = loaded.config.models.builder.flat().find((candidate) => candidate === raw && loaded.config.models.providers[candidate.slice(0, candidate.indexOf('/'))])
  if (!configured) throw new Error('The builder must be one of the declared and routable provider/model candidates.')
  return parseModelRef(configured)
}

const contractSummary = (stored: StoredContract): string => [
  `Intenção: ${stored.contract.intent}`,
  `Incluído: ${stored.contract.scope.inScope.join('; ')}`,
  ...(stored.contract.scope.outOfScope.length ? [`Fora do escopo: ${stored.contract.scope.outOfScope.join('; ')}`] : []),
  ...(stored.contract.outcomes.length ? [`Resultados verificáveis: ${stored.contract.outcomes.map((outcome) => `${outcome.id} — ${outcome.description}`).join('; ')}`] : []),
].join('\n')

const enqueueInput = (body: unknown, loaded: LoadedLoopConfig): EnqueueIssueRunInput => {
  const raw = recordOf(body)
  const issue = stringOf(raw['issue'])
  if (!issue || !SAFE_IDENTIFIER.test(issue)) throw new Error('A valid issue identifier is required.')
  const configHash = stringOf(raw['configHash'])
  if (configHash && configHash !== loaded.configHash) throw new Error('The project configuration changed while this issue was being configured. Re-run preflight.')
  const contractDigest = stringOf(raw['contractDigest'])
  if (!contractDigest) throw new Error('A valid contractDigest is required before confirmation.')
  if (raw['preflight'] !== true) throw new Error('A passed preflight is required before confirmation.')
  const flow = stringOf(raw['flow'])
  const flowProfiles = loaded.config.flows?.profiles ?? {}
  if (flow && !Object.prototype.hasOwnProperty.call(flowProfiles, flow)) throw new Error(`Unknown flow: ${flow}.`)
  const maxFixRounds = typeof raw['maxFixRounds'] === 'number' ? raw['maxFixRounds'] : loaded.config.delivery.maxFixRounds
  const perIssueTokens = typeof raw['perIssueTokens'] === 'number' ? raw['perIssueTokens'] : loaded.config.budget.perIssueTokens
  if (!Number.isInteger(maxFixRounds) || maxFixRounds < 0 || maxFixRounds > loaded.config.delivery.maxFixRounds) throw new Error(`maxFixRounds cannot exceed the project ceiling (${loaded.config.delivery.maxFixRounds}).`)
  if (!Number.isInteger(perIssueTokens) || perIssueTokens < 0 || (loaded.config.budget.perIssueTokens > 0 && perIssueTokens > loaded.config.budget.perIssueTokens)) throw new Error('perIssueTokens cannot exceed the project ceiling.')
  const at = new Date().toISOString()
  return {
    issue, title: stringOf(raw['title']), url: stringOf(raw['url']),
    config: { configHash: loaded.configHash, flow, builder: modelReferenceFor(raw['builder'], loaded), maxFixRounds, perIssueTokens, roles: { orchestrator: 'project', reviewer: 'project', watcher: 'project', delivery: 'snapshot' } },
    contract: { digest: contractDigest, status: 'valid', frozenAt: at }, preflight: { status: 'passed', checkedAt: at },
  }
}

const issueWizard = async (issue: string, loaded: LoadedLoopConfig, runner: ReturnType<typeof createProcessRunner>): Promise<Record<string, unknown>> => {
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  const detail = await tracker.issue(issue)
  const availability = await detectProviders({ providers: providerSpecs(loaded.config), accountList: {}, agentHooks: {}, runner })
  const candidates = rankModels(loaded.config, 'builder', availability).map((candidate) => ({ provider: candidate.provider, model: candidate.model }))
  const cached = readStoredContract(loaded.stateDir, issue)
  const fresh = cached ? contractIsFresh(cached, detail, loaded.config.contract.reuseHours, new Date()) : false
  const contract = cached && fresh
    ? { status: cached.assessment?.dispatchable === false ? 'escalated' : 'valid', digest: cached.digest, summary: cached.assessment?.dispatchable === false ? cached.assessment.reasons.join('; ') : contractSummary(cached) }
    : cached
      ? { status: 'expired', digest: cached.digest, summary: 'O contrato existente expirou ou a issue mudou. Gere um novo contrato para continuar.' }
      : { status: 'missing', digest: null }
  if (cached && fresh && cached.assessment?.dispatchable === false) createInboxStore(loaded.stateDir).upsert({ issue, gate: 'contract.escalated', message: cached.assessment.reasons.join('; ') })
  const maxAgents = loaded.config.machine.ceiling ?? loaded.config.machine.floor
  const running = listDispatched(loaded.stateDir).filter((dispatch) => !readDeliveryState(loaded.stateDir, dispatch.issue).finishedAt).length
  const free = Math.max(0, maxAgents - running)
  const preflight = candidates.length > 0
    ? { status: 'passed', checkedAt: new Date().toISOString(), ...(free <= 0 ? { reason: 'Nenhum slot está livre agora; a execução será enfileirada.' } : {}) }
    : { status: 'blocked', checkedAt: new Date().toISOString(), reason: 'Nenhum modelo builder está roteável agora.' }
  return { issue: detail, configHash: loaded.configHash, contract, flows: Object.keys(loaded.config.flows.profiles), defaultFlow: loaded.config.flows.default ?? null, builderModels: candidates, limits: { maxFixRounds: loaded.config.delivery.maxFixRounds, perIssueTokens: loaded.config.budget.perIssueTokens }, capacity: { maxAgents, running, free }, preflight }
}

const startBestEffortTick = (loaded: LoadedLoopConfig | undefined, runner: ReturnType<typeof createProcessRunner>, queue: IssueQueue, issue: string, inbox: InboxStore): void => {
  if (!loaded) return
  void runTick({ loaded, runner, onlyIssue: issue, maxDispatch: 1 }).then((report) => {
    const run = queue.getLatestByIssue(issue) ?? queue.list().filter((candidate) => candidate.issue === issue).at(-1) ?? null
    const result = report.results.find((candidate) => candidate.issue === issue)
    if (!run || !result) return
    if (result.outcome === 'dispatched') {
      if (run.status !== 'running') queue.update(run.id, { status: 'running', projection: { stage: 'running', branch: result.branch ?? null, worktree: result.worktree ?? null, terminal: result.terminal ?? null } })
    } else if (result.outcome === 'escalated') {
      if (run.status !== 'needs-input') queue.update(run.id, { status: 'needs-input', error: result.reason, projection: { stage: 'needs-input' } })
      inbox.upsert({ issue, gate: 'contract.escalated', message: result.reason })
    } else if (result.outcome === 'failed') {
      if (run.status !== 'failed') queue.update(run.id, { status: 'failed', error: result.reason, projection: { stage: 'failed' } })
      // Common provider/dispatch failures are retryable and stay in Available; final delivery blockers use Inbox.
    }
  }).catch((error: unknown) => {
    const run = queue.getLatestByIssue(issue) ?? queue.list().filter((candidate) => candidate.issue === issue).at(-1) ?? null
    if (run) { const message = error instanceof Error ? error.message : String(error); if (run.status !== 'failed') queue.update(run.id, { status: 'failed', error: message, projection: { stage: 'failed' } }) }
  })
}

const syncInboxFromRecentEvents = (loaded: LoadedLoopConfig | undefined, inbox: InboxStore | null): void => {
  if (!loaded || !inbox) return
  // windowed: direct Inbox reads still project a bounded event tail when no state snapshot preceded the request.
  inbox.syncEvents(readLoopEvents(loaded.stateDir, Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1_000).slice(-MAX_RECENT_EVENTS))
}

const isUiRoute = (pathname: string): boolean => pathname === '/' || pathname === '/index.html' || pathname === '/inbox' || pathname === '/wizard' || pathname.startsWith('/wizard/') || pathname.startsWith('/operation/runs/')

const cleanupAlreadyGone = (error: unknown): boolean => (error instanceof Error ? error.message : String(error)).includes('selector_not_found')

const cleanupActiveRun = async (loaded: LoadedLoopConfig, runner: ReturnType<typeof createProcessRunner>, run: Pick<IssueRun, 'id' | 'issue' | 'status'>, trackerState?: string): Promise<void> => {
  const dispatch = listDispatched(loaded.stateDir).find((candidate) => candidate.issue === run.issue)
  const ledger = createDispatchLedger(loaded.stateDir)
  if (!dispatch) {
    // Contract/plan work can be cancelled while the queue is in its dispatching or needs-input phase.
    // There is no Orca resource to remove in that case; an active lease would mean dispatch crossed that boundary.
    if (!ledger.active().some((candidate) => candidate.issue === run.issue) && ['dispatching', 'needs-input'].includes(run.status)) return
    throw new Error(`No dispatch record for active run ${run.id}; cleanup cannot be confirmed.`)
  }
  const orca = { bin: loaded.config.orca.bin, timeoutMs: 60_000 }
  if (dispatch.terminal) {
    try { await orcaTerminalClose(runner, { terminal: dispatch.terminal }, orca) }
    catch (error) { if (!cleanupAlreadyGone(error)) throw new Error(`terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  try { await orcaWorktreeRemove(runner, { worktree: `id:${dispatch.worktreeId}`, force: true }, orca) }
  catch (error) { if (!cleanupAlreadyGone(error)) throw new Error(`worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`) }
  const lease = ledger.active().find((candidate) => candidate.leaseId === dispatch.leaseId)
  if (lease) ledger.release(lease, 'ui cancellation')
  const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
  await tracker.setState({ issue: run.issue, to: trackerState ?? loaded.config.delivery?.returnState ?? 'Todo', reason: 'UI cleanup completed' })
  markDispatchCancelled(loaded.stateDir, run.issue)
}

const finishCleanupInQueue = (queue: IssueQueue, run: IssueRun, completedStage?: string): IssueRun => {
  if (['queued', 'dispatching', 'running', 'needs-input'].includes(run.status)) return queue.cancel(run.id, { confirmActive: true, cleanupConfirmed: true })
  if (run.status === 'completed') return queue.update(run.id, { projection: { stage: completedStage ?? (run.projection.stage === 'pr-closed' ? 'pr-closed-cleaned' : run.projection.stage), terminal: null, worktree: null } })
  return queue.update(run.id, { status: 'cancelled', projection: { stage: 'cancelled', terminal: null, worktree: null } })
}

const recordCleanupFailure = (queue: IssueQueue, inbox: InboxStore | null, run: IssueRun, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  queue.update(run.id, { status: 'needs-input', error: `cancel cleanup failed: ${message}`, projection: { stage: 'cleanup-failed' } })
  inbox?.upsert({ issue: run.issue, gate: 'cleanup.failed', message, data: { runId: run.id } })
  return message
}

/** Start the loopback UI server. The returned token is intentionally kept out of the URL and injected only into the served page. */
export const startUiServer = async (options: UiServerOptions = {}): Promise<UiServerHandle> => {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  if (!isLoopback(host)) throw new Error('Harness UI only binds to loopback addresses.')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Harness UI port must be an integer between 0 and 65535.')
  const token = randomBytes(24).toString('hex')
  const runner = createProcessRunner()
  const loaded = options.loaded ?? (options.snapshot ? undefined : loadLoopConfig(options.configPath ?? 'loop.config.yaml'))
  const jobs = options.jobs ?? (loaded ? createUiJobManager({ loaded, runner }) : null)
  const ownsJobs = options.jobs === undefined && jobs !== null
  const queue = options.queue ?? (loaded ? createIssueQueue({ stateDir: loaded.stateDir }) : null)
  const inbox = options.inbox ?? (loaded ? createInboxStore(loaded.stateDir) : null)
  const wizard = options.wizard ?? (loaded ? createUiWizardStore(loaded.stateDir) : null)
  const snapshot = snapshotFor({ ...options, ...(loaded ? { loaded } : {}), ...(queue ? { queue } : {}), ...(inbox ? { inbox } : {}) }, jobs)
  const clients = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`)
      if (isUiRoute(url.pathname)) return sendText(response, 200, renderUiHtml(token))
      if (!url.pathname.startsWith('/api/v1/')) return sendJson(response, 404, { error: 'not_found' })
      const address = server.address()
      const boundPort = address && typeof address !== 'string' ? address.port : port
      if (!authorized(request, token, requestOrigin(host, boundPort), url)) return sendJson(response, 401, { error: 'unauthorized' })
      if (url.pathname === '/api/v1/health') return sendJson(response, 200, { status: 'ok', schemaVersion: UI_SCHEMA_VERSION })
      if (url.pathname === '/api/v1/state') {
        try { return sendJson(response, 200, await snapshot(url.searchParams.get('refresh') === '1')) }
        catch (error) { return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/v1/runs' && request.method === 'GET') return sendJson(response, 200, { runs: queue?.list() ?? [] })
      if (url.pathname === '/api/v1/inbox' && request.method === 'GET') { syncInboxFromRecentEvents(loaded, inbox); return sendJson(response, 200, { items: inbox?.list({ status: 'open' }) ?? [], unread: inbox?.unreadCount() ?? 0 }) }
      if ((url.pathname.startsWith('/api/v1/wizard/') || (url.pathname.startsWith('/api/v1/issues/') && url.pathname.endsWith('/wizard'))) && (request.method === 'GET' || request.method === 'PUT' || request.method === 'POST')) {
        if (!loaded) return sendJson(response, 503, { error: 'issue_wizard_unavailable' })
        const wizardRoute = url.pathname.startsWith('/api/v1/wizard/')
        const rawIssue = wizardRoute ? url.pathname.split('/').filter(Boolean)[3] : url.pathname.split('/').filter(Boolean)[3]
        const issue = rawIssue ? decodeURIComponent(rawIssue) : null
        if (!issue || !SAFE_IDENTIFIER.test(issue)) return sendJson(response, 400, { error: 'invalid_issue' })
        if (!wizard) return sendJson(response, 503, { error: 'wizard_unavailable' })
        try {
          if (request.method === 'GET') return sendJson(response, 200, { ...(await issueWizard(issue, loaded, runner)), draft: wizard.read(issue) })
          if (request.method === 'PUT') return sendJson(response, 200, { draft: wizard.save(issue, parseUiWizardDraftPatch(await readRequestBody(request))) })
          if (!jobs) return sendJson(response, 503, { error: 'contract_generation_unavailable' })
          const body = recordOf(await readRequestBody(request))
          const action = parseUiAction({ type: 'loop.contract', identifier: issue, refresh: body['refresh'] === true, dryRun: false, actor: process.env['USERNAME'] || process.env['USER'] || 'local', reason: 'Preparar contrato no wizard', confirm: true })
          return sendJson(response, 202, { job: await jobs.submit(action) })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/v1/runs' && request.method === 'POST') {
        if (!loaded || !queue || !inbox) return sendJson(response, 503, { error: 'queue_unavailable' })
        try {
          const run = queue.enqueue(enqueueInput(await readRequestBody(request), loaded))
          startBestEffortTick(loaded, runner, queue, run.issue, inbox)
          return sendJson(response, 202, { run })
          } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if ((url.pathname === '/api/v1/runs/archive' || url.pathname === '/api/v1/runs/archive-batch') && request.method === 'POST') {
        if (!queue) return sendJson(response, 503, { error: 'queue_unavailable' })
        try {
          const body = recordOf(await readRequestBody(request)); if (body['confirm'] !== true) return sendJson(response, 409, { error: 'archive_requires_confirmation' })
          const ids = Array.isArray(body['ids']) ? body['ids'].filter((id): id is string => typeof id === 'string') : []
          if (!ids.length) return sendJson(response, 400, { error: 'run_ids_required' })
          return sendJson(response, 200, { runs: queue.archiveMany(ids) })
        } catch (error) { return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname.startsWith('/api/v1/runs/')) {
        const parts = url.pathname.split('/').filter(Boolean); const id = parts[3]; const operation = parts[4]
        if (!id || !queue) return sendJson(response, 404, { error: 'run_not_found' })
        const run = queue.get(id); if (!run) return sendJson(response, 404, { error: 'run_not_found' })
        try {
          if (request.method === 'GET' && !operation) return sendJson(response, 200, run)
          if (request.method === 'POST' && operation === 'archive') {
            const body = recordOf(await readRequestBody(request)); if (body['confirm'] !== true) return sendJson(response, 409, { error: 'archive_requires_confirmation' })
            return sendJson(response, 200, queue.archive(id))
          }
          if (request.method === 'POST' && operation === 'restore') return sendJson(response, 200, queue.restore(id))
          if (request.method === 'POST' && operation === 'cleanup') {
            const body = recordOf(await readRequestBody(request)) as UiRunCleanupRequest
            if (body.confirmCleanup !== true) return sendJson(response, 409, { error: 'cleanup_requires_confirmation' })
            if (!loaded) return sendJson(response, 503, { error: 'cleanup_unavailable' })
            try { await cleanupActiveRun(loaded, runner, run) }
            catch (error) { return sendJson(response, 409, { error: 'cleanup_failed', detail: recordCleanupFailure(queue, inbox, run, error) }) }
            const cleaned = finishCleanupInQueue(queue, run)
            const pending = inbox?.getByIssueAndGate(run.issue, 'cleanup.failed')
            if (pending?.status === 'open') inbox?.resolve(pending.id, { actor: 'ui', action: 'cleanup', data: { runId: run.id } })
            return sendJson(response, 200, cleaned)
          }
          if (request.method === 'POST' && operation === 'cancel') {
            const body = recordOf(await readRequestBody(request))
            if (run.status !== 'queued') {
              if (body['confirmActive'] !== true) return sendJson(response, 409, { error: 'active_cancellation_requires_confirmation' })
              if (!loaded) return sendJson(response, 503, { error: 'cleanup_unavailable' })
              try { await cleanupActiveRun(loaded, runner, run) }
              catch (error) { return sendJson(response, 409, { error: 'cleanup_failed', detail: recordCleanupFailure(queue, inbox, run, error) }) }
              return sendJson(response, 200, finishCleanupInQueue(queue, run))
            }
            return sendJson(response, 200, queue.cancel(id))
          }
          if (request.method === 'POST' && operation === 'retry') { const retried = queue.retry(id); startBestEffortTick(loaded, runner, queue, retried.issue, inbox!); return sendJson(response, 202, { run: retried }) }
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return sendJson(response, 404, { error: 'not_found' })
      }
      if (url.pathname.startsWith('/api/v1/inbox/')) {
        const parts = url.pathname.split('/').filter(Boolean); const operation = parts[4]; const id = decodeURIComponent(operation ? parts.slice(3, -1).join('/') : parts.slice(3).join('/'))
        if (!id || !inbox) return sendJson(response, 404, { error: 'inbox_item_not_found' })
        try {
          const item = inbox.get(id); if (!item) return sendJson(response, 404, { error: 'inbox_item_not_found' })
          if (request.method === 'POST' && operation === 'read') return sendJson(response, 200, inbox.markRead(id))
          if ((request.method === 'POST' && operation === 'delete') || (request.method === 'DELETE' && !operation)) {
            const body = recordOf(await readRequestBody(request)); const actor = stringOf(body['actor']) ?? 'ui'
            if (body['confirm'] !== true) return sendJson(response, 409, { error: 'delete_requires_confirmation' })
            inbox.delete(id, { actor, confirm: true }); return sendJson(response, 200, { deleted: true, id })
          }
          if (request.method === 'POST' && operation === 'resolve') {
            const body = recordOf(await readRequestBody(request)); const actor = stringOf(body['actor']); const action = stringOf(body['action'])
            if (!actor || !action) return sendJson(response, 400, { error: 'actor_and_action_required' })
            const data = { ...item.data, ...recordOf(body['data']) }
            if (action === 'delete') {
              if (body['confirm'] !== true) return sendJson(response, 409, { error: 'delete_requires_confirmation' })
              inbox.delete(id, { actor, confirm: true }); return sendJson(response, 200, { deleted: true, id })
            }
              if (action === 'close-issue' || action === 'reopen') {
              if (item.gate !== 'delivery.pr-closed') return sendJson(response, 400, { error: 'pr_closed_decision_required' })
              if (!loaded || !queue) return sendJson(response, 503, { error: 'cleanup_unavailable' })
              const candidate = queue.getLatestByIssue(item.issue)
              const dispatch = listDispatched(loaded.stateDir).find((entry) => entry.issue === item.issue)
              const cleanupRun: Pick<IssueRun, 'id' | 'issue' | 'status'> = candidate ?? { id: `legacy-${item.issue}`, issue: item.issue, status: 'completed' }
              if (!candidate && !dispatch) return sendJson(response, 404, { error: 'run_not_found' })
              const tracker = resolveConnectors({ runner, config: loaded.config }).tracker
              const target = action === 'close-issue' ? loaded.config.linear.doneState : loaded.config.delivery.returnState
              try {
                await tracker.setState({ issue: item.issue, to: target, reason: action === 'close-issue' ? 'PR closed without merge; human closed issue' : 'PR closed without merge; human reopened issue' })
                await cleanupActiveRun(loaded, runner, cleanupRun, target)
              } catch (error) { return sendJson(response, 409, { error: 'cleanup_failed', detail: candidate ? recordCleanupFailure(queue, inbox, candidate, error) : String(error instanceof Error ? error.message : error) }) }
              const finalStage = action === 'close-issue' ? 'closed' : 'reopened'
              const cleaned = candidate ? finishCleanupInQueue(queue, candidate, finalStage) : null
              const resolved = inbox.resolve(id, { actor, action, data: { ...data, ...(candidate ? { runId: candidate.id } : {}) } })
              createLifecycleStore(loaded.stateDir).upsert({ issue: item.issue, ...(candidate ? { runId: candidate.id } : {}), phase: action === 'close-issue' ? 'completed' : 'available', error: null, stage: finalStage })
              return sendJson(response, 200, { item: resolved, run: cleaned, ...(action === 'reopen' ? { wizard: `/wizard/${encodeURIComponent(item.issue)}` } : {}) })
            }
            if (action === 'cleanup') {
              if (!loaded || !queue) return sendJson(response, 503, { error: 'cleanup_unavailable' })
              const requestedRunId = typeof data['runId'] === 'string' ? data['runId'] : null
              const candidate = (requestedRunId ? queue.get(requestedRunId) : null) ?? queue.getByIssue(item.issue) ?? queue.list().filter((run) => run.issue === item.issue).at(-1) ?? null
              if (!candidate) return sendJson(response, 404, { error: 'run_not_found' })
              try { await cleanupActiveRun(loaded, runner, candidate) }
              catch (error) { return sendJson(response, 409, { error: 'cleanup_failed', detail: recordCleanupFailure(queue, inbox, candidate, error) }) }
              finishCleanupInQueue(queue, candidate)
            }
            if (action === 'retry' && typeof data['jobId'] === 'string' && jobs) await jobs.retry(data['jobId'])
            const resolved = inbox.resolve(id, { actor, action, data }); const queued = queue?.getByIssue(item.issue) ?? queue?.list().filter((candidate) => candidate.issue === item.issue).at(-1) ?? null
            if (queued && ['respond', 'approve', 'resume', 'revalidate'].includes(action) && queued.status === 'needs-input') { queue?.update(queued.id, { status: 'queued', error: null, projection: { stage: 'queued' } }); if (loaded && queue && inbox) startBestEffortTick(loaded, runner, queue, queued.issue, inbox) }
            if (queued && action === 'retry' && ['failed', 'cancelled', 'needs-input'].includes(queued.status) && loaded && queue && inbox) { const retried = queue.retry(queued.id); startBestEffortTick(loaded, runner, queue, retried.issue, inbox) }
            return sendJson(response, 200, resolved)
          }
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        return sendJson(response, 404, { error: 'not_found' })
      }
      if (url.pathname === '/api/v1/jobs' && request.method === 'GET') return sendJson(response, 200, { jobs: jobs?.list() ?? [] })
      if (url.pathname.startsWith('/api/v1/jobs/')) {
        const parts = url.pathname.split('/').filter(Boolean)
        const id = parts[3]
        const operation = parts[4]
        if (!id || !jobs) return sendJson(response, 404, { error: 'job_not_found' })
        try {
          if (request.method === 'GET' && !operation) {
            const job = jobs.get(id)
            return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: 'job_not_found' })
          }
          if (request.method === 'POST' && operation === 'cancel') return sendJson(response, 200, jobs.cancel(id))
          if (request.method === 'POST' && operation === 'retry') return sendJson(response, 202, await jobs.retry(id))
        } catch (error) { return sendJson(response, error instanceof UiJobConflictError ? 409 : 400, { error: error instanceof Error ? error.message : String(error), ...(error instanceof UiJobConflictError ? { conflict: error.conflict } : {}) }) }
        return sendJson(response, 404, { error: 'not_found' })
      }
      if (url.pathname === '/api/v1/actions' && request.method === 'POST') {
        if (!jobs) return sendJson(response, 503, { error: 'actions_unavailable' })
        try {
          const action = parseUiAction(await readRequestBody(request))
          return sendJson(response, 202, { job: await jobs.submit(action) })
        } catch (error) {
          const malformedBody = error instanceof Error && error.message.startsWith('Request body')
          const status = error instanceof UiJobConflictError ? 409 : (malformedBody || (error && typeof error === 'object' && 'code' in error && (error as { readonly code?: unknown }).code === 'INVALID_INPUT') ? 400 : 500)
          return sendJson(response, status, { error: error instanceof Error ? error.message : String(error), ...(error instanceof UiJobConflictError ? { conflict: error.conflict } : {}) })
        }
      }
      if (url.pathname === '/api/v1/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        clients.add(response)
        request.on('close', () => clients.delete(response))
        try { response.write(`event: snapshot\ndata: ${json(await snapshot())}\n\n`) }
        catch (error) { response.write(`event: error\ndata: ${json({ error: error instanceof Error ? error.message : String(error) })}\n\n`) }
        return
      }
      return sendJson(response, 404, { error: 'not_found' })
    })().catch(() => { try { response.destroy() } catch { /* client disconnected */ } })
  })
  const boundPort = await listen(server, port, host)
  const expectedUrl = `${requestOrigin(host, boundPort)}/`
  let previousDigest = ''
  let timerInFlight = false
  const timer = setInterval(() => {
    if (timerInFlight) return
    timerInFlight = true
    void (async () => {
      try {
        const current = await snapshot()
        const digest = hashJson(current)
        if (digest === previousDigest) return
        previousDigest = digest
        const message = `event: snapshot\ndata: ${json(current)}\n\n`
        for (const client of clients) {
          try { client.write(message) } catch { clients.delete(client) }
        }
      } catch (error) {
        const message = `event: error\ndata: ${json({ error: error instanceof Error ? error.message : String(error) })}\n\n`
        for (const client of clients) { try { client.write(message) } catch { clients.delete(client) } }
      } finally { timerInFlight = false }
    })()
  }, POLL_INTERVAL_MS)
  timer.unref()
  return {
    url: expectedUrl,
    token,
    close: async () => {
      clearInterval(timer)
      if (ownsJobs) jobs?.close()
      for (const client of clients) client.end()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
