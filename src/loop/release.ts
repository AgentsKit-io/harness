import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { fail } from '../kernel/errors.js'
import type { LoadedLoopConfig } from './config.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { appendLoopEvent } from './tick.js'
import { createLoopEventBus, loadLoopPlugins, type LoopEventBus } from './event-bus.js'
import { attachNotifier } from './notify.js'

/** One merged commit waiting on the integration branch — a line of the batch a human is asked to approve. */
export interface ReleaseCommit { readonly sha: string; readonly subject: string; readonly issue: string | null }

export interface ReleaseBatch {
  readonly base: string
  readonly branch: string
  /** Head of the integration branch when the batch was read. An approval is bound to this sha. */
  readonly head: string | null
  readonly commits: readonly ReleaseCommit[]
  readonly issues: readonly string[]
  readonly error: string | null
}

export interface ReleaseApproval { readonly head: string; readonly actor: string; readonly at: string; readonly commits: number }

export interface ReleaseState {
  readonly approval: ReleaseApproval | null
  readonly history: readonly { readonly head: string; readonly at: string; readonly status: 'promoted' | 'deployed' | 'rolled-back' | 'failed'; readonly detail: string }[]
  /** The head whose "waiting for approval" was already announced. The stage runs on a cron; the news does not repeat. */
  readonly waitingNotifiedFor: string | null
}

export const releaseStatePath = (stateDir: string): string => join(stateDir, 'release.json')

export const readReleaseState = (stateDir: string): ReleaseState => {
  const path = releaseStatePath(stateDir)
  if (!existsSync(path)) return { approval: null, history: [], waitingNotifiedFor: null }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReleaseState>
    return { approval: value.approval ?? null, history: Array.isArray(value.history) ? value.history : [], waitingNotifiedFor: value.waitingNotifiedFor ?? null }
  } catch { return { approval: null, history: [], waitingNotifiedFor: null } }
}

const writeReleaseState = (stateDir: string, state: ReleaseState): void => writeJsonAtomic(releaseStatePath(stateDir), state)

const ISSUE_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/

/** What is on the integration branch and not yet on the release branch, newest first. */
export const readReleaseBatch = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner }): Promise<ReleaseBatch> => {
  const { config } = input.loaded
  const base = config.project.baseBranch
  const branch = config.release.branch
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await input.runner.run(['git', '-C', input.loaded.root, ...args], { timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.code ?? 'null'}`)
    return result.stdout.trim()
  }
  try {
    const head = await git(['rev-parse', base])
    const log = await git(['log', '--no-merges', '--format=%H%x1f%s', `${branch}..${base}`])
    const commits: ReleaseCommit[] = log ? log.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha = '', subject = ''] = line.split('\u001f')
      return { sha, subject, issue: ISSUE_PATTERN.exec(subject)?.[1] ?? null }
    }) : []
    return { base, branch, head, commits, issues: [...new Set(commits.map((commit) => commit.issue).filter((issue): issue is string => issue !== null))], error: null }
  } catch (error) {
    return { base, branch, head: null, commits: [], issues: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Record a human's approval of exactly this batch.
 *
 * The approval carries the head sha it was given for: anything merged afterwards is a different batch and needs
 * its own approval. An approval that outlived its commits would be a rubber stamp.
 */
export const approveRelease = (input: { readonly loaded: LoadedLoopConfig; readonly batch: ReleaseBatch; readonly actor: string; readonly now?: () => Date }): ReleaseApproval => {
  const head = input.batch.head ?? fail(`Cannot approve a release: ${input.batch.error ?? 'the integration branch head is unknown'}`, 'INVALID_STATE')
  if (!input.batch.commits.length) fail(`Nothing to release: ${input.batch.branch} already contains ${input.batch.base}.`, 'INVALID_STATE')
  const approval: ReleaseApproval = { head, actor: input.actor, at: ((input.now ?? (() => new Date()))()).toISOString(), commits: input.batch.commits.length }
  const state = readReleaseState(input.loaded.stateDir)
  writeReleaseState(input.loaded.stateDir, { ...state, approval })
  return approval
}

export interface ReleaseReport {
  readonly status: 'ok' | 'waiting' | 'idle' | 'failed' | 'rolled-back' | 'dry-run'
  readonly batch: ReleaseBatch
  readonly approval: ReleaseApproval | null
  readonly promoted: boolean
  readonly deployed: boolean
  readonly smoke: 'passed' | 'failed' | 'skipped'
  readonly actions: readonly string[]
  readonly detail: string
}

/**
 * Promote the approved batch and run the project's deploy.
 *
 * Nothing here happens without a human's approval bound to this exact head. A failed smoke runs the declared
 * rollback and escalates; a project that declares no rollback is told so plainly rather than left guessing.
 */
export const runReleaseStage = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly now?: () => Date; readonly dryRun?: boolean; readonly bus?: LoopEventBus }): Promise<ReleaseReport> => {
  // The stage's events are worth a human's attention — a batch waiting for approval most of all — so they go out
  // on the same bus every other stage uses, and the sends in flight are awaited before the stage ends. An
  // externally-owned bus (`loop stage`) already has plugins/notifier attached; its owner flushes it once for the
  // whole invocation, so attaching a second notifier here would double-send every notification.
  const ownsBus = !input.bus
  const bus = input.bus ?? createLoopEventBus()
  if (!ownsBus) return releaseStage(input, bus)
  if (input.loaded.config.plugins.modules.length) await loadLoopPlugins(input.loaded.root, input.loaded.config.plugins.modules, bus)
  const flush = attachNotifier(bus, { config: input.loaded.config, runner: input.runner })
  try { return await releaseStage(input, bus) } finally { await flush() }
}

const releaseStage = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly now?: () => Date; readonly dryRun?: boolean }, bus: LoopEventBus): Promise<ReleaseReport> => {
  const { loaded } = input
  const { config } = loaded
  const now = (input.now ?? (() => new Date()))()
  const actions: string[] = []
  const batch = await readReleaseBatch({ loaded, runner: input.runner })
  const state = readReleaseState(loaded.stateDir)
  const approval = state.approval

  const report = (status: ReleaseReport['status'], detail: string, extra: Partial<ReleaseReport> = {}): ReleaseReport =>
    ({ status, batch, approval, promoted: false, deployed: false, smoke: 'skipped', actions, detail, ...extra })

  if (!config.release.enabled) return report('idle', 'release.enabled is false')
  if (config.release.branch === config.project.baseBranch) return report('failed', `release.branch and project.baseBranch are both "${config.release.branch}"; promotion would be a no-op`)
  if (batch.error) return report('failed', batch.error)
  if (!batch.commits.length) return report('idle', `${batch.branch} already contains ${batch.base}`)
  // A batch nobody approved is a human's cue; a cron that repeats it every few minutes is noise. Said once per
  // head, because a new merge is genuinely new news and the sha is what an approval is bound to anyway.
  const waiting = (detail: string): ReleaseReport => {
    if (!input.dryRun && batch.head && state.waitingNotifiedFor !== batch.head) {
      writeReleaseState(loaded.stateDir, { ...state, waitingNotifiedFor: batch.head })
      appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.waiting', head: batch.head, branch: batch.branch, commits: batch.commits.length, issues: batch.issues, detail }, bus)
    }
    return report('waiting', detail)
  }
  if (!approval) return waiting(`${batch.commits.length} commit(s) waiting for "ak-harness loop release approve"`)
  if (approval.head !== batch.head) return waiting(`the approval covers ${approval.head.slice(0, 12)} but ${batch.base} is now at ${batch.head?.slice(0, 12) ?? 'unknown'} — re-approve the current batch`)
  if (input.dryRun) return report('dry-run', `would promote ${batch.commits.length} commit(s) to ${batch.branch}${config.release.deploy ? ' and deploy' : ''}`)

  const run = async (argv: readonly string[], timeoutSec: number): Promise<{ readonly ok: boolean; readonly detail: string }> => {
    try {
      const result = await input.runner.run(argv, { timeoutMs: timeoutSec * 1000, cwd: loaded.root })
      return { ok: result.code === 0, detail: result.code === 0 ? `${argv[0]} exited 0` : `${argv[0]} exited ${result.code ?? 'null'}: ${(result.stderr || result.stdout).trim().slice(0, 300)}` }
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
  }
  const record = (status: ReleaseState['history'][number]['status'], detail: string): void => {
    writeReleaseState(loaded.stateDir, { approval: status === 'promoted' || status === 'deployed' ? null : approval, history: [...state.history, { head: approval.head, at: now.toISOString(), status, detail }], waitingNotifiedFor: null })
  }

  // Notes are written and committed BEFORE the promotion, so the branch that reaches production carries them.
  let head = batch.head
  if (config.release.notesFile) {
    const notes = await writeReleaseNotes({ loaded, runner: input.runner, batch, at: now })
    actions.push(`notes → ${notes.detail}`)
    if (notes.ok && notes.detail.startsWith('notes written')) {
      const rev = await input.runner.run(['git', '-C', loaded.root, 'rev-parse', batch.base], { timeoutMs: 15_000 })
      if (rev.code === 0 && rev.stdout.trim()) head = rev.stdout.trim()
    }
  }
  const push = await run(['git', '-C', loaded.root, 'push', 'origin', `${head}:refs/heads/${batch.branch}`], 120)
  actions.push(`promote → ${push.detail}`)
  if (!push.ok) { record('failed', push.detail); appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.failed', head: batch.head, phase: 'promote', detail: push.detail }, bus); return report('failed', push.detail) }
  appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.promoted', head: batch.head, branch: batch.branch, commits: batch.commits.length, issues: batch.issues, approvedBy: approval.actor }, bus)

  if (!config.release.deploy) { record('promoted', push.detail); return report('ok', `promoted ${batch.commits.length} commit(s) to ${batch.branch}; no deploy declared`, { promoted: true }) }
  const deploy = await run(config.release.deploy, config.release.deployTimeoutSec)
  actions.push(`deploy → ${deploy.detail}`)
  if (!deploy.ok) {
    appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.failed', head: batch.head, phase: 'deploy', detail: deploy.detail }, bus)
    record('failed', deploy.detail)
    return report('failed', `promoted, but the deploy failed: ${deploy.detail}`, { promoted: true })
  }
  appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.deployed', head: batch.head, branch: batch.branch }, bus)

  if (!config.release.smoke) { record('deployed', deploy.detail); return report('ok', `promoted and deployed ${batch.commits.length} commit(s)`, { promoted: true, deployed: true }) }
  const smoke = await run(config.release.smoke, config.release.smokeTimeoutSec)
  actions.push(`smoke → ${smoke.detail}`)
  if (smoke.ok) { record('deployed', smoke.detail); return report('ok', `promoted, deployed and smoke-tested ${batch.commits.length} commit(s)`, { promoted: true, deployed: true, smoke: 'passed' }) }

  appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.smoke-failed', head: batch.head, detail: smoke.detail }, bus)
  if (!config.release.rollback) {
    record('failed', smoke.detail)
    return report('failed', `smoke failed after deploy and no release.rollback is declared — a human must decide: ${smoke.detail}`, { promoted: true, deployed: true, smoke: 'failed' })
  }
  const rollback = await run(config.release.rollback, config.release.rollbackTimeoutSec)
  actions.push(`rollback → ${rollback.detail}`)
  appendLoopEvent(loaded.stateDir, { at: now.toISOString(), type: 'release.rolled-back', head: batch.head, ok: rollback.ok, detail: rollback.detail }, bus)
  record('rolled-back', rollback.detail)
  return report('rolled-back', `smoke failed; rollback ${rollback.ok ? 'succeeded' : `FAILED: ${rollback.detail}`}`, { promoted: true, deployed: true, smoke: 'failed' })
}

/**
 * Release notes for a batch: every merged commit, grouped by the issue it carries.
 *
 * It is built from what actually merged — subjects and issue keys — rather than from a model's summary, because
 * a release note that cannot be checked against the log is a press release.
 */
export const renderReleaseNotes = (batch: ReleaseBatch, at: Date): string => {
  const byIssue = new Map<string, ReleaseCommit[]>()
  for (const commit of batch.commits) {
    const key = commit.issue ?? 'no issue'
    byIssue.set(key, [...(byIssue.get(key) ?? []), commit])
  }
  const lines = [`## ${at.toISOString().slice(0, 10)} — ${batch.commits.length} change(s) to ${batch.branch}`, '']
  for (const [issue, commits] of byIssue) {
    lines.push(`- **${issue}**`)
    for (const commit of commits) lines.push(`  - ${commit.subject} (\`${commit.sha.slice(0, 8)}\`)`)
  }
  lines.push('')
  return lines.join('\n')
}

const writeReleaseNotes = async (input: { readonly loaded: LoadedLoopConfig; readonly runner: CommandRunner; readonly batch: ReleaseBatch; readonly at: Date }): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  const file = input.loaded.config.release.notesFile
  if (!file) return { ok: true, detail: 'no notesFile declared' }
  const path = resolve(input.loaded.root, file)
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    // Newest first, and the previous content is kept verbatim: notes are a log, not a document to rewrite.
    writeFileSync(path, `${renderReleaseNotes(input.batch, input.at)}\n${existing}`.trimStart(), 'utf8')
    const add = await input.runner.run(['git', '-C', input.loaded.root, 'add', path], { timeoutMs: 15_000 })
    if (add.code !== 0) return { ok: false, detail: add.stderr.trim() || `git add exited ${add.code ?? 'null'}` }
    const commit = await input.runner.run(['git', '-C', input.loaded.root, 'commit', '-m', `docs(release): notes for ${input.batch.commits.length} change(s)`], { timeoutMs: 30_000 })
    if (commit.code !== 0) return { ok: false, detail: commit.stderr.trim() || `git commit exited ${commit.code ?? 'null'}` }
    return { ok: true, detail: `notes written to ${file}` }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
}

export const renderReleaseMarkdown = (report: ReleaseReport): string => {
  const lines = [`# Release — ${report.batch.base} → ${report.batch.branch}`, '', `_${report.status}_ · ${report.detail}`, '']
  if (report.batch.commits.length) {
    lines.push(`## Batch (${report.batch.commits.length} commit(s)${report.batch.issues.length ? `, issues: ${report.batch.issues.join(', ')}` : ''})`, '')
    for (const commit of report.batch.commits) lines.push(`- \`${commit.sha.slice(0, 8)}\` ${commit.subject}`)
    lines.push('')
  }
  lines.push(report.approval ? `Approved by ${report.approval.actor} at ${report.approval.at} for head \`${report.approval.head.slice(0, 12)}\`` : '_Not approved yet: `ak-harness loop release approve`_')
  if (report.actions.length) lines.push('', '## Actions', '', ...report.actions.map((action) => `- ${action}`))
  return lines.join('\n')
}
