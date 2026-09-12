import { compareVersions, orcaAccountList, orcaAgentHooks, orcaStatus, orcaVersion, orcaWorktrees, type OrcaStatus, type OrcaWorktree } from '../adapters/orca-cli.js'
import { detectProviders, remainingUsagePercent, undeclaredOrcaProviders, type ProviderAvailability, type ProviderSpec } from '../adapters/providers.js'
import { fetchLinearQueue, type LoopIssue } from '../adapters/linear-orca.js'
import { findExecutable, type CommandRunner } from '../adapters/command.js'
import { inspectDocBridgeIndex } from '../adapters/doc-bridge.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HarnessError } from '../kernel/errors.js'
import { MODEL_ROLES } from '../kernel/model-policy.js'
import { loadLoopConfig, providerIdentity, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { resolveCatalogCandidates } from './model-catalog/index.js'
import { routeAllRoles, type RoutingDecision } from './routing.js'
import { assessSlots, type SlotAssessment } from './slots.js'
import { queueOwner } from './rotation.js'
import { createLoopEventBus, loadLoopPlugins } from './event-bus.js'
import { createMcpToolBridge } from '../adapters/mcp.js'
import { createPolicyGate } from '../kernel/policy.js'

export type DoctorCheckStatus = 'passed' | 'warning' | 'failed'
export interface DoctorCheck { readonly id: string; readonly status: DoctorCheckStatus; readonly detail: string }

export interface LoopDoctorReport {
  readonly status: 'passed' | 'failed'
  readonly generatedAt: string
  readonly config: { readonly path: string; readonly hash: string; readonly project: string; readonly repo: string; readonly person: string; readonly stateDir: string }
  readonly orca: { readonly binary: string | null; readonly version: string | null; readonly minVersion: string; readonly status: OrcaStatus | null; readonly error: string | null }
  readonly providers: readonly ProviderAvailability[]
  readonly routing: Readonly<Record<string, RoutingDecision>>
  readonly machine: SlotAssessment
  readonly workers: { readonly running: number; readonly worktrees: readonly Pick<OrcaWorktree, 'id' | 'branch' | 'workspaceStatus' | 'linkedLinearIssue' | 'liveTerminalCount'>[]; readonly error: string | null }
  readonly queue: { readonly count: number; readonly top: readonly Pick<LoopIssue, 'identifier' | 'title' | 'state' | 'priorityLabel' | 'branchName'>[]; readonly error: string | null }
  readonly checks: readonly DoctorCheck[]
}

export interface LoopDoctorInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  readonly probe?: boolean
  readonly queueTop?: number
}

const message = (error: unknown): string => error instanceof HarnessError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)

export const providerSpecs = (config: LoopConfig): readonly ProviderSpec[] => Object.keys(config.models.providers).map((id) => {
  const { settings, orcaUsageKey } = providerIdentity(config, id)
  return { id, bin: settings.bin, auth: settings.auth, envKeys: settings.envKeys, orcaUsageKey, ...(settings.probe ? { probe: settings.probe } : {}) }
})

/** Count worktrees still doing implementation work. Review/completed worktrees keep their lease for delivery, but must not consume a builder slot. */
export const countRunningWorkers = (worktrees: readonly OrcaWorktree[]): number => worktrees.filter((item) => {
  if (item.isArchived || item.isMainWorktree) return false
  // ponytail: only explicit terminal lifecycle states are excluded; unknown states stay fail-closed.
  const status = item.workspaceStatus.trim().toLowerCase()
  if (status === 'in-review' || status === 'completed') return false
  return item.liveTerminalCount > 0 || item.linkedLinearIssue !== null
}).length

export const runLoopDoctor = async (input: LoopDoctorInput): Promise<LoopDoctorReport> => {
  const now = input.now ?? (() => new Date())
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  const person = queueOwner(loaded)
  const orcaOptions = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  const checks: DoctorCheck[] = []
  const push = (id: string, status: DoctorCheckStatus, detail: string): void => { checks.push({ id, status, detail }) }

  const version = await orcaVersion(input.runner, orcaOptions).catch(() => null)
  let status: OrcaStatus | null = null
  let orcaError: string | null = null
  try { status = await orcaStatus(input.runner, orcaOptions) } catch (error) { orcaError = message(error) }
  if (!version) push('orca.binary', 'failed', `"${config.orca.bin}" did not answer --version`)
  else if (compareVersions(version, config.orca.minVersion) < 0) push('orca.version', 'failed', `Orca ${version} is older than required ${config.orca.minVersion}`)
  else push('orca.version', 'passed', `Orca ${version} ≥ ${config.orca.minVersion}`)
  if (status) push('orca.runtime', status.runtimeReady ? 'passed' : 'failed', status.runtimeReady ? `runtime ready (app ${status.appRunning ? 'running' : 'not running'})` : `runtime ${status.runtimeState}; start it with "${config.orca.bin} open"`)
  else push('orca.runtime', 'failed', orcaError ?? 'status unavailable')

  const [accountList, agentHooks] = await Promise.all([
    orcaAccountList(input.runner, orcaOptions).catch((error: unknown) => { push('orca.accounts', 'warning', `account list unavailable: ${message(error)}`); return null }),
    orcaAgentHooks(input.runner, orcaOptions).catch((error: unknown) => { push('orca.agent-hooks', 'warning', `agent hooks unavailable: ${message(error)}`); return {} as Readonly<Record<string, 'installed' | 'not_installed' | 'unknown'>> }),
  ])
  const cooldowns = activeCooldowns(readCooldowns(loaded.stateDir), now())
  const providers = await detectProviders({ providers: providerSpecs(config), accountList: accountList ?? {}, agentHooks, env: input.env, platform: input.platform, exhaustedPercent: config.models.cooldown.exhaustedPercent, cooldowns, now, ...(input.probe === false ? {} : { runner: input.runner }) })
  for (const provider of providers) {
    const remaining = remainingUsagePercent(provider.usage, config.models.routing.usageMetric)
    const usageDetail = provider.usage.windows.length
      ? ` (${provider.usage.windows.map((window) => `${window.kind} ${window.usedPercent}%`).join(', ')}; remaining~${remaining ?? '?'}%)`
      : ''
    push(`provider.${provider.id}`, provider.available ? 'passed' : 'warning', provider.available ? `available${usageDetail}` : provider.reasons.join('; '))
  }
  const undeclared = undeclaredOrcaProviders(accountList ?? {}, Object.fromEntries(Object.entries(config.models.providers).map(([id, settings]) => [id, { orcaUsageKey: settings.orcaUsageKey ?? id }])))
  if (undeclared.length) push('orca.undeclared-providers', 'warning', `Orca shows integrations without models.providers entries: ${undeclared.join(', ')} — add a provider block (bin/tui) or ignore`)

  const extrasByRole = config.models.routing.mode === 'catalog'
    ? Object.fromEntries(await Promise.all(MODEL_ROLES.map(async (role) => [role, await resolveCatalogCandidates({
      config,
      role,
      availableProviderIds: providers.filter((provider) => provider.available).map((provider) => provider.id),
      runner: input.runner,
      stateDir: loaded.stateDir,
      env: input.env,
      now,
    })] as const)))
    : {}
  const routing = routeAllRoles(config, providers, extrasByRole)
  for (const role of MODEL_ROLES) {
    const decision = routing[role]
    const selected = decision.selected
    push(
      `routing.${role}`,
      selected ? 'passed' : 'failed',
      selected
        ? `${selected.provider}/${selected.model} · mode ${config.models.routing.mode} · ${selected.reason}${selected.remainingPercent !== null ? ` · remaining ${selected.remainingPercent}%` : ''}`
        : `no available provider (${decision.skipped.length} skipped; mode ${config.models.routing.mode})`,
    )
  }

  let worktrees: readonly OrcaWorktree[] = []
  let workersError: string | null = null
  try { worktrees = await orcaWorktrees(input.runner, orcaOptions) } catch (error) { workersError = message(error); push('orca.worktrees', 'warning', `worktree ps unavailable: ${workersError}`) }
  const running = countRunningWorkers(worktrees)
  const machine = assessSlots({ machine: config.machine, running, platform: input.platform })
  push('machine.slots', machine.free > 0 ? 'passed' : 'warning', `${machine.free} free of ${machine.maxAgents} (running ${running}, cpus ${machine.sample.cpus}, load ${machine.sample.load1PerCpuPercent}%, free RAM ${machine.freeRamGb} GB)${machine.reasons.length ? `; ${machine.reasons.join('; ')}` : ''}`)

  let queue: readonly LoopIssue[] = []
  let queueError: string | null = null
  try {
    queue = await fetchLinearQueue(input.runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: person, filter: config.linear, orca: orcaOptions })
    push('linear.queue', 'passed', `${queue.length} dispatchable issue(s) for ${person} in ${config.linear.states.join('/')}`)
  } catch (error) { queueError = message(error); push('linear.queue', 'failed', queueError) }

  const docBridge = inspectDocBridgeIndex(loaded.root)
  if (!docBridge.present) {
    push('doc-bridge.index', config.contract.requireDocBridge ? 'failed' : 'warning', `missing ${docBridge.path} — orchestrator runs without Doc Bridge refs (rebuild with docs:bridge:index when available)`)
  } else if (docBridge.error) {
    push('doc-bridge.index', config.contract.requireDocBridge ? 'failed' : 'warning', `unreadable: ${docBridge.error}`)
  } else {
    push('doc-bridge.index', 'passed', `present (hash ${docBridge.contentHash?.slice(0, 12) ?? 'unknown'})`)
    const maxAge = config.contract.docBridgeMaxAgeHours
    if (maxAge > 0 && docBridge.ageHours !== null && docBridge.ageHours > maxAge) {
      push('doc-bridge.freshness', config.contract.requireDocBridge ? 'failed' : 'warning', `index age ${docBridge.ageHours.toFixed(1)}h exceeds ${maxAge}h — refresh Doc Bridge`)
    } else {
      push('doc-bridge.freshness', 'passed', `age ${docBridge.ageHours?.toFixed(1) ?? '?'}h ≤ ${maxAge}h`)
    }
  }

  if (config.brief.skills.length) {
    const unreadable: string[] = []
    for (const relativePath of config.brief.skills) {
      const absolute = resolve(loaded.root, relativePath)
      if (!existsSync(absolute)) { unreadable.push(`${relativePath} (missing)`); continue }
      try { readFileSync(absolute, 'utf8') } catch (error) { unreadable.push(`${relativePath} (${message(error)})`) }
    }
    if (unreadable.length) {
      push('brief.skills', 'failed', `${unreadable.length} of ${config.brief.skills.length} pinned skill file(s) unreadable: ${unreadable.join(', ')} — dispatch will fail closed`)
    } else {
      push('brief.skills', 'passed', `${config.brief.skills.length} pinned skill file(s) present and readable`)
    }
  }

  if (config.plugins.modules.length) {
    const { loaded: loadedModules, errors: pluginErrors } = await loadLoopPlugins(loaded.root, config.plugins.modules, createLoopEventBus())
    if (pluginErrors.length) {
      push('plugins.modules', 'failed', `${pluginErrors.length} of ${config.plugins.modules.length} plugin module(s) failed to load: ${pluginErrors.map((failure) => `${failure.path} (${failure.error})`).join(', ')}`)
    } else {
      push('plugins.modules', 'passed', `${loadedModules.length} plugin module(s) loaded (${loadedModules.join(', ')})`)
    }
  }

  if (config.mcp.enabled) {
    // MCP stays adapter-only and read-only in the loop (ADR-0028): no MCP client/transport lives here, so this
    // cannot reach a live server. It only proves the allowlist + policy-gate plumbing is self-consistent —
    // exactly what `createMcpToolBridge` will enforce once a real `call` function is wired in by a consumer.
    if (!config.mcp.allowTools.length) {
      push('mcp.allowlist', 'warning', 'mcp.enabled is true but mcp.allowTools is empty; the default-deny bridge would block every tool call')
    } else {
      const policy = createPolicyGate({ rules: [{ id: 'mcp-doctor-allow', effect: 'allow', toolIds: [...config.mcp.allowTools], reason: 'configured allowlist' }] })
      const bridge = createMcpToolBridge({ policy, allowTools: config.mcp.allowTools, call: async () => null })
      const allowed = await bridge.invoke({ toolId: config.mcp.allowTools[0]! })
      const blocked = await bridge.invoke({ toolId: '__doctor-probe-not-in-allowlist__' })
      if (allowed.status === 'ok' && blocked.status === 'blocked') {
        push('mcp.allowlist', 'passed', `${config.mcp.allowTools.length} allowlisted tool(s); allowlist/policy wiring verified (not a live connectivity check)`)
      } else {
        push('mcp.allowlist', 'failed', 'MCP allowlist/policy wiring did not behave as expected')
      }
    }
  }

  const reviewCli = config.delivery.review.cli
  const reviewBin = findExecutable(reviewCli, input.env ?? process.env, input.platform ?? process.platform)
  // Warning (not failed): tick can still dispatch; deliver waits until the review CLI is available.
  if (!reviewBin) push('review.cli', 'warning', `"${reviewCli}" not on PATH — deliver cannot review until it is installed`)
  else {
    push('review.cli', 'passed', `found ${reviewBin}${config.delivery.review.transport ? ` · transport ${config.delivery.review.transport}` : ''} · mode ${config.delivery.review.mode}`)
    if (config.delivery.review.doctorProbe === 'help' && input.probe !== false) {
      try {
        const help = await input.runner.run([reviewCli, '--help'], { timeoutMs: 15_000 })
        push('review.help', help.code === 0 ? 'passed' : 'warning', help.code === 0 ? '`--help` ok' : `exit ${help.code ?? 'null'}: ${(help.stderr || help.stdout).trim().slice(0, 160)}`)
      } catch (error) { push('review.help', 'warning', message(error)) }
    }
  }

  if (config.memory.enabled) {
    push('memory', 'passed', `enabled · backend ${config.memory.backend} · store ${config.project.stateDir}/${config.memory.storePath} · preferOverDocBridge=${config.memory.preferOverDocBridge}`)
  }

  const failed = checks.some((check) => check.status === 'failed')
  return {
    status: failed ? 'failed' : 'passed',
    generatedAt: now().toISOString(),
    config: { path: loaded.path, hash: loaded.configHash, project: config.project.name, repo: config.project.repo, person, stateDir: loaded.stateDir },
    orca: { binary: config.orca.bin, version, minVersion: config.orca.minVersion, status, error: orcaError },
    providers,
    routing,
    machine,
    workers: { running, worktrees: worktrees.map(({ id, branch, workspaceStatus, linkedLinearIssue, liveTerminalCount }) => ({ id, branch, workspaceStatus, linkedLinearIssue, liveTerminalCount })), error: workersError },
    queue: { count: queue.length, top: queue.slice(0, input.queueTop ?? 10).map(({ identifier, title, state, priorityLabel, branchName }) => ({ identifier, title, state, priorityLabel, branchName })), error: queueError },
    checks,
  }
}
