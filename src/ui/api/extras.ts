import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../../adapters/command.js'
import { orcaAutomationsList, orcaTerminalList, orcaWorktrees, type OrcaTerminal } from '../../adapters/orca-cli.js'
import { readActiveClaims } from '../../execution/coordination.js'
import { resolveConnectors } from '../../loop/connectors.js'
import { automationSpecs, reconcileAutomations } from '../../loop/automations.js'
import type { LoadedLoopConfig } from '../../loop/config.js'
import { activeCooldowns, readCooldowns } from '../../loop/cooldown.js'
import { readDeliveryState, type DeliveryState } from '../../loop/deliver.js'
import { designApproved, listPlans } from '../../loop/plan-stage.js'
import { readReleaseState } from '../../loop/release.js'
import { isIssuePaused, readStagePause } from '../../loop/resilience-state.js'
import { readLoopEvents, type LoopEvent } from '../../loop/retro.js'
import type { DispatchRecordFile } from '../../loop/tick.js'
import { buildAttention, latestStops, type AttentionInput } from './attention.js'
import type { BoardSnapshot } from './board.js'
import type { SnapshotExtras } from './contract.js'
import type { IssueRecord } from './projection.js'
import { computeLocks, cronCadenceMs, reconcile } from './reconcile.js'

/**
 * The impure half of attention/reconciliation: reads state files and the outside world, cheaply enough for the
 * 1 s snapshot poll. Orca is behind a TTL cache refreshed in the background (the poll never waits on it after the
 * first read); the event tail is re-parsed only when `events.ndjson` changes; automations are read at most once
 * a minute. `attention.ts`/`reconcile.ts` do the actual classification, purely.
 */

const ORCA_TTL_MS = 15_000
const AUTOMATIONS_TTL_MS = 60_000
/** windowed: stops older than this no longer drive Attention; the projection's phase/error still does. */
const STOP_WINDOW_MS = 7 * 86_400_000
/** windowed: tracker sync failures and PII hits are system noise after this. */
const SYSTEM_WINDOW_MS = 6 * 3_600_000

export const staleAfterMsFor = (loaded: LoadedLoopConfig): number => 2 * cronCadenceMs(loaded.config.schedule?.tick)

// ---- Orca (worktrees + terminals), TTL-cached -----------------------------------------------------------------

export interface OrcaView {
  readonly at: string | null
  readonly worktreeIds: readonly string[] | null
  readonly terminals: readonly OrcaTerminal[]
}

export interface OrcaCache {
  /** Stale-while-revalidate: awaits only the very first read. */
  readonly read: () => Promise<OrcaView>
}

export const createOrcaCache = (loaded: LoadedLoopConfig, runner: CommandRunner, now: () => Date = () => new Date(), ttlMs = ORCA_TTL_MS): OrcaCache => {
  let view: OrcaView = { at: null, worktreeIds: null, terminals: [] }
  let fetchedAtMs = Number.NEGATIVE_INFINITY
  let inFlight: Promise<OrcaView> | null = null
  const refresh = (): Promise<OrcaView> => {
    inFlight ??= (async () => {
      const options = { bin: loaded.config.orca?.bin, timeoutMs: loaded.config.orca?.timeoutMs ?? 20_000 }
      try {
        const [worktrees, terminals] = await Promise.all([orcaWorktrees(runner, options), orcaTerminalList(runner, {}, options).catch(() => view.terminals)])
        view = { at: now().toISOString(), worktreeIds: worktrees.map((worktree) => worktree.id), terminals }
      } catch { /* keep the last good view; freshness goes stale on its own */ }
      fetchedAtMs = now().getTime()
      inFlight = null
      return view
    })()
    return inFlight
  }
  return {
    read: async () => {
      if (fetchedAtMs === Number.NEGATIVE_INFINITY) return refresh()
      if (now().getTime() - fetchedAtMs > ttlMs) void refresh()
      return view
    },
  }
}

const orcaCaches = new Map<string, OrcaCache>()
/** One Orca cache per state dir, shared by the snapshot and the issue-detail route. */
export const orcaCacheFor = (loaded: LoadedLoopConfig, runner: CommandRunner): OrcaCache => {
  let cache = orcaCaches.get(loaded.stateDir)
  if (!cache) { cache = createOrcaCache(loaded, runner); orcaCaches.set(loaded.stateDir, cache) }
  return cache
}

// ---- windowed event tail, re-parsed only when the file changes -----------------------------------------------

const eventsKey = (stateDir: string): string => {
  const path = join(stateDir, 'events.ndjson')
  if (!existsSync(path)) return 'none'
  const stat = statSync(path)
  return `${stat.mtimeMs}:${stat.size}`
}

const createEventTail = (stateDir: string) => {
  let key = ''
  let events: readonly LoopEvent[] = []
  return (now: Date): readonly LoopEvent[] => {
    const next = eventsKey(stateDir)
    if (next !== key) {
      const sinceMs = now.getTime() - STOP_WINDOW_MS
      events = readLoopEvents(stateDir, sinceMs).filter((event) => Date.parse(event.at) >= sinceMs)
      key = next
    }
    return events
  }
}

/** Last sign of life from the loop: `paused.json` is rewritten by every `loop stage` run, `events.ndjson` by any work. */
const loopHeartbeat = (stateDir: string): string | null => {
  // ponytail: file mtimes stand in for a heartbeat file the stages do not write; an idle tick that throws before `recordStageRunResult` is invisible here.
  const times = ['paused.json', 'events.ndjson'].map((name) => join(stateDir, name)).filter(existsSync).map((path) => statSync(path).mtimeMs)
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

// ---- automations, read at most once a minute ----------------------------------------------------------------

const createAutomationsCache = (loaded: LoadedLoopConfig, runner: CommandRunner) => {
  let rows: AttentionInput['automations'] = []
  let fetchedAtMs = Number.NEGATIVE_INFINITY
  let inFlight = false
  return (now: Date): AttentionInput['automations'] => {
    if (!inFlight && now.getTime() - fetchedAtMs > AUTOMATIONS_TTL_MS) {
      inFlight = true
      fetchedAtMs = now.getTime()
      void (async () => {
        try {
          const existing = await orcaAutomationsList(runner, { bin: loaded.config.orca?.bin, timeoutMs: loaded.config.orca?.timeoutMs ?? 20_000 })
          const since = new Date().toISOString()
          rows = reconcileAutomations(automationSpecs(loaded, ''), existing, loaded.config)
            .filter((row) => row.state !== 'in-sync')
            .map((row) => ({ name: row.name, stage: row.stage, state: row.state as 'missing' | 'drifted' | 'undeclared', fields: row.fields, since: rows.find((old) => old.name === row.name && old.state === row.state)?.since ?? since }))
        } catch { /* Orca unreachable: its freshness already says so; no automation claims either way */ }
        finally { inFlight = false }
      })()
    }
    return rows
  }
}

// ---- tracker state for issues off the board ---------------------------------------------------------------------

const TRACKER_TTL_MS = 10 * 60_000
const TRACKER_LOOKUPS_PER_CYCLE = 8

/**
 * The board lists only the queue's open states, so an issue the loop still shows as blocked or running but that
 * someone closed in the tracker has no tracker state at all — the "26 blocked, half of them cancelled" bug. This
 * looks those issues up one by one in the background (bounded per cycle, cached for 10 min) so reconciliation and
 * attention can see they are closed. Reads never wait on it; an unknown state stays unknown, never "closed".
 */
export const createTrackerStateCache = (lookup: (issue: string) => Promise<string>, now: () => number = Date.now) => {
  const states = new Map<string, { readonly state: string; readonly at: number }>()
  const pending = new Set<string>()
  return (issues: readonly string[]): Readonly<Record<string, string>> => {
    const due = issues.filter((issue) => !pending.has(issue) && (now() - (states.get(issue)?.at ?? -Infinity)) > TRACKER_TTL_MS).slice(0, TRACKER_LOOKUPS_PER_CYCLE)
    for (const issue of due) {
      pending.add(issue)
      void lookup(issue).then((state) => { states.set(issue, { state, at: now() }) }).catch(() => { /* unknown stays unknown */ }).finally(() => pending.delete(issue))
    }
    return Object.fromEntries(issues.flatMap((issue) => { const hit = states.get(issue); return hit ? [[issue, hit.state]] : [] }))
  }
}

// ---- the builder ------------------------------------------------------------------------------------------

export interface ExtrasInput {
  readonly issues: readonly IssueRecord[]
  readonly board: BoardSnapshot | null
  readonly dispatches: readonly DispatchRecordFile[]
  readonly deliveries: ReadonlyMap<string, DeliveryState>
  readonly maxAgents: number
}

export interface ExtrasBuilder {
  readonly build: (input: ExtrasInput) => Promise<SnapshotExtras>
}

export const createExtrasBuilder = (loaded: LoadedLoopConfig, runner: CommandRunner, options: { readonly now?: () => Date; readonly orca?: OrcaCache; readonly trackerState?: (issues: readonly string[]) => Readonly<Record<string, string>> } = {}): ExtrasBuilder => {
  const now = options.now ?? (() => new Date())
  const orca = options.orca ?? orcaCacheFor(loaded, runner)
  const tail = createEventTail(loaded.stateDir)
  const automations = createAutomationsCache(loaded, runner)
  const trackerStates = options.trackerState ?? createTrackerStateCache(async (issue) => (await resolveConnectors({ runner, config: loaded.config }).tracker.issue(issue)).state)
  const { stateDir, config } = loaded

  return {
    build: async (raw) => {
      const at = now()
      const onBoard = new Set((raw.board?.issues ?? []).map((issue) => issue.identifier))
      const offBoard = raw.issues.filter((record) => !record.trackerState && !onBoard.has(record.issue) && record.phase !== 'available' && record.phase !== 'completed' && !record.run?.archived).map((record) => record.issue)
      const known = trackerStates(offBoard)
      const input: ExtrasInput = { ...raw, issues: raw.issues.map((record) => known[record.issue] ? { ...record, trackerState: known[record.issue]! } : record) }
      const staleAfterMs = staleAfterMsFor(loaded)
      const orcaView = await orca.read()
      const { drift, freshness } = reconcile({
        now: at, staleAfterMs, issues: input.issues, board: input.board,
        boardRefreshMs: (config.github?.issues?.refreshSeconds ?? 60) * 1_000,
        dispatches: input.dispatches.map((dispatch) => ({ issue: dispatch.issue, worktreeId: dispatch.worktreeId, finished: Boolean(input.deliveries.get(dispatch.issue)?.finishedAt) })),
        claims: readActiveClaims(stateDir).map((claim) => ({ issue: claim.issue, claimedAt: claim.claimedAt })),
        orca: { at: orcaView.at, worktreeIds: orcaView.worktreeIds }, orcaStaleAfterMs: Math.max(staleAfterMs, 4 * ORCA_TTL_MS),
        loopAt: loopHeartbeat(stateDir), maxAgents: input.maxAgents,
      })
      const locks = computeLocks(input.issues, drift, freshness)

      const events = tail(at)
      const systemSince = at.getTime() - SYSTEM_WINDOW_MS
      const recent = events.filter((event) => Date.parse(event.at) >= systemSince)
      const dispatchByIssue = new Map(input.dispatches.map((dispatch) => [dispatch.issue, dispatch]))
      const delivery: Record<string, AttentionInput['delivery'][string]> = {}
      for (const record of input.issues) {
        if (record.phase !== 'blocked' && record.reviewState !== 'human-approval') continue
        const state = input.deliveries.get(record.issue) ?? readDeliveryState(stateDir, record.issue)
        delivery[record.issue] = { fixRounds: state.fixRounds, heldFor: state.heldFor, maxFixRounds: record.run?.maxFixRounds ?? dispatchByIssue.get(record.issue)?.frozenMaxFixRounds ?? config.delivery?.maxFixRounds ?? null }
      }
      const release = readReleaseState(stateDir)
      const releaseWaiting = release.waitingNotifiedFor && release.approval?.head !== release.waitingNotifiedFor ? release.waitingNotifiedFor : null
      const stagePause = readStagePause(stateDir)
      const cooldowns = readCooldowns(stateDir)

      const attention = buildAttention({
        now: at, issues: input.issues, drift, locks, stops: latestStops(events), delivery,
        boardStates: Object.fromEntries((input.board?.issues ?? []).map((issue) => [issue.identifier, issue.lane === 'done' ? 'Done' : issue.state])),
        pausedIssues: input.issues.filter((record) => record.phase === 'blocked' && isIssuePaused(stateDir, record.issue)).map((record) => record.issue),
        plans: listPlans(stateDir).flatMap((plan): AttentionInput['plans'] => plan.phase === 'review' && !plan.approvals?.plan
          ? [{ id: plan.id, objective: plan.objective, gate: 'plan' as const, since: plan.updatedAt }]
          : plan.phase === 'architect' && !plan.approvals?.design && config.worker?.plan && designApproved(plan, config) ? [{ id: plan.id, objective: plan.objective, gate: 'design' as const, since: plan.updatedAt }] : []),
        release: releaseWaiting ? { head: releaseWaiting, since: events.filter((event) => event.type === 'release.waiting').at(-1)?.at ?? at.toISOString() } : null,
        stagePauses: Object.entries(stagePause).flatMap(([stage, entry]) => entry?.pausedAt ? [{ stage, since: entry.pausedAt, reason: entry.pausedReason }] : []),
        cooldowns: Object.entries(cooldowns).filter(([provider]) => provider in activeCooldowns(cooldowns, at)).map(([provider, entry]) => ({ provider, until: entry.until, reason: entry.reason, since: entry.markedAt })),
        syncFailures: recent.filter((event) => event.type === 'tracker.sync-failed').map((event) => ({ issue: typeof event.issue === 'string' ? event.issue : null, operation: typeof event['operation'] === 'string' ? event['operation'] : null, error: typeof event['error'] === 'string' ? event['error'] : null, at: event.at })),
        pii: recent.filter((event) => event.type === 'security.pii-detected').map((event) => ({ issue: typeof event.issue === 'string' ? event.issue : null, kinds: Array.isArray(event['kinds']) ? event['kinds'].filter((kind): kind is string => typeof kind === 'string') : [], at: event.at })),
        automations: automations(at),
      })
      return { freshness, drift, attention, locks, staleAfterMs }
    },
  }
}
