import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { createLinearTrackingAdapter, fetchLinearIssue, fetchLinearQueue, linearCommentAdd, linearLabelAdd, type LinearIssueDetail, type LoopIssue } from '../adapters/linear-orca.js'
import { createOrcaDispatchPlan } from '../adapters/orca.js'
import { orcaAccountList, orcaAgentHooks, orcaWorktreeCreate, orcaWorktrees, type OrcaWorktree } from '../adapters/orca-cli.js'
import { detectProviders, type ProviderAvailability } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { renderWorkerBrief } from './brief.js'
import { loadLoopConfig, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { assessContract, contractIsFresh, generateContract, readStoredContract, writeStoredContract, type StoredContract } from './contract.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { countRunningWorkers, providerSpecs } from './doctor.js'
import { rankModels, routeAllRoles, type RoutingDecision } from './routing.js'
import { assessSlots, type SlotAssessment, type SlotInput } from './slots.js'
import { markProviderExhausted } from './cooldown.js'

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
export const readDispatchRecord = (stateDir: string, identifier: string): DispatchRecordFile | null => {
  const path = dispatchRecordPath(stateDir, identifier)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as DispatchRecordFile } catch { return null }
}
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
export const appendLoopEvent = (stateDir: string, event: Record<string, unknown>): void => { const path = join(stateDir, 'events.ndjson'); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8') }

export interface LoopState {
  readonly providers: readonly ProviderAvailability[]
  readonly routing: Readonly<Record<string, RoutingDecision>>
  readonly worktrees: readonly OrcaWorktree[]
  readonly slots: SlotAssessment
  readonly queue: readonly LoopIssue[]
  readonly leases: readonly DispatchLease[]
  readonly busy: ReadonlySet<string>
  readonly candidates: readonly LoopIssue[]
}

export const gatherLoopState = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly ledger: DispatchLedger; readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly now: () => Date; readonly onlyIssue?: string; readonly machine?: TickInput['machine'] }): Promise<LoopState> => {
  const { config } = input.loaded
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const [accountList, agentHooks, worktrees, queue] = await Promise.all([
    orcaAccountList(input.runner, orca).catch(() => ({})),
    orcaAgentHooks(input.runner, orca).catch(() => ({}) as Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>>),
    orcaWorktrees(input.runner, orca),
    fetchLinearQueue(input.runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: config.linear.person, filter: config.linear, orca }),
  ])
  const providers = await detectProviders({ providers: providerSpecs(config), accountList, agentHooks, env: input.env, platform: input.platform, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns: activeCooldowns(readCooldowns(input.loaded.stateDir), input.now()), now: input.now })
  const routing = routeAllRoles(config, providers)
  const running = countRunningWorkers(worktrees)
  const slots = assessSlots({ machine: config.machine, running, platform: input.platform, ...input.machine })
  const leases = input.ledger.active()
  const busy = busyIssues(queue, leases, worktrees, config.linear.person)
  const candidates = queue.filter((issue) => !busy.has(issue.identifier) && (!input.onlyIssue || issue.identifier === input.onlyIssue))
  return { providers, routing, worktrees, slots, queue, leases, busy, candidates }
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

const escalate = async (input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly issue: LinearIssueDetail; readonly stored: StoredContract; readonly dryRun: boolean }): Promise<void> => {
  if (input.dryRun) return
  const write = { bin: input.config.orca.bin, workspaceId: input.config.linear.workspaceId, orca: { timeoutMs: input.config.orca.timeoutMs } }
  const body = `**Loop: not dispatched — needs information**\n\nThe orchestrator (${input.stored.provider}/${input.stored.model}) could not freeze a verifiable contract:\n${input.stored.assessment.reasons.map((reason) => `- ${reason}`).join('\n')}\n\nIntent it inferred: ${input.stored.contract.intent}\n\nAnswer in this issue (or edit the description with acceptance criteria) and remove the \`${input.config.linear.needsInfoLabel}\` label; the loop will re-evaluate on the next tick.\n\n<!-- loop:needs-info:${input.stored.digest} -->`
  await linearCommentAdd(input.runner, { issue: input.issue.identifier, body, dedupeKey: `needs-info:${input.issue.identifier}:${input.stored.digest}` }, write)
  await linearLabelAdd(input.runner, { issue: input.issue.identifier, labels: [input.config.linear.needsInfoLabel] }, write)
}

export const runTick = async (input: TickInput): Promise<TickReport> => {
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const now = input.now ?? (() => new Date())
  const dryRun = input.dryRun === true
  const ledger = createDispatchLedger(loaded.stateDir)
  const notes: string[] = []
  const results: TickCandidateResult[] = []
  const state = await gatherLoopState({ loaded, runner: input.runner, ledger, env: input.env, platform: input.platform, now, onlyIssue: input.onlyIssue, machine: input.machine })
  const orchestrator = state.routing['orchestrator'] ?? { role: 'orchestrator', selected: null, skipped: [] }
  const orchestratorCandidates = rankModels(config, 'orchestrator', state.providers)
  const onProviderFailure = (failure: { readonly provider: string; readonly kind: string; readonly detail: string }): void => {
    if (dryRun) return
    const entry = markProviderExhausted(loaded.stateDir, failure.provider, { initialMin: config.models.cooldown.initialMin, maxMin: config.models.cooldown.maxMin, reason: `${failure.kind}: ${(failure.detail.split('\n')[0] ?? '').slice(0, 200)}`, now: now() })
    notes.push(`provider ${failure.provider} marked cooling down until ${entry.until} (${failure.kind})`)
    appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'provider.cooldown', provider: failure.provider, kind: failure.kind, until: entry.until })
  }
  const builder = state.routing['builder']?.selected ?? null
  const summary = { orchestrator: orchestrator.selected ? `${orchestrator.selected.provider}/${orchestrator.selected.model}` : null, builder: builder ? `${builder.provider}/${builder.model}` : null }
  const base = { generatedAt: now().toISOString(), dryRun, slots: { maxAgents: state.slots.maxAgents, running: state.slots.running, free: state.slots.free, reasons: state.slots.reasons }, routing: summary, queue: { total: state.queue.length, busy: [...state.busy], candidates: state.candidates.map((issue) => issue.identifier) } }
  if (!builder) { notes.push('no builder provider available; nothing dispatched'); return { ...base, status: 'blocked', results, notes } }
  if (state.slots.free <= 0) { notes.push(`no free slot (${state.slots.running}/${state.slots.maxAgents})`); return { ...base, status: 'idle', results, notes } }
  if (!state.candidates.length) { notes.push('queue has no dispatchable candidate'); return { ...base, status: 'idle', results, notes } }

  const budget = Math.min(state.slots.free, input.maxDispatch ?? state.slots.free)
  const write = { bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } }
  const tracking = createLinearTrackingAdapter(input.runner, { ...write, dryRun })
  let dispatched = 0
  for (const candidate of state.candidates) {
    if (dispatched >= budget) break
    let detail: LinearIssueDetail
    try { detail = await fetchLinearIssue(input.runner, candidate.identifier, write) } catch (error) { results.push({ issue: candidate.identifier, outcome: 'failed', reason: `issue fetch failed: ${message(error)}` }); continue }

    let stored = readStoredContract(loaded.stateDir, detail.identifier)
    if (stored && !contractIsFresh(stored, detail, config.contract.reuseHours, now())) stored = null
    if (!stored) {
      if (input.skipContractGeneration) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no cached contract; generation skipped' }); continue }
      if (!orchestratorCandidates.length) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no orchestrator provider available to freeze a contract' }); continue }
      try {
        stored = await generateContract({ runner: input.runner, config, root: loaded.root, issue: detail, candidates: orchestratorCandidates, orchestrator, now, onProviderFailure })
        if (!dryRun) writeStoredContract(loaded.stateDir, stored)
      } catch (error) { results.push({ issue: detail.identifier, outcome: 'failed', reason: `contract generation failed: ${message(error)}` }); continue }
    }
    const assessment = assessContract(stored.contract)
    if (!assessment.dispatchable) {
      try { await escalate({ runner: input.runner, config, issue: detail, stored: { ...stored, assessment }, dryRun }) } catch (error) { notes.push(`escalation for ${detail.identifier} failed: ${message(error)}`) }
      if (!dryRun) appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'contract.escalated', issue: detail.identifier, reasons: assessment.reasons, digest: stored.digest })
      results.push({ issue: detail.identifier, outcome: 'escalated', reason: assessment.reasons.join('; '), contractDigest: stored.digest })
      continue
    }

    const branch = branchFor(detail, config.linear.person)
    const worktree = worktreeNameFor(detail)
    const claim = ledger.claim({ tracker: 'linear', repository: config.project.repo, issue: detail.identifier, worktree, branch, owner: input.owner ?? `loop:${config.linear.person}` })
    if (claim.decision === 'already-claimed') { results.push({ issue: detail.identifier, outcome: 'skipped', reason: `lease already held by ${claim.lease.owner} since ${claim.lease.claimedAt}` }); continue }
    const brief = renderWorkerBrief({ issue: detail, contract: stored, config, branch, provider: builder.provider, model: builder.model })
    const plan = createOrcaDispatchPlan({ repository: config.orca.repoSelector ?? `path:${loaded.root}`, worktree, branch, baseBranch: config.project.baseBranch, agent: builder.orcaAgent, prompt: brief, linearIssue: detail.url || detail.identifier, comment: `loop · ${detail.identifier} · ${builder.provider}/${builder.model}`, noParent: true, orcaBin: config.orca.bin })
    if (dryRun) {
      ledger.release(claim.lease, 'dry-run')
      results.push({ issue: detail.identifier, outcome: 'dry-run', reason: 'would create worktree and move issue to In Progress', branch, worktree, provider: builder.provider, model: builder.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
      continue
    }
    try {
      const created = await orcaWorktreeCreate(input.runner, plan.argv, { timeoutMs: Math.max(config.orca.timeoutMs, 120_000) })
      ledger.recordDispatch({ lease: claim.lease, idempotencyKey: plan.idempotencyKey, commandDigest: plan.commandDigest })
      const record: DispatchRecordFile = { issue: detail.identifier, worktreeId: created.id, worktree, branch, terminal: created.agentTerminalHandle, provider: builder.provider, model: builder.model, contractDigest: stored.digest, leaseKey: claim.lease.key, leaseId: claim.lease.leaseId, dispatchedAt: now().toISOString(), url: detail.url }
      writeJson(dispatchRecordPath(loaded.stateDir, detail.identifier), record)
      appendLoopEvent(loaded.stateDir, { at: record.dispatchedAt, type: 'worker.dispatched', ...record, briefDigest: hashJson(brief) })
      try {
        await tracking.transition({ tracker: 'linear', issue: detail.identifier, from: detail.state, to: config.linear.inProgressState, reason: `loop dispatched ${builder.provider}/${builder.model} in ${created.id}` })
        await linearCommentAdd(input.runner, { issue: detail.identifier, body: `**Loop: dispatched**\n\nWorker \`${builder.provider}/${builder.model}\` started in Orca worktree \`${worktree}\` on branch \`${branch}\` (contract \`${stored.digest.slice(0, 12)}\`). It will open a PR against \`${config.project.baseBranch}\` when the contract's outcomes pass.\n\n<!-- loop:dispatched:${claim.lease.leaseId} -->`, dedupeKey: `dispatched:${detail.identifier}:${claim.lease.leaseId}` }, write)
      } catch (error) { notes.push(`Linear update for ${detail.identifier} failed after dispatch: ${message(error)}`) }
      results.push({ issue: detail.identifier, outcome: 'dispatched', reason: 'worker started', branch, worktree, worktreeId: created.id, terminal: created.agentTerminalHandle, provider: builder.provider, model: builder.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
    } catch (error) {
      ledger.release(claim.lease, `dispatch failed: ${message(error)}`)
      appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'worker.dispatch-failed', issue: detail.identifier, error: message(error) })
      results.push({ issue: detail.identifier, outcome: 'failed', reason: `dispatch failed: ${message(error)}`, branch, worktree, argv: plan.argv })
    }
  }
  if (!dispatched && !results.length) notes.push('no candidate reached dispatch')
  return { ...base, status: dispatched > 0 || results.some((result) => result.outcome === 'escalated') ? 'ok' : 'idle', results, notes }
}
