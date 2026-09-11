import { compareVersions, orcaAccountList, orcaAgentHooks, orcaStatus, orcaVersion, orcaWorktrees, type OrcaStatus, type OrcaWorktree } from '../adapters/orca-cli.js'
import { detectProviders, type ProviderAvailability, type ProviderSpec } from '../adapters/providers.js'
import { fetchLinearQueue, type LoopIssue } from '../adapters/linear-orca.js'
import { findExecutable, type CommandRunner } from '../adapters/command.js'
import { inspectDocBridgeIndex } from '../adapters/doc-bridge.js'
import { HarnessError } from '../kernel/errors.js'
import { MODEL_ROLES } from '../kernel/model-policy.js'
import { loadLoopConfig, providerIdentity, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { activeCooldowns, readCooldowns } from './cooldown.js'
import { routeAllRoles, type RoutingDecision } from './routing.js'
import { assessSlots, type SlotAssessment } from './slots.js'

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

/** Count worktrees the loop treats as live workers: not archived, not the main checkout, with a live terminal or a linked Linear issue. */
export const countRunningWorkers = (worktrees: readonly OrcaWorktree[]): number => worktrees.filter((item) => !item.isArchived && !item.isMainWorktree && (item.liveTerminalCount > 0 || item.linkedLinearIssue !== null)).length

export const runLoopDoctor = async (input: LoopDoctorInput): Promise<LoopDoctorReport> => {
  const now = input.now ?? (() => new Date())
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
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
  for (const provider of providers) push(`provider.${provider.id}`, provider.available ? 'passed' : 'warning', provider.available ? `available${provider.usage.windows.length ? ` (${provider.usage.windows.map((window) => `${window.kind} ${window.usedPercent}%`).join(', ')})` : ''}` : provider.reasons.join('; '))
  const routing = routeAllRoles(config, providers)
  for (const role of MODEL_ROLES) {
    const decision = routing[role]
    push(`routing.${role}`, decision.selected ? 'passed' : 'failed', decision.selected ? `${decision.selected.provider}/${decision.selected.model} (tier ${decision.selected.tier + 1})` : `no available provider in any tier (${decision.skipped.length} skipped)`)
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
    queue = await fetchLinearQueue(input.runner, { bin: config.orca.bin, workspaceId: config.linear.workspaceId, teamKey: config.linear.teamKey, assignee: config.linear.person, filter: config.linear, orca: orcaOptions })
    push('linear.queue', 'passed', `${queue.length} dispatchable issue(s) for ${config.linear.person} in ${config.linear.states.join('/')}`)
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
    config: { path: loaded.path, hash: loaded.configHash, project: config.project.name, repo: config.project.repo, person: config.linear.person, stateDir: loaded.stateDir },
    orca: { binary: config.orca.bin, version, minVersion: config.orca.minVersion, status, error: orcaError },
    providers,
    routing,
    machine,
    workers: { running, worktrees: worktrees.map(({ id, branch, workspaceStatus, linkedLinearIssue, liveTerminalCount }) => ({ id, branch, workspaceStatus, linkedLinearIssue, liveTerminalCount })), error: workersError },
    queue: { count: queue.length, top: queue.slice(0, input.queueTop ?? 10).map(({ identifier, title, state, priorityLabel, branchName }) => ({ identifier, title, state, priorityLabel, branchName })), error: queueError },
    checks,
  }
}
