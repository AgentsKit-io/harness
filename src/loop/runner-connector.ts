import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { createOrcaDispatchPlan } from '../adapters/orca.js'
import { orcaTerminalCreate, orcaTerminalScreen, orcaTerminalSend, orcaWorktreeCreate, orcaWorktreeRemove, orcaWorktrees } from '../adapters/orca-cli.js'
import { fail } from '../kernel/errors.js'
import type { LoadedLoopConfig } from './config.js'
import { automationName, precheckCommand, type LoopStage } from './automations.js'

/** A place a worker runs: a git worktree plus whatever the runner needs to find it again. */
export interface RunnerWorkspace { readonly id: string; readonly path: string; readonly branch: string; readonly terminal: string | null }

export interface ScheduledJob { readonly name: string; readonly cron: string; readonly command: string }

/** What the runner itself observed about a workspace — an observation for display, never a gate: CI, review and
 * the merge sha still come from the SCM, which is the only source that knows them. */
export interface WorkspaceObservation { readonly id: string; readonly pullRequest: { readonly number: number; readonly state: 'OPEN' | 'CLOSED' | 'MERGED' | null } | null }

/**
 * Where the loop puts work. Orca is the first implementation; `local` — git worktree, tmux, the system crontab —
 * is the second, and it exists to prove the engine depends on the interface rather than on Orca. An interface
 * with one implementation is a guess.
 */
export interface RunnerConnector {
  readonly id: string
  createWorkspace(input: { readonly name: string; readonly branch: string; readonly baseBranch: string; readonly issue?: string; readonly comment?: string }): Promise<RunnerWorkspace>
  removeWorkspace(input: { readonly id: string; readonly force?: boolean }): Promise<void>
  /** Start the agent CLI inside the workspace and return its terminal handle. */
  launchAgent(input: { readonly workspace: RunnerWorkspace; readonly command: string; readonly title?: string }): Promise<string>
  send(input: { readonly terminal: string; readonly text: string; readonly waitSubmitSeconds?: number }): Promise<{ readonly delivered: boolean; readonly detail: string }>
  readScreen(input: { readonly terminal: string; readonly lines?: number }): Promise<string>
  /** Reconcile the scheduled jobs this runner owns with the ones declared. Returns what it changed. */
  schedule(jobs: readonly ScheduledJob[]): Promise<readonly string[]>
  /** Every workspace the runner knows, with the pull request it detected on its own (none, for a runner that cannot). */
  observeWorkspaces(): Promise<readonly WorkspaceObservation[]>
}

export interface RunnerInput { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner }

export const createOrcaRunner = ({ loaded, runner }: RunnerInput): RunnerConnector => {
  const { config } = loaded
  const orca = { bin: config.orca.bin, timeoutMs: config.orca.timeoutMs }
  return {
    id: 'orca',
    createWorkspace: async ({ name, branch, baseBranch, issue, comment }) => {
      const plan = createOrcaDispatchPlan({ repository: config.orca.repoSelector ?? `path:${loaded.root}`, worktree: name, branch, baseBranch, launch: 'worktree-only', ...(issue ? { linearIssue: issue } : {}), ...(comment ? { comment } : {}), noParent: true, orcaBin: config.orca.bin })
      const created = await orcaWorktreeCreate(runner, plan.argv, orca)
      return { id: created.id, path: created.path, branch: created.branch, terminal: created.agentTerminalHandle }
    },
    removeWorkspace: async ({ id, force }) => { await orcaWorktreeRemove(runner, { worktree: `id:${id}`, ...(force === undefined ? {} : { force }) }, orca) },
    launchAgent: async ({ workspace, command, title }) => (await orcaTerminalCreate(runner, { worktree: `id:${workspace.id}`, command, ...(title ? { title } : {}) }, orca)).handle,
    send: async ({ terminal, text, waitSubmitSeconds }) => {
      const receipt = await orcaTerminalSend(runner, { terminal, text, ...(waitSubmitSeconds ? { waitSubmitSeconds } : {}) }, orca)
      return { delivered: receipt.accepted, detail: receipt.warnings.join('; ') || receipt.stages.join(' → ') || 'sent' }
    },
    readScreen: async ({ terminal }) => orcaTerminalScreen(runner, { terminal }, orca),
    // Orca owns its own automations; `loop install` reconciles them and this method is the seam that keeps the
    // engine from having to know that.
    schedule: async () => ['orca automations are reconciled by `loop install`'],
    observeWorkspaces: async () => (await orcaWorktrees(runner, orca)).map((worktree) => ({ id: worktree.id, pullRequest: worktree.linkedPR })),
  }
}

const tmuxSession = (name: string): string => `ak-${name}`.replaceAll(/[^A-Za-z0-9_-]/g, '-')

/**
 * git worktree + tmux + the system crontab. No Orca, no daemon, nothing to install beyond git and tmux.
 *
 * It is the cheapest runner to build and the reason the interface above is honest: every Orca-shaped assumption
 * that leaked into the engine shows up here as something this runner cannot do.
 */
export const createLocalRunner = ({ loaded, runner }: RunnerInput): RunnerConnector => {
  const { config } = loaded
  const tmux = config.connectors.local.tmuxBin
  const root = isAbsolute(config.connectors.local.worktreeRoot) ? config.connectors.local.worktreeRoot : resolve(loaded.root, config.connectors.local.worktreeRoot)
  const git = async (args: readonly string[], timeoutMs = 60_000): Promise<string> => {
    const result = await runner.run(['git', '-C', loaded.root, ...args], { timeoutMs })
    if (result.code !== 0) fail(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code ?? 'null'}`}`, 'HARNESS_ERROR')
    return result.stdout.trim()
  }
  return {
    id: 'local',
    createWorkspace: async ({ name, branch, baseBranch }) => {
      const path = join(root, name)
      mkdirSync(root, { recursive: true })
      await git(['fetch', 'origin', baseBranch], 120_000).catch(() => '')
      await git(['worktree', 'add', '-b', branch, path, `origin/${baseBranch}`], 120_000)
      return { id: path, path, branch, terminal: null }
    },
    removeWorkspace: async ({ id, force }) => { await git(['worktree', 'remove', ...(force ? ['--force'] : []), id], 120_000) },
    launchAgent: async ({ workspace, command }) => {
      const session = tmuxSession(basename(workspace.path) || 'worker')
      const result = await runner.run([tmux, 'new-session', '-d', '-s', session, '-c', workspace.path, command], { timeoutMs: 30_000 })
      if (result.code !== 0) fail(`tmux new-session failed: ${result.stderr.trim() || `exit ${result.code ?? 'null'}`}`, 'HARNESS_ERROR')
      return session
    },
    send: async ({ terminal, text }) => {
      // Two calls on purpose: the text is a literal argument, and only then is Enter sent. Appending "\\n" to the
      // text would let a newline inside it submit early.
      const typed = await runner.run([tmux, 'send-keys', '-t', terminal, '-l', text], { timeoutMs: 30_000 })
      if (typed.code !== 0) return { delivered: false, detail: typed.stderr.trim() || `tmux send-keys exited ${typed.code ?? 'null'}` }
      const entered = await runner.run([tmux, 'send-keys', '-t', terminal, 'Enter'], { timeoutMs: 30_000 })
      return entered.code === 0 ? { delivered: true, detail: `sent to ${terminal}` } : { delivered: false, detail: entered.stderr.trim() || `tmux Enter exited ${entered.code ?? 'null'}` }
    },
    readScreen: async ({ terminal, lines }) => {
      const result = await runner.run([tmux, 'capture-pane', '-p', '-t', terminal, ...(lines ? ['-S', `-${lines}`] : [])], { timeoutMs: 30_000 })
      return result.code === 0 ? result.stdout : ''
    },
    /**
     * Reconcile the crontab: every line the harness owns carries `connectors.local.cronMarker`, so lines a human
     * added are never touched and lines the config stopped declaring are removed.
     */
    schedule: async (jobs) => {
      const marker = config.connectors.local.cronMarker
      const current = await runner.run(['crontab', '-l'], { timeoutMs: 15_000 })
      const existing = current.code === 0 ? current.stdout.split(/\r?\n/) : []
      const mine = existing.filter((line) => line.includes(marker))
      const theirs = existing.filter((line) => !line.includes(marker) && line.trim().length > 0)
      const wanted = jobs.map((job) => `${job.cron} ${job.command} ${marker} ${job.name}`)
      if (mine.length === wanted.length && mine.every((line, index) => line === wanted[index])) return []
      // `CommandRunner` has no stdin by design (no shells anywhere), so the new table goes through a file.
      const file = join(loaded.stateDir, 'crontab.local')
      mkdirSync(loaded.stateDir, { recursive: true })
      writeFileSync(file, `${[...theirs, ...wanted].join('\n')}\n`, 'utf8')
      const write = await runner.run(['crontab', file], { timeoutMs: 15_000 })
      if (write.code !== 0) fail(`crontab failed: ${write.stderr.trim() || `exit ${write.code ?? 'null'}`}`, 'HARNESS_ERROR')
      return wanted
    },
    // ponytail: git worktree + tmux know nothing about pull requests; the SCM-driven deliver stage is the only PR source here.
    observeWorkspaces: async () => [],
  }
}

/** The jobs a config declares, in the shape `RunnerConnector.schedule` takes. */
export const scheduledJobs = (loaded: LoadedLoopConfig, stages: readonly LoopStage[]): readonly ScheduledJob[] => stages.map((stage) => ({
  name: automationName(loaded.config, stage),
  cron: stage === 'tick' ? loaded.config.schedule.tick : stage === 'deliver' ? loaded.config.schedule.deliver : stage === 'retro' ? loaded.config.schedule.retro ?? loaded.config.schedule.deliver : loaded.config.schedule.observe ?? loaded.config.schedule.deliver,
  command: precheckCommand(loaded.config, loaded.path, stage),
}))

export const createRunnerConnector = (input: RunnerInput): RunnerConnector =>
  input.loaded.config.connectors.runner === 'local' ? createLocalRunner(input) : createOrcaRunner(input)
