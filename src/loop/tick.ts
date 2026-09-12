import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { createLinearTrackingAdapter, fetchLinearIssue, fetchLinearQueue, linearCommentAdd, linearLabelAdd, linearLabelRemove, type LinearIssueDetail, type LoopIssue } from '../adapters/linear-orca.js'
import { createOrcaDispatchPlan } from '../adapters/orca.js'
import { orcaAccountList, orcaAgentHooks, orcaTerminalCreate, orcaTerminalSend, orcaTerminalWait, orcaWorktreeCreate, orcaWorktreeRemove, orcaWorktrees, type OrcaWorktree } from '../adapters/orca-cli.js'
import { detectProviders, type ProviderAvailability } from '../adapters/providers.js'
import { createDispatchLedger, type DispatchLedger, type DispatchLease } from '../execution/coordination.js'
import { HarnessError } from '../kernel/errors.js'
import { renderWorkerBrief } from './brief.js'
import { loadPinnedSkills, skillRefs, skillDigest, type PinnedSkillRef } from './skills.js'
import { loadLoopConfig, type EffortLevel, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { assessContract, contractIsFresh, extractResetsAt, generateContract, readStoredContract, resolveDocContext, writeStoredContract, type StoredContract } from './contract.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { countRunningWorkers, providerSpecs } from './doctor.js'
import { openLoopMemory, planMemoryContext } from './memory.js'
import { clearIssueFailures, isIssuePaused, pauseIssue, readIssueFailures, recordIssueFailure } from './resilience-state.js'
import { MODEL_ROLES } from '../kernel/model-policy.js'
import { resolveCatalogCandidates } from './model-catalog/index.js'
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
  readonly briefDigest: string
  readonly skills: readonly PinnedSkillRef[]
  readonly setup: { readonly command: readonly string[]; readonly exitCode: number | null; readonly durationMs: number; readonly timedOut: boolean } | null
  readonly effort: EffortLevel
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
}

/** Launch the worker in a fresh terminal with the configured TUI command and hand it the brief. Returns the terminal handle. */
export const launchWorkerTerminal = async (input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly worktreeId: string; readonly command: string; readonly title: string; readonly brief: string; readonly idleTimeoutMs?: number }): Promise<{ readonly terminal: string; readonly accepted: boolean; readonly idle: boolean }> => {
  const orca = { bin: input.config.orca.bin, timeoutMs: input.config.orca.timeoutMs }
  const created = await orcaTerminalCreate(input.runner, { worktree: `id:${input.worktreeId}`, command: input.command, title: input.title }, orca)
  let idle = false
  try { idle = (await orcaTerminalWait(input.runner, { terminal: created.handle, for: 'tui-idle', timeoutMs: input.idleTimeoutMs ?? 90_000 }, orca)).satisfied } catch { idle = false }
  const receipt = await orcaTerminalSend(input.runner, { terminal: created.handle, text: input.brief, enter: true, waitSubmitSeconds: 15 }, orca)
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
export const readDispatchRecord = (stateDir: string, identifier: string): DispatchRecordFile | null => {
  const path = dispatchRecordPath(stateDir, identifier)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as DispatchRecordFile } catch { return null }
}
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
export const writeDispatchRecord = (stateDir: string, record: DispatchRecordFile): string => {
  const path = dispatchRecordPath(stateDir, record.issue)
  writeJson(path, record)
  return path
}
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
  const availableIds = providers.filter((provider) => provider.available).map((provider) => provider.id)
  const extrasByRole = config.models.routing.mode === 'catalog'
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
  const orchestratorExtras = config.models.routing.mode === 'catalog'
    ? await resolveCatalogCandidates({
      config,
      role: 'orchestrator',
      availableProviderIds: state.providers.filter((provider) => provider.available).map((provider) => provider.id),
      runner: input.runner,
      stateDir: loaded.stateDir,
      env: input.env,
      now,
    })
    : []
  const orchestratorCandidates = rankModels(config, 'orchestrator', state.providers, orchestratorExtras)
  const onProviderFailure = (failure: { readonly provider: string; readonly kind: string; readonly detail: string }): void => {
    if (dryRun) return
    const resetsAt = extractResetsAt(failure.detail, now())
    const entry = markProviderExhausted(loaded.stateDir, failure.provider, { initialMin: config.models.cooldown.initialMin, maxMin: config.models.cooldown.maxMin, reason: `${failure.kind}: ${(failure.detail.split('\n')[0] ?? '').slice(0, 200)}`, resetsAt, now: now() })
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
  const startedAt = Date.now()
  const timeBudgetMs = input.budgetMs ?? Number.POSITIVE_INFINITY
  const remainingMs = (): number => timeBudgetMs - (Date.now() - startedAt)
  const write = { bin: config.orca.bin, workspaceId: config.linear.workspaceId, orca: { timeoutMs: config.orca.timeoutMs } }
  const tracking = createLinearTrackingAdapter(input.runner, { ...write, dryRun })
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
      await linearCommentAdd(input.runner, { issue, body, dedupeKey: `paused:${issue}:${failureState.consecutive}` }, write)
      await linearLabelAdd(input.runner, { issue, labels: [config.resilience.pausedLabel] }, write)
    } catch (error) { notes.push(`pause notification for ${issue} failed: ${message(error)}`) }
    appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'issue.paused', issue, kind, consecutive: failureState.consecutive, reason })
  }
  let dispatched = 0
  for (const candidate of state.candidates) {
    if (dispatched >= budget) break
    const setupBudgetMs = config.project.setup.command ? config.project.setup.timeoutSec * 1000 : 0
    if (remainingMs() < config.contract.timeoutMs + setupBudgetMs + 120_000 && !readStoredContract(loaded.stateDir, candidate.identifier)) { notes.push(`time budget: ${candidate.identifier} left for the next tick (${Math.round(remainingMs() / 1000)}s remaining)`); continue }
    if (isIssuePaused(loaded.stateDir, candidate.identifier)) {
      if (candidate.labels.includes(config.resilience.pausedLabel)) { results.push({ issue: candidate.identifier, outcome: 'skipped', reason: `paused after ${readIssueFailures(loaded.stateDir, candidate.identifier).consecutive} consecutive failures; remove the "${config.resilience.pausedLabel}" label or run "ak-harness loop resume ${candidate.identifier}" to retry` }); continue }
      // The pause label was removed on Linear since we last checked — treat that as the human's resume signal.
      if (!dryRun) clearIssueFailures(loaded.stateDir, candidate.identifier)
      notes.push(`${candidate.identifier}: resumed (the "${config.resilience.pausedLabel}" label was removed)`)
    }
    let detail: LinearIssueDetail
    try { detail = await fetchLinearIssue(input.runner, candidate.identifier, write) } catch (error) { results.push({ issue: candidate.identifier, outcome: 'failed', reason: `issue fetch failed: ${message(error)}` }); continue }

    let stored = readStoredContract(loaded.stateDir, detail.identifier)
    const memoryProbe = memory
      ? await planMemoryContext({
        adapter: memory,
        config,
        issueId: detail.identifier,
        issueTitle: detail.title,
        project: config.project.name,
        references: [],
      })
      : null
    if (stored && !contractIsFresh(stored, detail, config.contract.reuseHours, now(), memoryProbe?.memoryDigest)) stored = null
    if (!stored) {
      if (input.skipContractGeneration) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no cached contract; generation skipped' }); continue }
      if (!orchestratorCandidates.length) { results.push({ issue: detail.identifier, outcome: 'skipped', reason: 'no orchestrator provider available to freeze a contract' }); continue }
      try {
        stored = await generateContract({
          runner: input.runner,
          config,
          root: loaded.root,
          issue: detail,
          candidates: orchestratorCandidates,
          orchestrator,
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
            })
          },
        })
        if (!dryRun) writeStoredContract(loaded.stateDir, stored)
      } catch (error) {
        const reason = `contract generation failed: ${message(error)}`
        if (!dryRun) { appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'contract.failed', issue: detail.identifier, error: message(error) }); await recordFailureAndMaybePause(detail.identifier, 'contract.failed', reason) }
        results.push({ issue: detail.identifier, outcome: 'failed', reason })
        continue
      }
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
    const plan = createOrcaDispatchPlan({ repository: config.orca.repoSelector ?? `path:${loaded.root}`, worktree, branch, baseBranch: config.project.baseBranch, launch: 'worktree-only', linearIssue: detail.url || detail.identifier, comment: `loop · ${detail.identifier} · ${builder.provider}/${builder.model}`, noParent: true, orcaBin: config.orca.bin })
    const title = `loop ${detail.identifier} · ${builder.provider}`
    if (dryRun) {
      ledger.release(claim.lease, 'dry-run')
      results.push({ issue: detail.identifier, outcome: 'dry-run', reason: `would create worktree, open terminal "${builder.tui}", send the brief and move issue to In Progress (branch is assigned by Orca: <git user>/${worktree})`, branch, worktree, provider: builder.provider, model: builder.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
      continue
    }
    let created: Awaited<ReturnType<typeof orcaWorktreeCreate>> | null = null
    try {
      created = await orcaWorktreeCreate(input.runner, plan.argv, { timeoutMs: Math.max(config.orca.timeoutMs, 120_000) })
      // Orca names the branch `<git user>/<worktree>`; the Linear branchName is only a hint. Record and brief the real one.
      const actualBranch = created.branch || branch
      let setupResult: { readonly command: readonly string[]; readonly exitCode: number | null; readonly durationMs: number; readonly timedOut: boolean } | null = null
      if (config.project.setup.command?.length) {
        const setupRun = await input.runner.run(config.project.setup.command, { cwd: created.path, timeoutMs: config.project.setup.timeoutSec * 1000 })
        setupResult = { command: config.project.setup.command, exitCode: setupRun.code, durationMs: setupRun.durationMs, timedOut: setupRun.timedOut }
        const setupFailed = setupRun.timedOut || setupRun.code !== 0
        appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'worker.setup', issue: detail.identifier, worktreeId: created.id, ...setupResult, ok: !setupFailed })
        if (setupFailed && config.project.setup.required) {
          const detailMsg = setupRun.timedOut ? `timed out after ${config.project.setup.timeoutSec}s` : `exited ${setupRun.code}`
          throw new Error(`setup command failed (${detailMsg}): ${[...setupResult.command].join(' ')}${setupRun.stderr ? ` — ${setupRun.stderr.slice(-300)}` : ''}`)
        }
        if (setupFailed) notes.push(`${detail.identifier}: setup command failed but project.setup.required is false — continuing`)
      }
      const briefMemory = memory
        ? await planMemoryContext({
          adapter: memory,
          config,
          issueId: detail.identifier,
          issueTitle: detail.title,
          project: config.project.name,
          references: [],
        })
        : { memoryBlock: '', issueCharBudget: config.contract.maxIssueChars, hits: [] as const }
      const guidanceRefs = config.contract.maxBriefReferences > 0 && config.contract.briefScopes.length
        ? await resolveDocContext(loaded.root, `${detail.identifier} ${detail.title}`, config.contract.maxBriefReferences, config.contract.briefScopes)
        : []
      const pinnedSkills = loadPinnedSkills(loaded.root, config.brief.skills, config.brief.maxSkillChars)
      const brief = renderWorkerBrief({
        issue: detail,
        contract: stored,
        config,
        branch: actualBranch,
        provider: builder.provider,
        model: builder.model,
        maxIssueChars: briefMemory.issueCharBudget,
        memoryBlock: briefMemory.memoryBlock,
        guidanceRefs,
        skills: pinnedSkills,
      })
      const briefDigest = skillDigest(brief)
      writeFileSync(briefPath(loaded.stateDir, detail.identifier), brief, 'utf8')
      const launched = await launchWorkerTerminal({ runner: input.runner, config, worktreeId: created.id, command: builder.tui, title, brief })
      if (!launched.accepted) notes.push(`${detail.identifier}: terminal ${launched.terminal} did not confirm the brief; deliver will nudge it if it stays idle`)
      ledger.recordDispatch({ lease: claim.lease, idempotencyKey: plan.idempotencyKey, commandDigest: plan.commandDigest })
      const record: DispatchRecordFile = { issue: detail.identifier, worktreeId: created.id, worktree, branch: actualBranch, terminal: launched.terminal, provider: builder.provider, model: builder.model, contractDigest: stored.digest, leaseKey: claim.lease.key, leaseId: claim.lease.leaseId, dispatchedAt: now().toISOString(), url: detail.url, briefDigest, skills: skillRefs(pinnedSkills), setup: setupResult, effort: builder.effort }
      writeJson(dispatchRecordPath(loaded.stateDir, detail.identifier), record)
      appendLoopEvent(loaded.stateDir, { at: record.dispatchedAt, type: 'worker.dispatched', ...record, command: builder.tui, briefAccepted: launched.accepted, tuiIdle: launched.idle })
      clearIssueFailures(loaded.stateDir, detail.identifier)
      try {
        await tracking.transition({ tracker: 'linear', issue: detail.identifier, from: detail.state, to: config.linear.inProgressState, reason: `loop dispatched ${builder.provider}/${builder.model} in ${created.id}` })
        await linearCommentAdd(input.runner, { issue: detail.identifier, body: `**Loop: dispatched**\n\nWorker \`${builder.provider}/${builder.model}\` started in Orca worktree \`${worktree}\` on branch \`${actualBranch}\` (contract \`${stored.digest.slice(0, 12)}\`). It will open a PR against \`${config.project.baseBranch}\` when the contract's outcomes pass.\n\n<!-- loop:dispatched:${claim.lease.leaseId} -->`, dedupeKey: `dispatched:${detail.identifier}:${claim.lease.leaseId}` }, write)
      } catch (error) { notes.push(`Linear update for ${detail.identifier} failed after dispatch: ${message(error)}`) }
      results.push({ issue: detail.identifier, outcome: 'dispatched', reason: 'worker started', branch: actualBranch, worktree, worktreeId: created.id, terminal: launched.terminal, provider: builder.provider, model: builder.model, argv: plan.argv, contractDigest: stored.digest })
      dispatched += 1
    } catch (error) {
      ledger.release(claim.lease, `dispatch failed: ${message(error)}`)
      if (created) { try { await orcaWorktreeRemove(input.runner, { worktree: `id:${created.id}`, force: true }, { bin: config.orca.bin, timeoutMs: 60_000 }); notes.push(`${detail.identifier}: removed half-created worktree ${created.id}`) } catch (cleanup) { notes.push(`${detail.identifier}: worktree ${created.id} left behind (${message(cleanup)})`) } }
      appendLoopEvent(loaded.stateDir, { at: now().toISOString(), type: 'worker.dispatch-failed', issue: detail.identifier, error: message(error) })
      await recordFailureAndMaybePause(detail.identifier, 'worker.dispatch-failed', `dispatch failed: ${message(error)}`)
      results.push({ issue: detail.identifier, outcome: 'failed', reason: `dispatch failed: ${message(error)}`, branch, worktree, argv: plan.argv })
    }
  }
  if (!dispatched && !results.length) notes.push('no candidate reached dispatch')
  return { ...base, status: dispatched > 0 || results.some((result) => result.outcome === 'escalated') ? 'ok' : 'idle', results, notes }
}
