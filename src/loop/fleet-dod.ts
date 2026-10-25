import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import type { ChecksAssessment, PullRequestCheck } from '../adapters/github-cli.js'
import type { LoopConfig } from './config.js'
import type { TaskContract } from './contract.js'
import { ARTIFACT_DIR, readVerifyArtifact, verifyProofs } from './artifacts.js'
import type { ControlMachineGate } from './control-machine.js'
import { readDodEvidence, type DodEvidenceFile, type DodProof } from './dod.js'
import { verifyOnFleet } from './fleet-verify.js'
import type { RunnerConnector } from './runner-connector.js'

/** What the definition of done is judged on for a fleet task: proofs the harness made itself, on the collected commit. */
export interface FleetDodEvidence {
  readonly evidence: DodEvidenceFile
  /** `base...head`, from the collected commits — not the remote agent's say-so. */
  readonly changedFiles: readonly string[]
  readonly fileContents: Readonly<Record<string, string>>
  readonly notes: readonly string[]
  /** Set when a proof is still on its way (a fleet verify task running, the control machine busy): the evidence is empty and nothing is judged this pass. */
  readonly waiting?: string
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
  /** The PR's green CI on `head`, from `ciVerification`: it proves the repository verification, which is then not re-run here. */
  readonly ci?: CiVerification | null
  /** The fleet to run the commands CI did not prove on (all but `connectors.fleet.localOnly`); absent, they all run here. */
  readonly fleet?: { readonly connector: RunnerConnector; readonly issue: string; readonly now: Date }
  /** Admits the commands that run here; absent, they run at once. */
  readonly controlMachine?: ControlMachineGate
}

/** What a green, gating CI run on the head stands for: the checks that passed, a run to read, and the verify command(s) it covers. */
export interface CiVerification {
  readonly checks: readonly string[]
  readonly url: string | null
  /** `delivery.verifyCommand` and the layer's own verify: an item or outcome running one of these is proven by CI. */
  readonly commands: readonly string[]
}

/**
 * CI proves the repository verification only where the flow gates on it (`merge.requireChecks`) and it is green on
 * the head. A rollup with no passing check is "green" by absence and proves nothing, so it gets the local re-run.
 */
export const ciVerification = (input: { readonly gating: boolean; readonly status: ChecksAssessment['status']; readonly checks: readonly PullRequestCheck[]; readonly ignore?: readonly string[]; readonly commands: readonly string[] }): CiVerification | null => {
  if (!input.gating || input.status !== 'green') return null
  const passed = input.checks.filter((check) => check.outcome === 'success' && !(input.ignore ?? []).includes(check.name))
  if (!passed.length) return null
  return { checks: passed.map((check) => check.name), url: passed.find((check) => check.url)?.url ?? null, commands: [...new Set(input.commands.map((command) => command.trim()).filter(Boolean))] }
}

const MAX_FILE_BYTES = 256 * 1024

const readPackageJson = (checkout: string): Record<string, unknown> | null => {
  try { const parsed = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as unknown; return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null } catch { return null }
}

const FROZEN_INSTALL: Readonly<Record<string, readonly string[]>> = { pnpm: ['pnpm', 'install', '--frozen-lockfile'], npm: ['npm', 'ci'], yarn: ['yarn', 'install', '--frozen-lockfile'], bun: ['bun', 'install', '--frozen-lockfile'] }

const LOCKFILES: readonly (readonly [string, readonly string[]])[] = [['pnpm', ['pnpm-lock.yaml']], ['npm', ['package-lock.json', 'npm-shrinkwrap.json']], ['yarn', ['yarn.lock']], ['bun', ['bun.lock', 'bun.lockb']]]

/** The repo's frozen install, when it has a lockfile: with the manager `packageManager` names, else the lockfile's own. Null when there is nothing to install. */
const installArgv = (checkout: string): readonly string[] | null => {
  if (!existsSync(join(checkout, 'package.json'))) return null
  const locked = LOCKFILES.find(([, files]) => files.some((file) => existsSync(join(checkout, file))))?.[0]
  if (!locked) return null
  const declared = /^(pnpm|npm|yarn|bun)@/.exec(String(readPackageJson(checkout)?.['packageManager'] ?? ''))?.[1]
  return FROZEN_INSTALL[declared ?? locked] ?? null
}

/** The Node the repo pins: `.nvmrc` / `.node-version`, else an exact-major `engines.node` (`22`, `^22`, `22.x`). An open range pins nothing. */
const pinnedNode = (checkout: string): string | null => {
  for (const file of ['.nvmrc', '.node-version']) {
    try { const version = readFileSync(join(checkout, file), 'utf8').trim().split(/\s+/)[0]?.replace(/^v/, ''); if (version && /^\d/.test(version)) return version } catch { /* not pinned this way */ }
  }
  const engines = readPackageJson(checkout)?.['engines']
  const range = typeof engines === 'object' && engines !== null ? String((engines as Record<string, unknown>)['node'] ?? '') : ''
  return /^\s*[\^~]?v?(\d+)(\.(\d+|x|\*))*\s*$/.exec(range)?.[1] ?? null
}

/**
 * The checkout's commands under the pinned Node, through whichever version manager the control machine has.
 * ponytail: fnm and mise only; without either the commands run on the machine's Node and a wrong engine surfaces as `blocked: environment`.
 */
const nodeWrapper = async (runner: CommandRunner, version: string | null): Promise<{ readonly wrap: (argv: readonly string[]) => readonly string[]; readonly note: string | null }> => {
  if (!version) return { wrap: (argv) => argv, note: null }
  const managers: readonly (readonly [string, (argv: readonly string[]) => readonly string[]])[] = [
    ['fnm', (argv) => ['fnm', 'exec', `--using=${version}`, '--', ...argv]],
    ['mise', (argv) => ['mise', 'exec', `node@${version}`, '--', ...argv]],
  ]
  for (const [name, wrap] of managers) {
    const probe = await runner.run([name, '--version'], { timeoutMs: 10_000 }).catch(() => null)
    if (probe && probe.code === 0 && !probe.timedOut) return { wrap, note: `ran under Node ${version} (pinned by the repo) via ${name}` }
  }
  return { wrap: (argv) => argv, note: `the repo pins Node ${version}, but neither fnm nor mise is on PATH: ran on the machine's Node` }
}

/** Output that says the machine, not the change, is what failed: a dependency that is not installed, a wrong engine, a missing binary. */
const ENVIRONMENT_FAILURE = /MODULE_NOT_FOUND|Cannot find (module|package)|ERR_PNPM_UNSUPPORTED_ENGINE|EBADENGINE|Unsupported engine|is incompatible with this module|command not found|spawn \S+ ENOENT/

/** The first line naming the environment failure, or null when the output reads like the change's own failure. */
export const environmentFailure = (output: string): string | null => {
  const line = output.split(/\r?\n/).find((candidate) => ENVIRONMENT_FAILURE.test(candidate))
  return line ? line.trim().slice(0, 200) : null
}

const sameCommand = (a: string, b: string): boolean => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')

const shellArgv = (line: string): readonly string[] => process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', line] : ['sh', '-c', line]

const tail = (value: string, max = 600): string => { const text = value.trim(); return text.length > max ? `…${text.slice(-max)}` : text }

/**
 * ADR-0045: a fleet task has no local worktree and no handoff files, so the definition of done is proven here, on a
 * temporary git worktree at the collected `head` (removed afterwards, success or failure).
 *
 * - `file-changed` / `pattern-absent` read `base...head` and the files as committed.
 * - `command` items, and contract outcomes that carry a command, are **re-run locally** — the remote agent's own
 *   claim about them is never evidence. Output is recorded as the proof, the way the other runners record it.
 *   Before them, the repo's frozen install runs under the Node it pins (when a version manager is there); an install
 *   or a run that fails for the machine's sake (a missing module, a wrong engine) is `blocked: environment`, not `failed`.
 * - The repository verification (the `verify` item, or an item/outcome running `delivery.verifyCommand`) is not
 *   re-run when `input.ci` says the PR's gating CI is green on `head`: it is `ci-verified`, with the checks as evidence.
 * - With `input.fleet`, a command CI did not prove is not run here at all: one fleet task runs them on `head`
 *   (`fleet-verified`, the task id as evidence). Only ids in `connectors.fleet.localOnly` still run in this checkout,
 *   admitted by `input.controlMachine` (one at a time machine-wide, only while it is quiet). Until both answer the
 *   result is `waiting`, never a failure.
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
    // The repository verification, with a green gating CI on this head, is CI's to prove: re-running it here only
    // duplicates CI in an environment the PR cannot fix (no services, another Node). Smaller checks still run here.
    const { ci } = input
    const provenByCi = (id: string, label: string): boolean => !!ci && (id === 'verify' || ci.commands.some((command) => sameCommand(command, label)))
    const ciProof = (id: string): DodProof => ({ id, status: 'passed', verdict: 'ci-verified', evidence: `proven by CI on ${head.slice(0, 12)}: ${(ci?.checks ?? []).slice(0, 5).join(', ')}${(ci?.checks.length ?? 0) > 5 ? ` (+${(ci?.checks.length ?? 0) - 5})` : ''} green${ci?.url ? ` — ${ci.url}` : ''}; not re-run locally` })
    const uncovered = [
      ...commandItems.filter((item) => !provenByCi(item.id, (item.command ?? []).join(' '))).map((item) => ({ id: item.id, argv: item.command ?? [], label: (item.command ?? []).join(' ') })),
      ...commandOutcomes.filter((outcome) => !provenByCi(outcome.id, outcome.check.command ?? '')).map((outcome) => ({ id: outcome.id, argv: shellArgv(outcome.check.command ?? ''), label: outcome.check.command ?? '' })),
    ]
    // On the fleet runner the control machine runs only what the config pins to it; the rest is a fleet task.
    const onFleet = input.fleet ? uncovered.filter((item) => !config.connectors.fleet.localOnly.includes(item.id)) : []
    const local = uncovered.filter((item) => !onFleet.includes(item))
    const ran = new Map<string, DodProof>()
    const waiting: string[] = []
    if (input.fleet && onFleet.length) {
      const fleet = await verifyOnFleet({ stateDir, connector: input.fleet.connector, issue: input.fleet.issue, head, commands: onFleet.map((item) => ({ id: item.id, command: item.label })), now: input.fleet.now, timeoutMs: config.verifier.budget.timeoutMs, environmentFailure })
      if (fleet.status === 'waiting') waiting.push(fleet.detail)
      else { notes.push(fleet.detail); for (const proof of fleet.proofs) ran.set(proof.id, proof) }
    }
    const runLocal = async (): Promise<void> => {
      let blocked: DodProof | null = null
      const node = await nodeWrapper(runner, pinnedNode(checkout))
      if (node.note) notes.push(node.note)
      const install = installArgv(checkout)
      if (install) {
        const installed = await runner.run(node.wrap(install), { cwd: checkout, timeoutMs })
        const output = `${installed.stderr}\n${installed.stdout}`
        const environment = installed.timedOut ? `\`${install.join(' ')}\` timed out after ${timeoutMs}ms` : installed.code !== 0 ? environmentFailure(output) : null
        // A lockfile the change left stale is the change's failure; a machine that cannot install is not.
        if (environment) blocked = { id: '', status: 'failed', verdict: 'blocked', evidence: `blocked: environment — ${environment} (\`${install.join(' ')}\` on ${head.slice(0, 12)}; not a failure of the change)` }
        else if (installed.code !== 0) blocked = { id: '', status: 'failed', evidence: `\`${install.join(' ')}\` exited ${installed.code ?? 'null'} on ${head.slice(0, 12)}: ${tail(installed.stderr || installed.stdout)}` }
        else notes.push(`installed dependencies with \`${install.join(' ')}\``)
      }
      for (const item of local) ran.set(item.id, blocked ? { ...blocked, id: item.id } : await proof(item.id, node.wrap(item.argv), item.label))
    }
    const proof = async (id: string, argv: readonly string[], label: string): Promise<DodProof> => {
      const outcome = await runner.run(argv, { cwd: checkout, timeoutMs })
      const status = !outcome.timedOut && outcome.code === 0 ? 'passed' : 'failed'
      const result = outcome.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${outcome.code ?? 'null'}`
      const output = tail(`${outcome.stdout}\n${outcome.stderr}`)
      const environment = status === 'failed' && !outcome.timedOut ? environmentFailure(`${outcome.stderr}\n${outcome.stdout}`) : null
      if (environment) return { id, status, verdict: 'blocked', evidence: `blocked: environment — ${environment} (ran \`${label}\` in a local checkout of ${head.slice(0, 12)}: ${result}; not a failure of the change)` }
      // A command the harness re-ran in a checkout is a test result, not a run against the live system.
      return { id, status, verdict: status === 'passed' ? 'unit-verified' : 'failed', evidence: `ran \`${label}\` in a local checkout of ${head.slice(0, 12)}: ${result}${output ? `\n${output}` : ''}` }
    }
    if (local.length) {
      const gate = input.controlMachine ?? (async (work) => ({ ran: true, value: await work() }))
      const gated = await gate(runLocal)
      if (!gated.ran) waiting.push(`${gated.detail} — local-only: ${local.map((item) => item.id).join(', ')}`)
    }
    if (waiting.length) return { evidence: { project: [], outcomes: [] }, changedFiles, fileContents, notes, waiting: waiting.join('; ') }
    const project = commandItems.map((item) => ran.get(item.id) ?? ciProof(item.id))
    const rerun = commandOutcomes.map((outcome) => ran.get(outcome.id) ?? ciProof(outcome.id))
    const byCi = [...project, ...rerun].filter((item) => item.verdict === 'ci-verified').map((item) => item.id)
    if (byCi.length) notes.push(`proven by CI, not re-run locally: ${byCi.join(', ')}`)

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
