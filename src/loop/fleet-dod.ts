import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import type { LoopConfig } from './config.js'
import type { TaskContract } from './contract.js'
import { ARTIFACT_DIR, readVerifyArtifact, verifyProofs } from './artifacts.js'
import { readDodEvidence, type DodEvidenceFile, type DodProof } from './dod.js'

/** What the definition of done is judged on for a fleet task: proofs the harness made itself, on the collected commit. */
export interface FleetDodEvidence {
  readonly evidence: DodEvidenceFile
  /** `base...head`, from the collected commits — not the remote agent's say-so. */
  readonly changedFiles: readonly string[]
  readonly fileContents: Readonly<Record<string, string>>
  readonly notes: readonly string[]
}

export interface FleetDodInput {
  readonly runner: CommandRunner
  readonly config: LoopConfig
  /** The main clone: the temporary worktree is added to it, and the commits were fetched into it by `fleet collect`. */
  readonly root: string
  readonly stateDir: string
  readonly head: string
  /** `baseSha` from `fleet collect --json`; absent, the merge-base with `origin/<baseBranch>` stands in. */
  readonly base?: string
  readonly contract: TaskContract | null
  /** Where `fleet-handoff.ts` kept the `.ak-loop/` files the PR no longer carries; the checkout is read when there are none. */
  readonly handoff?: string
}

const MAX_FILE_BYTES = 256 * 1024

/** The repo's frozen install, by lockfile. Null when there is nothing to install. */
const installArgv = (checkout: string): readonly string[] | null => {
  if (!existsSync(join(checkout, 'package.json'))) return null
  if (existsSync(join(checkout, 'pnpm-lock.yaml'))) return ['pnpm', 'install', '--frozen-lockfile']
  if (existsSync(join(checkout, 'package-lock.json')) || existsSync(join(checkout, 'npm-shrinkwrap.json'))) return ['npm', 'ci']
  if (existsSync(join(checkout, 'yarn.lock'))) return ['yarn', 'install', '--frozen-lockfile']
  if (existsSync(join(checkout, 'bun.lock')) || existsSync(join(checkout, 'bun.lockb'))) return ['bun', 'install', '--frozen-lockfile']
  return null
}

const shellArgv = (line: string): readonly string[] => process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', line] : ['sh', '-c', line]

const tail = (value: string, max = 600): string => { const text = value.trim(); return text.length > max ? `…${text.slice(-max)}` : text }

/**
 * ADR-0045: a fleet task has no local worktree and no handoff files, so the definition of done is proven here, on a
 * temporary git worktree at the collected `head` (removed afterwards, success or failure).
 *
 * - `file-changed` / `pattern-absent` read `base...head` and the files as committed.
 * - `command` items, and contract outcomes that carry a command, are **re-run locally** — the remote agent's own
 *   claim about them is never evidence. Output is recorded as the proof, the way the other runners record it.
 * - Outcomes with no command (a `manual` check) are proven only by the handoff the agent committed in the collected
 *   branch (`.ak-loop/verify.json`, `dod.json`). The harness removes those files from the PR after reading them, so
 *   they come from `input.handoff` (the copy in the state dir); this checkout is the fallback.
 */
export const proveFleetDod = async (input: FleetDodInput): Promise<FleetDodEvidence> => {
  const { runner, config, root, stateDir, head, contract } = input
  const timeoutMs = config.connectors.fleet.verifyTimeoutMs
  const notes: string[] = []
  mkdirSync(stateDir, { recursive: true })
  const checkout = mkdtempSync(join(stateDir, 'fleet-checkout-'))
  const git = (args: readonly string[], cwd: string = root) => runner.run(['git', '-C', cwd, ...args], { timeoutMs: 120_000 })
  let added = false
  try {
    let created = await git(['worktree', 'add', '--detach', checkout, head])
    // The commits normally sit in the clone already (`fleet collect` fetched them); a head only the remote has is fetched once.
    if (created.code !== 0) { await git(['fetch', '--quiet', 'origin', head]); created = await git(['worktree', 'add', '--detach', checkout, head]) }
    if (created.code !== 0) throw new Error(`could not check out ${head.slice(0, 12)} for the definition of done: ${tail(created.stderr || created.stdout, 300) || `exit ${created.code ?? 'null'}`}`)
    added = true

    const base = input.base ?? `origin/${config.project.baseBranch}`
    const diff = await git(['diff', '--name-only', `${base}...${head}`], checkout)
    if (diff.code !== 0) throw new Error(`git diff ${base.slice(0, 12)}...${head.slice(0, 12)} failed: ${tail(diff.stderr, 300) || `exit ${diff.code ?? 'null'}`}`)
    const changedFiles = diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const fileContents: Record<string, string> = {}
    for (const file of changedFiles) {
      try { const path = join(checkout, file); if (statSync(path).isFile() && statSync(path).size <= MAX_FILE_BYTES) fileContents[file] = readFileSync(path, 'utf8') } catch { /* deleted in head: nothing to inspect */ }
    }

    const commandItems = config.dod.items.filter((item) => item.kind === 'command' && item.command?.length)
    const commandOutcomes = (contract?.outcomes ?? []).filter((outcome) => outcome.check.kind !== 'manual' && outcome.check.command)
    let blocked: string | null = null
    if (commandItems.length || commandOutcomes.length) {
      const install = installArgv(checkout)
      if (install) {
        const installed = await runner.run(install, { cwd: checkout, timeoutMs })
        if (installed.timedOut || installed.code !== 0) blocked = `\`${install.join(' ')}\` ${installed.timedOut ? 'timed out' : `exited ${installed.code ?? 'null'}`} on ${head.slice(0, 12)}: ${tail(installed.stderr || installed.stdout)}`
        else notes.push(`installed dependencies with \`${install.join(' ')}\``)
      }
    }
    const proof = async (id: string, argv: readonly string[], label: string): Promise<DodProof> => {
      if (blocked) return { id, status: 'failed', evidence: blocked }
      const outcome = await runner.run(argv, { cwd: checkout, timeoutMs })
      const status = !outcome.timedOut && outcome.code === 0 ? 'passed' : 'failed'
      const result = outcome.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${outcome.code ?? 'null'}`
      // A command the harness re-ran in a checkout is a test result, not a run against the live system.
      return { id, status, verdict: status === 'passed' ? 'unit-verified' : 'failed', evidence: `ran \`${label}\` in a local checkout of ${head.slice(0, 12)}: ${result}${tail(`${outcome.stdout}\n${outcome.stderr}`) ? `\n${tail(`${outcome.stdout}\n${outcome.stderr}`)}` : ''}` }
    }
    const project: DodProof[] = []
    for (const item of commandItems) project.push(await proof(item.id, item.command ?? [], (item.command ?? []).join(' ')))
    const rerun: DodProof[] = []
    for (const outcome of commandOutcomes) rerun.push(await proof(outcome.id, shellArgv(outcome.check.command ?? ''), outcome.check.command ?? ''))

    // Only what the harness could not run itself comes from the agent's committed handoff, and never over a local result.
    const from = input.handoff && existsSync(join(input.handoff, ARTIFACT_DIR)) ? input.handoff : checkout
    const handoff = readDodEvidence(from, config)
    const verify = verifyProofs(readVerifyArtifact(from))
    const claimed = [...handoff.outcomes, ...verify.filter((item) => !handoff.outcomes.some((recorded) => recorded.id === item.id))]
    const outcomes = [...rerun, ...claimed.filter((item) => !rerun.some((own) => own.id === item.id))]
    return { evidence: { project, outcomes }, changedFiles, fileContents, notes }
  } finally {
    if (added) await git(['worktree', 'remove', '--force', checkout]).catch(() => undefined)
    rmSync(checkout, { recursive: true, force: true })
    await git(['worktree', 'prune']).catch(() => undefined)
  }
}
