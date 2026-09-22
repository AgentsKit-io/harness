import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { fetchLinearQueue, linearLabelRemove, type LinearIssueDetail, type LoopIssue } from '../adapters/linear-orca.js'
import { resolveConnectors, type TrackerConnector } from './connectors.js'
import { createOrcaDispatchPlan } from '../adapters/orca.js'
import { orcaAccountList, orcaAgentHooks, orcaDiagnosticsMemory, orcaTerminalCreate, orcaTerminalSend, orcaTerminalWait, orcaWorktreeCreate, orcaWorktreeRemove, orcaWorktrees, type OrcaWorktree } from '../adapters/orca-cli.js'
import { detectProviders, type ProviderAvailability } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError } from '../kernel/errors.js'
import { renderWorkerBrief } from './brief.js'
import { readStoredPlan, runPlanWithVotes, writeStoredPlan, type StoredPlan } from './plan-vote.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { loadPinnedSkills, skillRefs, skillDigest, type PinnedSkillRef } from './skills.js'
import { loadLoopConfig, providerIdentity, type EffortLevel, type LoadedLoopConfig, type LoopConfig, type ModelReference } from './config.js'
import { assessContract, contractIsFresh, extractResetsAt, generateContract, readStoredContract, resolveDocContext, writeStoredContract, type StoredContract } from './contract.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { countRunningWorkers, providerSpecs } from './doctor.js'
import { ensureBaseView, type BaseView } from './base-view.js'
import { ARTIFACT_DIR, excludeArtifactsFromGit } from './artifacts.js'
import { openLoopMemory, planMemoryContext } from './memory.js'
import { clearIssueFailures, isIssuePaused, pauseIssue, readIssueFailures, recordIssueFailure } from './resilience-state.js'
import { MODEL_ROLES, type ModelRole } from '../kernel/model-policy.js'
import { resolveCatalogCandidates } from './model-catalog/index.js'
import { rankModels, routeAllRoles, type RoutingDecision } from './routing.js'
import { assessSlots, type SlotAssessment, type SlotInput } from './slots.js'
import { markProviderExhausted } from './cooldown.js'
import { advanceQueueOwner, countRotationBlockingLeases, queueOwner } from './rotation.js'
import { createLoopEventBus, loadLoopPlugins, type LoopEventBus, type LoopEventPayload } from './event-bus.js'
import { attachNotifier } from './notify.js'
import { applyRoleSettings, resolveFlow, resolveRoleSettings, workerPhaseEnabled } from './flows.js'
import { installWorkerGuard } from './worker-guard.js'

export type TickOutcome = 'dispatched' | 'dry-run' | 'skipped' | 'escalated' | 'failed'

export interface TickCandidateResult {
  readonly issue: string
  readonly outcome: TickOutcome
  readonly reason: string
  readonly branch?: string
  readonly worktree?: string
  readonly worktreeId?: string
  readonly terminal?: string | null
  readonly provider?: string
  readonly model?: string
  readonly argv?: readonly string[]
  readonly contractDigest?: string
}

export interface TickReport {
  readonly status: 'ok' | 'idle' | 'blocked'
  readonly generatedAt: string
  readonly dryRun: boolean
  readonly slots: Pick<SlotAssessment, 'maxAgents' | 'running' | 'free' | 'reasons'>
  readonly routing: { readonly orchestrator: string | null; readonly builder: string | null }
  readonly queue: { readonly total: number; readonly busy: readonly string[]; readonly candidates: readonly string[] }
  readonly results: readonly TickCandidateResult[]
  readonly notes: readonly string[]
}

export interface DispatchRecordFile {
  readonly issue: string
  readonly worktreeId: string
  readonly worktree: string
  readonly branch: string
  readonly terminal: string | null
  readonly provider: string
  readonly model: string
  readonly contractDigest: string
  readonly leaseKey: string
  readonly leaseId: string
  readonly dispatchedAt: string
  readonly url: string
  readonly briefDigest: string
  readonly skills: readonly PinnedSkillRef[]
  /**
   * How this worker was told to work when its flow asked it to lead: `subagents` when the provider has them,
   * `alone` when it does not. Absent when no flow asked. Recorded because a lead that never led is otherwise
   * invisible to whoever reads the config and expects delegation.
   */
  readonly delegation?: 'subagents' | 'alone'
  readonly setup: { readonly command: readonly string[]; readonly exitCode: number | null; readonly durationMs: number; readonly timedOut: boolean } | null
  readonly effort: EffortLevel
  /** Builder provider's remaining Orca usage percent at dispatch time (`resilience.maxUsageDeltaPercent` cost guard); `null` when usage was unknown. */
  readonly initialRemainingPercent: number | null
  /**
   * Absolute path to the Orca worktree, so `loop status`/`debrief`/`watch` can best-effort read `progress.json`
   * from it.
   *
   * Optional because it genuinely is: a record written before this field existed, or one whose worktree was
   * removed, has none — `deliver` has always branched on that when reading phase artifacts. Declaring it
   * required made the type a claim the disk does not keep, and `installWorkerGuard` trusted the claim and threw
   * on a handoff. The compiler is the right place to catch that, not a stack trace three stages later.
   */
  readonly worktreePath?: string
  /**
   * The issue's labels at dispatch time, frozen here so `deliver` can resolve `reviewOverrides` without
   * a second Linear read — and so a label edited mid-flight cannot change the gate a running item is
   * judged by. Absent on records written before this field existed; readers fall back to no override.
   */
  readonly labels?: readonly string[]
  /** Project and priority at dispatch time, frozen for the same reason as `labels`: they select the flow profile (`flows.select`), and the gate an item is judged by must not move while it runs. */
  readonly project?: string | null
  readonly priorityLabel?: string | null
  /**
   * Whether `worker-guard` (real-time enforcement of `selfEditPaths`/`secretFilePatterns` inside the worker's own
   * session, see ADR-0038) was actually installed for this dispatch — `false` for a provider it does not cover
   * yet (`codex`) or when `delivery.workerGuard.enabled` is off. A record without this field predates the feature.
   */
  readonly workerGuardInstalled?: boolean
}

export interface TickInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  readonly dryRun?: boolean
  /** Upper bound on dispatches this tick, independent of free slots. */
  readonly maxDispatch?: number
  /** Restrict the tick to one issue identifier (still subject to slots and filters). */
  readonly onlyIssue?: string
  /** Skip contract generation when nothing is cached (dry runs); the candidate is reported instead of dispatched. */
  readonly skipContractGeneration?: boolean
  readonly owner?: string
  /** Test seam: override live machine sampling. */
  readonly machine?: Pick<SlotInput, 'sample' | 'freeBytes' | 'totalBytes' | 'osRelease'>
  /** Wall-clock budget for this tick; candidates that would not fit are left for the next tick. */
  readonly budgetMs?: number
  /** An externally-owned event bus (e.g. `loop stage`, unifying every stage's events on one bus for that
   * invocation). When set, this call neither loads plugins nor attaches the notifier on it — the owner already
   * did, and the owner is the one who flushes it once the whole invocation is done. Omit to keep this call
   * self-sufficient, as every direct caller (`loop tick`, tests, library use) needs it to be. */
  readonly bus?: LoopEventBus
}

/** Launch the worker in a fresh terminal with the configured TUI command and hand it the brief. Returns the terminal handle. */
/** What the terminal receives when the brief travels as a file: short, plain, and the same for every task. */
export const BRIEF_POINTER_PROMPT = `Your full task brief is in ${ARTIFACT_DIR}/brief.md at the root of this worktree. Read the whole file first, then follow it exactly.`

/**
 * Open the worker's terminal and hand it the brief.
 *
 * With `worktreePath`, the brief is written to `.ak-loop/brief.md` in the worktree (excluded from git at dispatch)
 * and the terminal gets one short line pointing at it. Typing tens of kilobytes into an agent TUI is fragile in ways
 * no retry fixes: a real 44 KB brief failed every send with `agent_session_ownership_unknown`, deterministically,
 * while random text of the same size and line count went through — the TUI's paste handling reacts to content.
 */
export const launchWorkerTerminal = async (input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly worktreeId: string; readonly command: string; readonly title: string; readonly brief: string; readonly worktreePath?: string; readonly idleTimeoutMs?: number }): Promise<{ readonly terminal: string; readonly accepted: boolean; readonly idle: boolean }> => {
  let prompt = input.brief
  if (input.worktreePath) {
    const dir = join(input.worktreePath, ARTIFACT_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'brief.md'), input.brief, 'utf8')
    prompt = BRIEF_POINTER_PROMPT
  }
  const orca = { bin: input.config.orca.bin, timeoutMs: input.config.orca.timeoutMs }
  const created = await orcaTerminalCreate(input.runner, { worktree: `id:${input.worktreeId}`, command: input.command, title: input.title }, orca)
  const initialIdleTimeoutMs = input.idleTimeoutMs ?? 90_000
  let idle = false
  try { idle = (await orcaTerminalWait(input.runner, { terminal: created.handle, for: 'tui-idle', timeoutMs: initialIdleTimeoutMs }, orca)).satisfied } catch { idle = false }
  // Orca can finish creating a TUI after the first readiness window. Never send into a
  // non-ready pane: that loses the prompt and produces `agent_prompt_blocked`.
  if (!idle) {
    try { idle = (await orcaTerminalWait(input.runner, { terminal: created.handle, for: 'tui-idle', timeoutMs: Math.min(initialIdleTimeoutMs * 2, 180_000) }, orca)).satisfied } catch { idle = false }
  }
  if (!idle) throw new Error(`terminal ${created.handle} did not become tui-idle before the worker prompt deadline`)
  const receipt = await orcaTerminalSend(input.runner, { terminal: created.handle, text: prompt, enter: true, waitSubmitSeconds: 15 }, orca)
  return { terminal: created.handle, accepted: receipt.accepted, idle }
}

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)

/** Worktree name: last branch segment, lowercase, safe charset, ≤ 60 chars. */
export const worktreeNameFor = (issue: Pick<LoopIssue, 'identifier' | 'branchName'>): string => {
  const source = (issue.branchName ?? `loop/${issue.identifier}`).split('/').pop() ?? issue.identifier
  const cleaned = source.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned || issue.identifier.toLowerCase()).slice(0, 60)
}

export const branchFor = (issue: Pick<LoopIssue, 'identifier' | 'branchName'>, person: string): string => issue.branchName ?? `${person}/${issue.identifier.toLowerCase()}`

/** Issues the loop must not touch: active leases, worktrees already linked to the issue, or a worktree sitting on the issue's branch. */
export const busyIssues = (queue: readonly LoopIssue[], leases: readonly DispatchLease[], worktrees: readonly OrcaWorktree[], person: string): ReadonlySet<string> => {
  const busy = new Set<string>(leases.map((lease) => lease.issue))
  const linked = new Set(worktrees.filter((item) => !item.isArchived).map((item) => item.linkedLinearIssue).filter((value): value is string => Boolean(value)))
  const branches = new Set(worktrees.filter((item) => !item.isArchived).map((item) => item.branch))
  for (const issue of queue) {
    if ([...linked].some((link) => link === issue.identifier || link === issue.url || link.endsWith(`/${issue.identifier}`) || link.includes(`/${issue.identifier}/`))) busy.add(issue.identifier)
    if (branches.has(branchFor(issue, person))) busy.add(issue.identifier)
  }
  return busy
}

export const dispatchRecordPath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'dispatch.json')
export const briefPath = (stateDir: string, identifier: string): string => join(stateDir, 'issues', identifier, 'brief.md')
/**
 * The fields every reader of a dispatch record dereferences without checking. Anything beyond these is read
 * defensively already (`labels ?? []`, `worktreePath` guarded, `dispatchedAt` absent yields a null age in
 * `debrief`), so the schema deliberately does not restate the whole interface — it asserts the load-bearing
 * core and lets the rest through. Requiring more would turn a record the loop handles today into an absent one.
 *
 * `JSON.parse(...) as DispatchRecordFile` was a claim about a file on disk that nothing had checked: a record
 * missing a required field passed the cast and failed much later, somewhere that looked unrelated. Parsing keeps
 * the failure at the boundary, where the file name is still in hand.
 */
const DispatchRecordCore = z.object({
  issue: z.string().min(1),
  worktreeId: z.string().min(1),
  branch: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
})

export const readDispatchRecord = (stateDir: string, identifier: string): DispatchRecordFile | null => {
  const path = dispatchRecordPath(stateDir, identifier)
  if (!existsSync(path)) return null
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  // Same answer as an unreadable file — every caller already handles `null` — but now a structurally invalid
  // record is caught here rather than three stages later, as a missing property on something typed as present.
  return DispatchRecordCore.safeParse(raw).success ? raw as DispatchRecordFile : null
}
export const writeDispatchRecord = (stateDir: string, record: DispatchRecordFile): string => {
  const path = dispatchRecordPath(stateDir, record.issue)
  writeJsonAtomic(path, record)
  return path
}

/** A fresh dispatch is a new delivery attempt; do not let a previous stuck/blocked attempt keep precheck idle. */
const resetDeliveryStateForDispatch = (stateDir: string, issue: string): void => {
  const path = join(stateDir, 'issues', issue, 'delivery.json')
  if (!existsSync(path)) return
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { readonly finalOutcome?: unknown }
    if (!['stuck', 'blocked', 'abandoned'].includes(String(previous.finalOutcome))) return
  } catch { return }
  // `writeJsonAtomic` e não `writeJson`: o remoto trocou toda escrita de estado por escrita atômica
  // (PR #80), e um reset de estado de entrega escrito pela metade é pior que nenhum reset.
  writeJsonAtomic(path, { issue, prNumber: null, reviews: {}, fixRounds: 0, nudges: [], handoffs: [], heldFor: null, finishedAt: null, finalOutcome: null })
}
/** Above this, the hot `events.ndjson` file rotates to an archive instead of growing forever — a 24/7 loop
 * emits several events per dispatch, and every `retro`/`debrief` read loads the whole file into memory. */
const EVENTS_ROTATE_AT_BYTES = 10 * 1024 * 1024
const EVENTS_LOCK_STALE_MS = 5_000
const EVENTS_LOCK_MAX_ATTEMPTS = 100
const EVENTS_LOCK_RETRY_MS = 10
/** windowed: rotation never used to delete anything, so archives (each named by rotation time) accumulated for
 * the life of the project. Pruning here — the one place that already touches the state dir at rotation time —
 * keeps that bounded without adding a scan to every append. */
const EVENTS_RETENTION_MS = 30 * 86_400_000
const eventsArchivePattern = /^events-archive-(\d+)\.ndjson$/

const pruneEventArchives = (stateDir: string, nowMs: number): void => {
  let names: readonly string[]
  try { names = readdirSync(stateDir) } catch { return }
  for (const name of names) {
    const match = name.match(eventsArchivePattern)
    if (match && nowMs - Number(match[1]) > EVENTS_RETENTION_MS) { try { unlinkSync(join(stateDir, name)) } catch { /* best-effort */ } }
  }
}

/**
 * `tick` and `deliver` are separate scheduled processes that can call `appendLoopEvent` on the same
 * `events.ndjson` at (near-)the same instant. Without a lock, two processes that both see the file over
 * `EVENTS_ROTATE_AT_BYTES` could both rename it — a same-millisecond timestamp collision overwrites one
 * process's archive, or one process's rename "succeeds" against a file the other already moved, silently
 * dropping events. Serializing only the rotation decision (not the append itself) is enough: even a write that
 * lands in the archive instead of the fresh file mid-rotation is not data loss, since `readLoopEvents` merges
 * archives back in — the lock only needs to stop two processes from racing the rename itself.
 */
const acquireEventsLock = (lockFilePath: string): number | null => {
  for (let attempt = 0; attempt < EVENTS_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return openSync(lockFilePath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(lockFilePath).mtimeMs > EVENTS_LOCK_STALE_MS) unlinkSync(lockFilePath) } catch { /* another process already cleared it, or still holds it */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EVENTS_LOCK_RETRY_MS)
    }
  }
  return null
}

export const appendLoopEvent = (stateDir: string, event: LoopEventPayload, bus?: LoopEventBus, now: () => Date = () => new Date()): void => {
  const path = join(stateDir, 'events.ndjson')
  mkdirSync(dirname(path), { recursive: true })
  const lockFilePath = `${path}.lock`
  const lockFd = acquireEventsLock(lockFilePath)
  try {
    // Rotation only runs when the lock was actually acquired — skipping it under contention (rather than racing
    // the rename unlocked) is always safe: the file just grows a little past the threshold until the next
    // successful attempt rotates it.
    if (lockFd !== null) {
      try {
        if (statSync(path).size > EVENTS_ROTATE_AT_BYTES) {
          const nowMs = now().getTime()
          renameSync(path, join(stateDir, `events-archive-${nowMs}.ndjson`))
          pruneEventArchives(stateDir, nowMs)
        }
      } catch { /* rotation is best-effort — never let it break event logging itself */ }
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
  } finally {
    if (lockFd !== null) {
      try { closeSync(lockFd) } catch { /* already closed */ }
      try { unlinkSync(lockFilePath) } catch { /* already removed */ }
    }
  }
  if (bus && typeof event['type'] === 'string') bus.emit(event as LoopEventPayload)
}

export interface LoopState {
  readonly person: string
  readonly providers: readonly ProviderAvailability[]
  readonly routing: Readonly<Record<string, RoutingDecision>>
  readonly worktrees: readonly OrcaWorktree[]
  readonly slots: SlotAssessment
  readonly queue: readonly LoopIssue[]
  readonly leases: readonly DispatchLease[]
  readonly busy: ReadonlySet<string>
  readonly candidates: readonly LoopIssue[]
  /** Catalog-discovered candidates per role (`models.routing.mode: catalog`), already resolved for `routing` above — reused by `runTick` for `generateContract`'s candidate fallback so it isn't resolved twice per tick. */
  readonly extrasByRole: Partial<Record<ModelRole, readonly ModelReference[]>>
}

export const gatherLoopState = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly ledger: DispatchLedger; readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly now: () => Date; readonly onlyIssue?: string; readonly machine?: TickInput['machine'] }): Promise<LoopState> => {
  const { config } = input.loaded
  const person = queueOwner(input.loaded)
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const [accountList, agentHooks, worktrees, queue, orcaMemory] = await Promise.all([
    orcaAccountList(input.runner, orca).catch(() => ({})),
    orcaAgentHooks(input.runner, orca).catch(() => ({}) as Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>>),
    orcaWorktrees(input.runner, orca),
    fetchLinearQueue(input.runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: person, filter: config.linear, orca }),
    orcaDiagnosticsMemory(input.runner, orca),
  ])
  const providers = await detectProviders({ providers: providerSpecs(config), accountList, agentHooks, env: input.env, platform: input.platform, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(readCooldowns(input.loaded.stateDir), input.now()), now: input.now })
  const availableIds = providers.filter((provider) => provider.available).map((provider) => provider.id)
  const extrasByRole: Partial<Record<ModelRole, readonly ModelReference[]>> = config.models.routing.mode === 'catalog'
    ? Object.fromEntries(await Promise.all(MODEL_ROLES.map(async (role) => [role, await resolveCatalogCandidates({
      config,
      role,
      availableProviderIds: availableIds,
      runner: input.runner,
      stateDir: input.loaded.stateDir,
      env: input.env,
      now: input.now,
    })] as const)))
    : {}
  const routing = routeAllRoles(config, providers, extrasByRole)
  const running = countRunningWorkers(worktrees)
  const slots = assessSlots({ machine: config.machine, running, platform: input.platform, orcaMemory, ...input.machine })
  const leases = input.ledger.active()
  const busy = busyIssues(queue, leases, worktrees, person)
  const candidates = queue.filter((issue) => !busy.has(issue.identifier) && (!input.onlyIssue || issue.identifier === input.onlyIssue))
  return { person, providers, routing, worktrees, slots, queue, leases, busy, candidates, extrasByRole }
}

/** Read-only: exit-0 semantics for Orca `--precheck`. Work exists when a slot is free, a builder is routable, and a candidate waits. */
export const precheckTick = async (input: Omit<TickInput, 'dryRun' | 'maxDispatch'>): Promise<{ readonly work: boolean; readonly reason: string; readonly free: number; readonly candidates: number }> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const now = input.now ?? (() => new Date())
  const state = await gatherLoopState({ loaded, runner: input.runner, ledger: createDispatchLedger(loaded.stateDir), env: input.env, platform: input.platform, now, onlyIssue: input.onlyIssue, machine: input.machine })
  const builder = state.routing['builder']?.selected ?? null
  const reason = state.slots.free <= 0 ? `no free slot (${state.slots.running}/${state.slots.maxAgents})` : !builder ? 'no builder provider available' : !state.candidates.length ? 'queue has no dispatchable candidate' : `${Math.min(state.slots.free, state.candidates.length)} dispatch(es) possible`
  return { work: state.slots.free > 0 && Boolean(builder) && state.candidates.length > 0, reason, free: state.slots.free, candidates: state.candidates.length }
}

const escalate = async (input: { readonly tracker: TrackerConnector; readonly config: LoopConfig; readonly issue: LinearIssueDetail; readonly stored: StoredContract; readonly dryRun: boolean }): Promise<void> => {
  if (input.dryRun) return
  const body = `**Loop: not dispatched — needs information**\n\nThe orchestrator (${input.stored.provider}/${input.stored.model}) could not freeze a verifiable contract:\n${input.stored.assessment.reasons.map((reason) => `- ${reason}`).join('\n')}\n\nIntent it inferred: ${input.stored.contract.intent}\n\nAnswer in this issue (or edit the description with acceptance criteria) and remove the \`${input.config.linear.needsInfoLabel}\` label; the loop will re-evaluate on the next tick.\n\n<!-- loop:needs-info:${input.stored.digest} -->`
  await input.tracker.comment({ issue: input.issue.identifier, body, dedupeKey: `needs-info:${input.issue.identifier}:${input.stored.digest}` })
  await input.tracker.addLabels(input.issue.identifier, [input.config.linear.needsInfoLabel])
}

/**
 * The plan the votes could not agree on becomes a human's problem, with the objections still standing attached.
 * Three models disagreeing three times is an ambiguous requirement, not a retry.
 */
const escalatePlan = async (input: { readonly tracker: TrackerConnector; readonly config: LoopConfig; readonly issue: LinearIssueDetail; readonly plan: StoredPlan; readonly dryRun: boolean }): Promise<void> => {
  if (input.dryRun) return
  const body = `**Loop: not dispatched — the plan did not reach consensus**\n\n${input.plan.votes.filter((vote) => vote.vote === 'approve').length} of ${input.plan.votes.length} agents approved after ${input.plan.cycles} cycle(s); ${input.config.worker.plan.approvals} are required.\n\nObjections still standing:\n${input.plan.unresolved.map((objection) => `- ${objection}`).join('\n') || '- none recorded'}\n\nProposed plan: ${input.plan.plan.summary}\n\nSettle the ambiguity in this issue and remove the \`${input.config.linear.needsInfoLabel}\` label; the loop will re-plan on the next tick.\n\n<!-- loop:no-consensus:${input.plan.digest} -->`
  await input.tracker.comment({ issue: input.issue.identifier, body, dedupeKey: `no-consensus:${input.issue.identifier}:${input.plan.digest}` })
  await input.tracker.addLabels(input.issue.identifier, [input.config.linear.needsInfoLabel])
}

export const runTick = async (input: TickInput): Promise<TickReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const now = input.now ?? (() => new Date())
  const dryRun = input.dryRun === true
  const ledger = createDispatchLedger(loaded.stateDir)
  const notes: string[] = []
  // The orchestrator reads the base branch as fetched now, not the operator's checkout — resolved once per tick,
  // and only when a model is actually about to be asked something.
  let baseView: Promise<BaseView> | null = null
  const readRoot = async (): Promise<string> => (await (baseView ??= ensureBaseView(input.runner, loaded))).path
  const results: TickCandidateResult[] = []
  const ownsBus = !input.bus
  const bus = input.bus ?? createLoopEventBus()
  if (ownsBus && config.plugins.modules.length) {
    const { errors } = await loadLoopPlugins(loaded.root, config.plugins.modules, bus)
    for (const failure of errors) notes.push(`plugin ${failure.path} failed to load: ${failure.error}`)
  }
  // The configured escalation channels listen on the same bus as any plugin, and every exit of this function waits
  // for the sends in flight: a stage that ends before its notification leaves is a human who never hears about it.
  // An externally-owned bus (`loop stage`) already has its own notifier attached, and its owner flushes it once
  // for the whole invocation — attaching a second one here would double-send every notification.
  const flushNotifications = ownsBus ? attachNotifier(bus, { config, runner: input.runner, ...(input.env === undefined ? {} : { env: input.env }) }) : async () => { /* owner flushes */ }
  const state = await gatherLoopState({ loaded, runner: input.runner, ledger, env: input.env, platform: input.platform, now, onlyIssue: input.onlyIssue, machine: input.machine })
  const orchestrator = state.routing['orchestrator'] ?? { role: 'orchestrator', selected: null, skipped: [] }
  // `gatherLoopState` already resolved catalog candidates for every role (including orchestrator) to compute
  // `state.routing` — reuse that instead of resolving the same provider/model catalog a second time this tick.
  const orchestratorCandidates = rankModels(config, 'orchestrator', state.providers, state.extrasByRole['orchestrator'] ?? [])
  const onProviderFailure = (failure: { readonly provider: string; readonly kind: string; readonly detail: string }): void => {
    if (dryRun) return
    const resetsAt = extractResetsAt(failure.detail, now())
    const entry = markProviderExhausted(loaded.stateDir, failure.provider, { initialMin: config.models.cooldown.initialMin, maxMin: config.models.cooldown.maxMin, reason: `${failure.kind}: ${(failure.detail.split('\n')[0] ?? '').slice(0, 200)}`, resetsAt, now: now() })
    notes.push(`provider ${failure.provider} marked cooling down until ${entry.until} (${failure.kind})`)
    appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'provider.cooldown', provider: failure.provider, kind: failure.kind, until: entry.until }, bus)
  }
  const builder = state.routing['builder']?.selected ?? null
  const summary = { orchestrator: orchestrator.selected ? `${orchestrator.selected.provider}/${orchestrator.selected.model}` : null, builder: builder ? `${builder.provider}/${builder.model}` : null }
  const base = { generatedAt: now().toISOString(), dryRun, slots: { maxAgents: state.slots.maxAgents, running: state.slots.running, free: state.slots.free, reasons: state.slots.reasons }, routing: summary, queue: { total: state.queue.length, busy: [...state.busy], candidates: state.candidates.map((issue) => issue.identifier) } }
  if (!builder) { notes.push('no builder provider available; nothing dispatched'); await flushNotifications(); return { ...base, status: 'blocked', results, notes } }
  if (state.slots.free <= 0) { notes.push(`no free slot (${state.slots.running}/${state.slots.maxAgents})`); await flushNotifications(); return { ...base, status: 'idle', results, notes } }
  if (!state.candidates.length) {
    const rotation = dryRun ? { owner: state.person, advanced: false } : advanceQueueOwner(loaded, { queueEmpty: state.queue.length === 0, activeLeases: countRotationBlockingLeases(loaded, state.leases), now: now() })
    if (rotation.advanced) notes.push(`queue drained for ${state.person}; switched to ${rotation.owner}`)
    else notes.push('queue has no dispatchable candidate')
    await flushNotifications()
    return { ...base, status: 'idle', results, notes }
  }

  const budget = Math.min(state.slots.free, input.maxDispatch ?? state.slots.free)
  const startedAt = Date.now()
  const timeBudgetMs = input.budgetMs ?? Number.POSITIVE_INFINITY
  const remainingMs = (): number => timeBudgetMs - (Date.now() - startedAt)
  // Every tracker write in this stage goes through the connector; the engine never names Linear.
  const { tracker } = resolveConnectors({ runner: input.runner, config, dryRun })
  const tracking = tracker.transitions
  const memory = openLoopMemory(loaded)
  /**
   * Record a failure for `issue` and, once `resilience.maxConsecutiveFailures` is crossed, pause it: label it in
   * Linear (deduplicated comment explaining why) so it stops being retried every tick until a human removes the
   * label or runs `ak-harness loop resume <issue>`. Unlike the existing needs-info/blocked escalations, this covers
   * failures that happen *before* dispatch (contract generation, worktree creation) and therefore have no worktree
   * or lease to release — only the local failure counter and, optionally, a Linear label.
   */
  const recordFailureAndMaybePause = async (issue: string, kind: string, reason: string): Promise<void> => {
    if (dryRun) return
    const failureState = recordIssueFailure(loaded.stateDir, issue, kind, reason, now())
    if (failureState.consecutive < config.resilience.maxConsecutiveFailures) return
    pauseIssue(loaded.stateDir, issue, reason, now())
    const body = `**Loop: paused after ${failureState.consecutive} consecutive failures**\n\nMost recent (\`${kind}\`): ${reason.split('\n')[0]?.slice(0, 300)}\n\nThe loop will not retry this issue until you remove the \`${config.resilience.pausedLabel}\` label (or run \`ak-harness loop resume ${issue}\`).\n\n<!-- loop:paused:${issue}:${failureState.consecutive} -->`
    try {
      await tracker.comment({ issue, body, dedupeKey: `paused:${issue}:${failureState.consecutive}` })
      await tracker.addLabels(issue, [config.resilience.pausedLabel])
    } catch (error) { notes.push(`pause notification for ${issue} failed: ${message(error)}`) }
    appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'issue.paused', issue, kind, consecutive: failureState.consecutive, reason }, bus)
    await bus.runHook('onPause', { issue, kind, consecutive: failureState.consecutive, reason })
  }
  // `brief.skills` cannot change mid-tick — memoize the read+hash so several dispatches in the same tick share
  // one file read instead of one each. Kept lazy (not read until the first dispatch actually needs it) and called
  // from inside the per-candidate try/catch below, so a missing skill file still fails only that one candidate's
  // dispatch — exactly as before — instead of aborting the whole tick.
  let pinnedSkillsOnce: ReturnType<typeof loadPinnedSkills> | { readonly error: unknown } | undefined
  const getPinnedSkills = (): ReturnType<typeof loadPinnedSkills> => {
    if (pinnedSkillsOnce === undefined) {
      try { pinnedSkillsOnce = loadPinnedSkills(loaded.root, config.brief.skills, config.brief.maxSkillChars) }
      catch (error) { pinnedSkillsOnce = { error }; throw error }
    }
    if ('error' in pinnedSkillsOnce) throw pinnedSkillsOnce.error
    return pinnedSkillsOnce
  }
  let dispatched = 0
  for (const candidate of state.candidates) {
    if (dispatched >= budget) break
    // Reserve only the portion of the configured setup timeout that can fit this stage. A full 600 s setup
    // timeout must not make the 600 s stage mathematically unable to dispatch its first worker.
    const setupBudgetMs = config.project.setup.command
      ? Number.isFinite(timeBudgetMs) ? Math.min(config.project.setup.timeoutSec * 1000, Math.max(0, timeBudgetMs - config.contract.timeoutMs - 125_000)) : config.project.setup.timeoutSec * 1000
      : 0
    const cachedContract = readStoredContract(loaded.stateDir, candidate.identifier)
    // A cached contract saves the contract call, not the setup run — so only the contract's share of the budget
    // is waived. Skipping the whole check when a contract was cached let a candidate through with minutes left,
    // and the setup timeout below then floored at 1s: a command guaranteed to time out, and with
    // `setup.required` (default true) a guaranteed dispatch failure that also burned the worktree.
    const contractBudgetMs = cachedContract ? 0 : config.contract.timeoutMs
    if (remainingMs() < contractBudgetMs + setupBudgetMs + 120_000) { notes.push(`time budget: ${candidate.identifier} left for the next tick (${Math.round(remainingMs() / 1000)}s remaining)`); continue }
    const failureState = readIssueFailures(loaded.stateDir, candidate.identifier)
    if (failureState.pausedAt !== null) {
      if (candidate.labels.includes(config.resilience.pausedLabel)) { results.push({ issue: candidate.identifier, outcome: 'skipped', reason: `paused after ${failureState.consecutive} consecutive failures; remove the "${config.resilience.pausedLabel}" label or run "ak-harness loop resume ${candidate.identifier}" to retry` }); continue }
      // The pause label was removed on Linear since we last checked — treat that as the human's resume signal.
      if (!dryRun) clearIssueFailures(loaded.stateDir, candidate.identifier)
      notes.push(`${candidate.identifier}: resumed (the "${config.resilience.pausedLabel}" label was removed)`)
    }
    let detail: LinearIssueDetail
    try { detail = await tracker.issue(candidate.identifier) } catch (error) { results.push({ issue: candidate.identifier, outcome: 'failed', reason: `issue fetch failed: ${message(error)}` }); continue }

    // The flow this issue belongs to decides who runs each role and which phases run at all. Resolved once, here,
    // so the contract, the plan and the vote all answer to the same profile.
    const flow = resolveFlow(config, { labels: detail.labels, project: detail.project, priorityLabel: detail.priorityLabel })
    const orchestratorSettings = resolveRoleSettings(config, flow, 'orchestrator')
    // A flow may name the builder for its own issues. Without an override the tick-wide routing decision stands
    // for everyone, which is what every project that never drew a flow already has.
    const builderSettings = resolveRoleSettings(config, flow, 'builder')
    const worker = builderSettings.source === 'flow'
      ? applyRoleSettings(rankModels(config, 'builder', state.providers, state.extrasByRole['builder'] ?? []), builderSettings)[0] ?? builder
      : builder
    const issueOrchestrators = applyRoleSettings(orchestratorCandidates, orchestratorSettings)

    let stored = cachedContract
    // Reused below for the worker brief too (memory content cannot change mid-tick) — computing it once instead of
    // twice per dispatch halves this dispatch's memory-recall I/O (file reads + ranking) when memory.enabled.
    const memoryPlan = memory
      ? await planMemoryContext({
        adapter: memory,
        config,
        issueId: detail.identifier,
        issueTitle: detail.title,
        project: config.project.name,
        references: [],
      })
      : null
    if (stored && !contractIsFresh(stored, detail, config.contract.reuseHours, now(), memoryPlan?.memoryDigest)) stored = null
    if (!stored) {
      if (input.skipContractGeneration) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no cached contract; generation skipped' }); continue }
      if (!issueOrchestrators.length) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no orchestrator provider available to freeze a contract' }); continue }
      try {
        stored = await generateContract({
          runner: input.runner,
          config,
          root: await readRoot(),
          issue: detail,
          candidates: issueOrchestrators,
          orchestrator,
          ...(orchestratorSettings.timeoutMs === null ? {} : { timeoutMs: orchestratorSettings.timeoutMs }),
          now,
          memory,
          onProviderFailure,
          onMemoryPlan: (plan) => {
            if (!dryRun) appendLoopEvent(loaded.stateDir, {
              at: now().toISOString(),
              type: 'memory.recalled',
              issue: detail.identifier,
              hits: plan.hits.map((hit) => hit.record.id),
              docBridgeBefore: plan.docBridgeBefore,
              docBridgeAfter: plan.docBridgeAfter,
              approxCharsSaved: plan.approxCharsSaved,
              memoryDigest: plan.memoryDigest,
            }, bus)
          },
          onPiiDetected: (matches) => {
            if (!dryRun) appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'security.pii-detected', issue: detail.identifier, source: 'issue-text', kinds: [...new Set(matches.map((match) => match.kind))], count: matches.length }, bus)
          },
          onProviderCall: (event) => {
            if (!dryRun) appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'provider.call', role: 'orchestrator', issue: detail.identifier, ...event }, bus)
          },
        })
        if (!dryRun) {
          writeStoredContract(loaded.stateDir, stored)
          appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'contract.generated', issue: detail.identifier, provider: stored.provider, model: stored.model, effort: stored.effort, digest: stored.digest }, bus)
        }
      } catch (error) {
        const reason = `contract generation failed: ${message(error)}`
        if (!dryRun) { appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'contract.failed', issue: detail.identifier, error: message(error) }, bus); await recordFailureAndMaybePause(detail.identifier, 'contract.failed', reason) }
        results.push({ issue: detail.identifier, outcome: 'failed', reason })
        continue
      }
    }
    const assessment = assessContract(stored.contract)
    if (!assessment.dispatchable) {
      try { await escalate({ tracker, config, issue: detail, stored: { ...stored, assessment }, dryRun }) } catch (error) { notes.push(`escalation for ${detail.identifier} failed: ${message(error)}`) }
      if (!dryRun) {
        appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'contract.escalated', issue: detail.identifier, reasons: assessment.reasons, digest: stored.digest }, bus)
        await bus.runHook('onEscalate', { issue: detail.identifier, reasons: assessment.reasons, digest: stored.digest })
      }
      results.push({ issue: detail.identifier, outcome: 'escalated', reason: assessment.reasons.join('; '), contractDigest: stored.digest })
      continue
    }

    // The plan and its votes run here, headless, before any worktree exists: the model writes the plan and the
    // votes, the machine counts them. A worker is only launched once a plan has consensus.
    let approvedPlan: StoredPlan | null = null
    const planPhase = workerPhaseEnabled(config, flow, 'planner', config.worker.plan.enabled)
    const votePhase = workerPhaseEnabled(config, flow, 'vote', config.worker.plan.enabled)
    if (planPhase) {
      const plannerSettings = resolveRoleSettings(config, flow, 'planner')
      const voteSettings = resolveRoleSettings(config, flow, 'vote')
      approvedPlan = readStoredPlan(loaded.stateDir, detail.identifier)
      if (!approvedPlan || approvedPlan.contractDigest !== stored.digest || approvedPlan.status !== 'approved') {
        try {
          approvedPlan = await runPlanWithVotes({
            runner: input.runner, config, root: await readRoot(), issue: detail.identifier,
            contract: stored.contract, contractDigest: stored.digest,
            planner: applyRoleSettings(orchestratorCandidates, plannerSettings),
            voters: applyRoleSettings(rankModels(config, 'reviewer', state.providers, state.extrasByRole['reviewer'] ?? []), voteSettings),
            requireVotes: votePhase,
            ...(plannerSettings.timeoutMs === null ? {} : { plannerTimeoutMs: plannerSettings.timeoutMs }),
            ...(voteSettings.timeoutMs === null ? {} : { voteTimeoutMs: voteSettings.timeoutMs }),
            now, onProviderFailure,
            onCycle: (cycle, votes) => { if (!dryRun) appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'plan.voted', issue: detail.identifier, cycle, approvals: votes.filter((vote) => vote.vote === 'approve').length, votes: votes.length, voters: votes.map((vote) => ({ provider: vote.provider, model: vote.model, vote: vote.vote })) }, bus) },
            onProviderCall: (event) => {
              if (!dryRun) appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'provider.call', issue: detail.identifier, ...event }, bus)
            },
          })
          if (!dryRun) writeStoredPlan(loaded.stateDir, approvedPlan)
        } catch (error) {
          const reason = `planning failed: ${message(error)}`
          if (!dryRun) { appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'plan.failed', issue: detail.identifier, error: message(error) }, bus); await recordFailureAndMaybePause(detail.identifier, 'plan.failed', reason) }
          results.push({ issue: detail.identifier, outcome: 'failed', reason })
          continue
        }
      }
      if (approvedPlan.status !== 'approved') {
        try { await escalatePlan({ tracker, config, issue: detail, plan: approvedPlan, dryRun }) } catch (error) { notes.push(`plan escalation for ${detail.identifier} failed: ${message(error)}`) }
        if (!dryRun) {
          appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'plan.escalated', issue: detail.identifier, cycles: approvedPlan.cycles, unresolved: approvedPlan.unresolved }, bus)
          await bus.runHook('onEscalate', { issue: detail.identifier, reasons: approvedPlan.unresolved, digest: approvedPlan.digest })
        }
        results.push({ issue: detail.identifier, outcome: 'escalated', reason: `plan without consensus after ${approvedPlan.cycles} cycle(s): ${approvedPlan.unresolved.join('; ') || 'no objection recorded'}`, contractDigest: stored.digest })
        continue
      }
    }

    const branch = branchFor(detail, state.person)
    const worktree = worktreeNameFor(detail)
    const claim = ledger.claim({ tracker: 'linear', repository: config.project.repo, issue: detail.identifier, worktree, branch, owner: input.owner ?? `loop:${state.person}` })
    if (claim.decision === 'already-claimed') { results.push({ issue: detail.identifier, outcome: 'skipped', reason: `lease already held by ${claim.lease.owner} since ${claim.lease.claimedAt}` }); continue }
    const plan = createOrcaDispatchPlan({ repository: config.orca.repoSelector ?? `path:${loaded.root}`, worktree, branch, baseBranch: config.project.baseBranch, launch: 'worktree-only', linearIssue: detail.url || detail.identifier, comment: `loop · ${detail.identifier} · ${worker.provider}/${worker.model}`, noParent: true, orcaBin: config.orca.bin })
    const title = `loop ${detail.identifier} · ${worker.provider}`
    if (dryRun) {
      ledger.release(claim.lease, 'dry-run')
      results.push({ issue: detail.identifier, outcome: 'dry-run', reason: `would create worktree, open terminal "${worker.tui}", send the brief and move issue to In Progress (branch is assigned by Orca: <git user>/${worktree})`, branch, worktree, provider: worker.provider, model: worker.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
      continue
    }
    const beforeDispatch = await bus.runHook('beforeDispatch', { issue: detail.identifier, provider: worker.provider, model: worker.model, branch, worktree })
    if (beforeDispatch.block) {
      ledger.release(claim.lease, `blocked by plugin: ${beforeDispatch.reason}`)
      results.push({ issue: detail.identifier, outcome: 'skipped', reason: `blocked by plugin: ${beforeDispatch.reason}` })
      continue
    }
    let created: Awaited<ReturnType<typeof orcaWorktreeCreate>> | null = null
    try {
      created = await orcaWorktreeCreate(input.runner, plan.argv, { timeoutMs: Math.max(config.orca.timeoutMs, 120_000) })
      // Orca names the branch `<git user>/<worktree>`; the Linear branchName is only a hint. Record and brief the real one.
      const actualBranch = created.branch || branch
      // Real-time enforcement, before the worker's own setup command (let alone the worker itself) ever runs —
      // see ADR-0038 for which providers this covers and why.
      const workerGuard = installWorkerGuard({ worktreePath: created.path, provider: worker.provider, config })
      try { if (!(await excludeArtifactsFromGit(input.runner, created.path))) notes.push(`${detail.identifier}: could not exclude .ak-loop/ from git in ${created.path}`) } catch (error) { notes.push(`${detail.identifier}: excluding .ak-loop/ failed: ${message(error)}`) }
      let setupResult: { readonly command: readonly string[]; readonly exitCode: number | null; readonly durationMs: number; readonly timedOut: boolean } | null = null
      if (config.project.setup.command?.length) {
        // Floored at the window the guard above already reserved, not at 1s: if less than that is left, the
        // candidate never reached here, so there is no case where the floor should hand setup a doomed timeout.
        const setupTimeoutMs = Number.isFinite(timeBudgetMs) ? Math.max(setupBudgetMs, Math.min(config.project.setup.timeoutSec * 1000, remainingMs() - 120_000)) : config.project.setup.timeoutSec * 1000
        const setupRun = await input.runner.run(config.project.setup.command, { cwd: created.path, timeoutMs: setupTimeoutMs })
        setupResult = { command: config.project.setup.command, exitCode: setupRun.code, durationMs: setupRun.durationMs, timedOut: setupRun.timedOut }
        const setupFailed = setupRun.timedOut || setupRun.code !== 0
        appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'worker.setup', issue: detail.identifier, worktreeId: created.id, ...setupResult, ok: !setupFailed }, bus)
        if (setupFailed && config.project.setup.required) {
          const detailMsg = setupRun.timedOut ? `timed out after ${config.project.setup.timeoutSec}s` : `exited ${setupRun.code}`
          throw new Error(`setup command failed (${detailMsg}): ${[...setupResult.command].join(' ')}${setupRun.stderr ? ` — ${setupRun.stderr.slice(-300)}` : ''}`)
        }
        if (setupFailed) notes.push(`${detail.identifier}: setup command failed but project.setup.required is false — continuing`)
      }
      const briefMemory = memoryPlan ?? { memoryBlock: '', issueCharBudget: config.contract.maxIssueChars, hits: [] as const }
      const guidanceRefs = config.contract.maxBriefReferences > 0 && config.contract.briefScopes.length
        ? await resolveDocContext(loaded.root, `${detail.identifier} ${detail.title}`, config.contract.maxBriefReferences, config.contract.briefScopes)
        : []
      const pinnedSkills = getPinnedSkills()
      // A flow may ask its builder to lead. Whether it actually can is the provider's answer, and the brief says
      // which of the two it got — a worker told nothing about delegation invents its own answer.
      const delegation = flow.profile?.lead ? (providerIdentity(config, worker.provider).settings.subagents ? 'subagents' as const : 'alone' as const) : null
      if (delegation === 'alone') notes.push(`${detail.identifier}: flow asked for a lead but ${worker.provider} has no subagents declared; the worker was told to work alone`)
      const brief = renderWorkerBrief({
        issue: detail,
        contract: stored,
        config,
        branch: actualBranch,
        provider: worker.provider,
        model: worker.model,
        maxIssueChars: briefMemory.issueCharBudget,
        memoryBlock: briefMemory.memoryBlock,
        guidanceRefs,
        skills: pinnedSkills,
        ...(delegation ? { subagents: delegation === 'subagents' } : {}),
        ...(approvedPlan ? { plan: approvedPlan } : {}),
        onPiiDetected: (matches) => {
          appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'security.pii-detected', issue: detail.identifier, source: 'worker-brief', kinds: [...new Set(matches.map((match) => match.kind))], count: matches.length }, bus)
        },
      })
      const briefDigest = skillDigest(brief)
      writeFileSync(briefPath(loaded.stateDir, detail.identifier), brief, 'utf8')
      const launched = await launchWorkerTerminal({ runner: input.runner, config, worktreeId: created.id, worktreePath: created.path, command: worker.tui, title, brief })
      if (!launched.accepted) notes.push(`${detail.identifier}: terminal ${launched.terminal} did not confirm the brief; deliver will nudge it if it stays idle`)
      ledger.recordDispatch({ lease: claim.lease, idempotencyKey: plan.idempotencyKey, commandDigest: plan.commandDigest })
      const record: DispatchRecordFile = { issue: detail.identifier, worktreeId: created.id, worktree, branch: actualBranch, terminal: launched.terminal, provider: worker.provider, model: worker.model, contractDigest: stored.digest, leaseKey: claim.lease.key, leaseId: claim.lease.leaseId, dispatchedAt: now().toISOString(), url: detail.url, briefDigest, skills: skillRefs(pinnedSkills), ...(delegation ? { delegation } : {}), setup: setupResult, effort: worker.effort, initialRemainingPercent: worker.remainingPercent, worktreePath: created.path, labels: [...detail.labels], project: detail.project, priorityLabel: detail.priorityLabel, workerGuardInstalled: workerGuard.installed }
      resetDeliveryStateForDispatch(loaded.stateDir, detail.identifier)
      writeJsonAtomic(dispatchRecordPath(loaded.stateDir, detail.identifier), record)
      appendLoopEvent(loaded.stateDir, { at: record.dispatchedAt, type: 'worker.dispatched', ...record, command: worker.tui, briefAccepted: launched.accepted, tuiIdle: launched.idle }, bus)
      await bus.runHook('afterDispatch', { issue: detail.identifier, provider: record.provider, model: record.model, branch: record.branch, worktreeId: record.worktreeId })
      clearIssueFailures(loaded.stateDir, detail.identifier)
      // The claim, under `queueOwnership: 'unassigned'`: written only AFTER the dispatch succeeded, so a
      // failed dispatch never leaves an issue claimed by a worker that does not exist.
      //
      // In its own try/catch, and deliberately not fatal: what actually removes the issue from the queue
      // is the transition below (the queue reads `linear.states`, which does not include the in-progress
      // state), so a failed claim must not cost the status move and the dispatch comment. It is still
      // recorded as an event, because an unclaimed in-flight issue is exactly what a second machine would
      // pick up if the states were ever widened.
      if (config.linear.queueOwnership === 'unassigned') {
        try {
          await tracker.claim(detail.identifier, state.person)
        } catch (error) {
          notes.push(`${detail.identifier}: assignee claim failed after dispatch: ${message(error)}`)
          appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'queue.claim-failed', issue: detail.identifier, assignee: state.person, error: message(error) }, bus)
        }
      }
      try {
        await tracking.transition({ tracker: 'linear', issue: detail.identifier, from: detail.state, to: config.linear.inProgressState, reason: `loop dispatched ${worker.provider}/${worker.model} in ${created.id}` })
        await tracker.comment({ issue: detail.identifier, body: `**Loop: dispatched**\n\nWorker \`${worker.provider}/${worker.model}\` started in Orca worktree \`${worktree}\` on branch \`${actualBranch}\` (contract \`${stored.digest.slice(0, 12)}\`). It will open a PR against \`${config.project.baseBranch}\` when the contract's outcomes pass.\n\n<!-- loop:dispatched:${claim.lease.leaseId} -->`, dedupeKey: `dispatched:${detail.identifier}:${claim.lease.leaseId}` })
      } catch (error) { notes.push(`Linear update for ${detail.identifier} failed after dispatch: ${message(error)}`) }
      results.push({ issue: detail.identifier, outcome: 'dispatched', reason: 'worker started', branch: actualBranch, worktree, worktreeId: created.id, terminal: launched.terminal, provider: worker.provider, model: worker.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
    } catch (error) {
      ledger.release(claim.lease, `dispatch failed: ${message(error)}`)
      if (created) { try { await orcaWorktreeRemove(input.runner, { worktree: `id:${created.id}`, force: true }, { bin: config.orca.bin, timeoutMs: 60_000 }); notes.push(`${detail.identifier}: removed half-created worktree ${created.id}`) } catch (cleanup) { notes.push(`${detail.identifier}: worktree ${created.id} left behind (${message(cleanup)})`) } }
      appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'worker.dispatch-failed', issue: detail.identifier, error: message(error) }, bus)
      await recordFailureAndMaybePause(detail.identifier, 'worker.dispatch-failed', `dispatch failed: ${message(error)}`)
      results.push({ issue: detail.identifier, outcome: 'failed', reason: `dispatch failed: ${message(error)}`, branch, worktree, argv: plan.argv })
    }
  }
  if (!dispatched && !results.length) notes.push('no candidate reached dispatch')
  await flushNotifications()
  return { ...base, status: dispatched > 0 || results.some((result) => result.outcome === 'escalated') ? 'ok' : 'idle', results, notes }
}
