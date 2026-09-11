import type { CommandRunner } from '../adapters/command.js'
import { findExecutable } from '../adapters/command.js'
import { orcaJson } from '../adapters/orca-cli.js'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { runLoopDoctor, type DoctorCheck, type LoopDoctorReport } from './doctor.js'
import { automationSpecs, installLoopAutomations, loopStatus, shellQuote, type InstallReport, type LoopStatusReport } from './install.js'
import { hasLocalConfig, promptLocalConfig, writeLocalConfig } from './local-config.js'
import { runTick, type TickReport } from './tick.js'

export interface GuidedInstallIO {
  /** Ask a yes/no question; `fallback` is used when the answer is empty. */
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>
  readonly write: (line: string) => void
  /** False when prompts cannot really be answered (no TTY); the local-config wizard never writes files in that mode. */
  readonly interactive?: boolean
  /** Optional richer surface; plain implementations may omit these and get text fallbacks. */
  readonly select?: (question: string, options: readonly { readonly value: string; readonly label: string; readonly hint?: string }[], initial?: number) => Promise<string | null>
  readonly text?: (question: string, fallback: string, validate?: (value: string) => string | null) => Promise<string | null>
  readonly checks?: (checks: readonly DoctorCheck[]) => void
  readonly section?: (title: string, step?: number, total?: number) => void
  readonly banner?: (title: string, lines: readonly string[]) => void
  readonly bullet?: (line: string, tone?: 'ok' | 'warn' | 'fail' | 'dim') => void
}

export interface GuidedInstallInput {
  readonly configPath?: string
  readonly loaded?: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly io: GuidedInstallIO
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly now?: () => Date
  /** Accept every prompt (non-interactive). */
  readonly yes?: boolean
  /** Continue past failed doctor checks. */
  readonly force?: boolean
  /** Skip the optional dry-run tick rehearsal. */
  readonly skipRehearsal?: boolean
  /** Do not offer to create loop.config.local.yaml when it is missing. */
  readonly skipLocalConfig?: boolean
  readonly provider?: string
  readonly dryRun?: boolean
}

export interface GuidedInstallReport {
  readonly status: 'installed' | 'dry-run' | 'aborted' | 'blocked'
  readonly reason: string
  readonly localConfig: { readonly path: string; readonly created: boolean } | null
  readonly doctor: Pick<LoopDoctorReport, 'status' | 'checks'> | null
  readonly preflight: readonly DoctorCheck[]
  readonly rehearsal: TickReport | null
  readonly install: InstallReport | null
  readonly after: LoopStatusReport | null
}

const icon = (status: DoctorCheck['status']): string => status === 'passed' ? '✔' : status === 'warning' ? '△' : '✖'
const line = (check: DoctorCheck): string => `  ${icon(check.status)} ${check.id.padEnd(24)} ${check.detail}`

/** Environment facts the doctor does not cover but the automations depend on. */
export const installPreflight = async (loaded: LoadedLoopConfig, runner: CommandRunner, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<readonly DoctorCheck[]> => {
  const { config } = loaded
  const checks: DoctorCheck[] = []
  const harnessBin = config.schedule.harnessCommand.split(/\s+/)[0] ?? config.schedule.harnessCommand
  checks.push(findExecutable(harnessBin, env, platform) ? { id: 'env.harness', status: 'passed', detail: `${harnessBin} resolves on PATH (Orca will call it by name)` } : { id: 'env.harness', status: 'failed', detail: `${harnessBin} not on PATH — npm i -g @agentskit/harness, or set schedule.harnessCommand to an absolute command` })
  checks.push(findExecutable(config.delivery.review.cli, env, platform) ? { id: 'env.review-cli', status: 'passed', detail: `${config.delivery.review.cli} resolves on PATH` } : { id: 'env.review-cli', status: 'failed', detail: `${config.delivery.review.cli} not on PATH — npm i -g @agentskit/code-review` })
  checks.push(findExecutable('gh', env, platform) ? { id: 'env.gh', status: 'passed', detail: 'gh resolves on PATH' } : { id: 'env.gh', status: 'failed', detail: 'gh (GitHub CLI) not on PATH' })
  try {
    const auth = await runner.run(['gh', 'auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 })
    checks.push(auth.code === 0 ? { id: 'github.auth', status: 'passed', detail: 'gh is authenticated' } : { id: 'github.auth', status: 'failed', detail: `gh auth status exited ${auth.code ?? 'null'} — run gh auth login` })
  } catch (error) { checks.push({ id: 'github.auth', status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
  try {
    const repos = await orcaJson(runner, ['repo', 'list'], { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs })
    const list = typeof repos === 'object' && repos !== null ? (Array.isArray((repos as { repos?: unknown }).repos) ? (repos as { repos: unknown[] }).repos : Array.isArray(repos) ? repos : []) : []
    const root = loaded.root.replace(/[\\/]+$/, '')
    const registered = list.some((item) => typeof item === 'object' && item !== null && Object.values(item as Record<string, unknown>).some((value) => typeof value === 'string' && value.replace(/[\\/]+$/, '') === root))
    checks.push(registered ? { id: 'orca.repo', status: 'passed', detail: `checkout is registered in Orca (${root})` } : { id: 'orca.repo', status: 'warning', detail: `checkout ${root} not found in orca repo list — run: ${config.orca.bin} repo add --path ${JSON.stringify(root)}` })
  } catch (error) { checks.push({ id: 'orca.repo', status: 'warning', detail: `orca repo list unavailable: ${error instanceof Error ? error.message : String(error)}` }) }
  checks.push({ id: 'config.person', status: 'passed', detail: `queue owner: ${config.linear.person}${loaded.localPath ? ` (overlay ${loaded.localPath})` : ' (from the versioned config)'}` })
  return checks
}

export const runGuidedInstall = async (input: GuidedInstallInput): Promise<GuidedInstallReport> => {
  const { io } = input
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const yes = input.yes === true
  const confirm = async (question: string, fallback: boolean): Promise<boolean> => yes ? true : io.confirm(question, fallback)
  const section = (title: string, step?: number, total?: number): void => io.section ? io.section(title, step, total) : io.write(`\n${step && total ? `${step}/${total} ` : ''}${title}`)
  const showChecks = (checks: readonly DoctorCheck[]): void => io.checks ? io.checks(checks) : checks.forEach((check) => io.write(line(check)))
  const bullet = (text: string, tone?: 'ok' | 'warn' | 'fail' | 'dim'): void => io.bullet ? io.bullet(text, tone) : io.write(`  ${text}`)
  let loaded = input.loaded ?? loadLoopConfig(input.configPath)
  if (!loaded.localPath && hasLocalConfig(loaded)) loaded = loadLoopConfig(loaded.path)
  let localConfig: GuidedInstallReport['localConfig'] = loaded.localPath ? { path: loaded.localPath, created: false } : null
  const TOTAL = 5

  section('Per-machine settings', 1, TOTAL)
  if (!hasLocalConfig(loaded) && !input.skipLocalConfig && !yes && io.interactive !== false && io.select && io.text) {
    bullet(`No ${'loop.config.local.yaml'} next to the config: the loop would drain the queue of "${loaded.config.linear.person}" from the versioned file.`, 'warn')
    if (await io.confirm('Create loop.config.local.yaml for this machine now?', true)) {
      const answers = await promptLocalConfig(input.runner, loaded, { select: io.select, text: io.text, confirm: io.confirm, write: io.write })
      if (!answers) { io.write('Cancelled. Nothing was written.'); return { status: 'aborted', reason: 'local config wizard cancelled', localConfig: null, doctor: null, preflight: [], rehearsal: null, install: null, after: null } }
      const written = writeLocalConfig(loaded, answers)
      loaded = written.loaded
      localConfig = { path: written.path, created: true }
      bullet(`wrote ${written.path}`, 'ok')
    }
  } else if (loaded.localPath) bullet(`using overlay ${loaded.localPath}`, 'ok')
  else if (io.interactive === false && !hasLocalConfig(loaded)) bullet(`no overlay and no terminal to ask; run interactively or write loop.config.local.yaml by hand`, 'warn')
  else bullet(`no overlay; queue owner comes from ${loaded.path}`, 'dim')
  const { config } = loaded
  if (io.banner) io.banner(`Keep-pushing loop · ${config.project.repo}`, [`base ${config.project.baseBranch} · team ${config.linear.teamKey} · queue of ${config.linear.person}`, `config ${loaded.path}`, ...(loaded.localPath ? [`overlay ${loaded.localPath}`] : [])])
  else io.write(`Keep-pushing loop for ${config.project.repo} (base ${config.project.baseBranch}) — queue of ${config.linear.person}, team ${config.linear.teamKey}\nConfig: ${loaded.path}${loaded.localPath ? `\nOverlay: ${loaded.localPath}` : ''}`)

  section('Doctor', 2, TOTAL)
  const doctor = await runLoopDoctor({ loaded, runner: input.runner, env, platform, now: input.now, probe: false })
  showChecks(doctor.checks)
  section('Automation environment', 3, TOTAL)
  const preflight = await installPreflight(loaded, input.runner, env, platform)
  showChecks(preflight)
  const failed = [...doctor.checks, ...preflight].filter((check) => check.status === 'failed')
  if (failed.length && !input.force) {
    bullet(`${failed.length} blocking check(s) failed. Fix them and run install again, or pass --force to install anyway.`, 'fail')
    return { status: 'blocked', reason: failed.map((check) => check.id).join(', '), localConfig, doctor, preflight, rehearsal: null, install: null, after: null }
  }
  if (failed.length) bullet(`continuing past ${failed.length} failed check(s) because of --force`, 'warn')

  let rehearsal: TickReport | null = null
  section('Rehearsal', 4, TOTAL)
  if (!input.skipRehearsal && await confirm('Run a dry-run tick now (calls the orchestrator once, writes nothing)?', true)) {
    rehearsal = await runTick({ loaded, runner: input.runner, env, platform, now: input.now, dryRun: true, maxDispatch: 1 })
    bullet(`tick ${rehearsal.status} · slots ${rehearsal.slots.free}/${rehearsal.slots.maxAgents} · orchestrator ${rehearsal.routing.orchestrator ?? '—'} · builder ${rehearsal.routing.builder ?? '—'}`, 'dim')
    for (const result of rehearsal.results) bullet(`${result.issue}  ${result.outcome}: ${result.reason.slice(0, 140)}`, result.outcome === 'dry-run' ? 'ok' : result.outcome === 'escalated' ? 'warn' : 'fail')
    for (const note of rehearsal.notes) bullet(note, 'dim')
  } else bullet('skipped', 'dim')

  section('Automations to install in Orca', 5, TOTAL)
  const specs = automationSpecs(loaded, input.provider ?? config.schedule.provider ?? '(auto: first available watcher provider)')
  for (const spec of specs) { bullet(`${spec.name}  trigger "${spec.trigger}"  provider ${spec.provider}`, 'ok'); bullet(`workspace ${spec.workspace}`, 'dim'); bullet(`precheck ${spec.precheck}`, 'dim') }
  if (input.dryRun) {
    const install = await installLoopAutomations({ loaded, runner: input.runner, env, platform, dryRun: true, provider: input.provider, now: input.now })
    bullet('Dry run: nothing was created.', 'warn')
    return { status: 'dry-run', reason: 'dry-run requested', localConfig, doctor, preflight, rehearsal, install, after: null }
  }
  if (!await confirm('Install these automations now? From then on the loop dispatches workers, comments on Linear, opens and merges PRs on its own.', false)) {
    bullet('Aborted. Nothing was created.', 'warn')
    return { status: 'aborted', reason: 'user declined', localConfig, doctor, preflight, rehearsal, install: null, after: null }
  }
  const install = await installLoopAutomations({ loaded, runner: input.runner, env, platform, provider: input.provider, now: input.now })
  for (const action of install.actions) bullet(`${action.name} ${action.action}: ${action.detail}`, action.action === 'create' || action.action === 'edit' ? 'ok' : 'fail')
  for (const note of install.notes) bullet(note, 'warn')
  if (install.status === 'failed') return { status: 'blocked', reason: 'orca refused an automation', localConfig, doctor, preflight, rehearsal, install, after: null }
  const after = await loopStatus({ loaded, runner: input.runner }).catch(() => null)
  if (after) bullet(after.summary, 'ok')
  bullet(`Watch it in Orca → Automations or with: ${config.schedule.harnessCommand} loop status -f ${shellQuote(loaded.path)}`, 'dim')
  return { status: 'installed', reason: `${install.actions.length} automation(s)`, localConfig, doctor, preflight, rehearsal, install, after }
}
