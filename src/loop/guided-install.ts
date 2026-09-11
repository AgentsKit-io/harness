import { createInterface } from 'node:readline/promises'
import type { CommandRunner } from '../adapters/command.js'
import { findExecutable } from '../adapters/command.js'
import { orcaJson } from '../adapters/orca-cli.js'
import { loadLoopConfig, type LoadedLoopConfig } from './config.js'
import { runLoopDoctor, type DoctorCheck, type LoopDoctorReport } from './doctor.js'
import { automationSpecs, installLoopAutomations, loopStatus, type InstallReport, type LoopStatusReport } from './install.js'
import { runTick, type TickReport } from './tick.js'

export interface GuidedInstallIO {
  /** Ask a yes/no question; `fallback` is used when the answer is empty. */
  readonly confirm: (question: string, fallback: boolean) => Promise<boolean>
  readonly write: (line: string) => void
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
  readonly provider?: string
  readonly dryRun?: boolean
}

export interface GuidedInstallReport {
  readonly status: 'installed' | 'dry-run' | 'aborted' | 'blocked'
  readonly reason: string
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
  const loaded = input.loaded ?? loadLoopConfig(input.configPath)
  const { config } = loaded
  io.write(`Keep-pushing loop for ${config.project.repo} (base ${config.project.baseBranch}) — queue of ${config.linear.person}, team ${config.linear.teamKey}`)
  io.write(`Config: ${loaded.path}${loaded.localPath ? `\nOverlay: ${loaded.localPath}` : ''}\n`)

  io.write('1/4 Doctor')
  const doctor = await runLoopDoctor({ loaded, runner: input.runner, env, platform, now: input.now, probe: false })
  for (const check of doctor.checks) io.write(line(check))
  io.write('\n2/4 Automation environment')
  const preflight = await installPreflight(loaded, input.runner, env, platform)
  for (const check of preflight) io.write(line(check))
  const failed = [...doctor.checks, ...preflight].filter((check) => check.status === 'failed')
  if (failed.length && !input.force) {
    io.write(`\n${failed.length} blocking check(s) failed. Fix them and run install again, or pass --force to install anyway.`)
    return { status: 'blocked', reason: failed.map((check) => check.id).join(', '), doctor, preflight, rehearsal: null, install: null, after: null }
  }
  if (failed.length) io.write(`\n△ continuing past ${failed.length} failed check(s) because of --force`)

  let rehearsal: TickReport | null = null
  if (!input.skipRehearsal && await confirm('\n3/4 Run a dry-run tick now (calls the orchestrator once, writes nothing)?', true)) {
    rehearsal = await runTick({ loaded, runner: input.runner, env, platform, now: input.now, dryRun: true, maxDispatch: 1 })
    io.write(`  tick ${rehearsal.status} · slots ${rehearsal.slots.free}/${rehearsal.slots.maxAgents} · orchestrator ${rehearsal.routing.orchestrator ?? '—'} · builder ${rehearsal.routing.builder ?? '—'}`)
    for (const result of rehearsal.results) io.write(`  ${result.outcome === 'dry-run' ? '✔' : result.outcome === 'escalated' ? '△' : '✖'} ${result.issue.padEnd(10)} ${result.outcome}: ${result.reason.slice(0, 140)}`)
    for (const note of rehearsal.notes) io.write(`  · ${note}`)
  } else io.write('\n3/4 Rehearsal skipped')

  io.write('\n4/4 Automations to install in Orca')
  const specs = automationSpecs(loaded, input.provider ?? config.schedule.provider ?? '(auto: first available watcher provider)')
  for (const spec of specs) io.write(`  • ${spec.name}  trigger "${spec.trigger}"  provider ${spec.provider}  workspace ${spec.workspace}\n    precheck: ${spec.precheck}`)
  if (input.dryRun) {
    const install = await installLoopAutomations({ loaded, runner: input.runner, env, platform, dryRun: true, provider: input.provider, now: input.now })
    io.write('\nDry run: nothing was created.')
    return { status: 'dry-run', reason: 'dry-run requested', doctor, preflight, rehearsal, install, after: null }
  }
  if (!await confirm('\nInstall these automations now? From then on the loop dispatches workers, comments on Linear, opens and merges PRs on its own.', false)) {
    io.write('Aborted. Nothing was created.')
    return { status: 'aborted', reason: 'user declined', doctor, preflight, rehearsal, install: null, after: null }
  }
  const install = await installLoopAutomations({ loaded, runner: input.runner, env, platform, provider: input.provider, now: input.now })
  for (const action of install.actions) io.write(`  ${action.action === 'create' || action.action === 'edit' ? '✔' : '✖'} ${action.name} ${action.action}: ${action.detail}`)
  for (const note of install.notes) io.write(`  △ ${note}`)
  if (install.status === 'failed') return { status: 'blocked', reason: 'orca refused an automation', doctor, preflight, rehearsal, install, after: null }
  const after = await loopStatus({ loaded, runner: input.runner }).catch(() => null)
  if (after) io.write(`\n${after.summary}`)
  io.write(`Watch it in Orca → Automations or with: ${config.schedule.harnessCommand} loop status -f ${JSON.stringify(loaded.path)}`)
  return { status: 'installed', reason: `${install.actions.length} automation(s)`, doctor, preflight, rehearsal, install, after }
}

/** Terminal IO: readline prompts when stdin is a TTY; otherwise every prompt takes its fallback and says so. */
export const createTerminalIO = (): GuidedInstallIO & { readonly interactive: boolean } => {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  return {
    interactive,
    write: (text) => { process.stdout.write(`${text}\n`) },
    confirm: async (question, fallback) => {
      if (!interactive) { process.stdout.write(`${question} [non-interactive → ${fallback ? 'yes' : 'no'}]\n`); return fallback }
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = (await rl.question(`${question} ${fallback ? '[Y/n] ' : '[y/N] '}`)).trim().toLowerCase()
        return answer === '' ? fallback : answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim'
      } finally { rl.close() }
    },
  }
}
