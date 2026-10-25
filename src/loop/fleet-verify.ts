import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile } from '../kernel/json-file.js'
import type { DodProof } from './dod.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { RunnerConnector } from './runner-connector.js'

/**
 * The verify CI did not prove, run as a fleet task instead of on the control machine. The task checks out the PR
 * head, runs the configured commands read-only (it may write only its own worktree) and prints one result line: the
 * exit code and the log tail per command. The harness judges that line itself; the task never says "passed".
 * ponytail: `fleet submit` takes no policy flag the harness knows of, so the read-only policy travels in the brief; the fleet host's own task allowlist is what enforces it.
 */

const RESULT_MARKER = 'LOOP-VERIFY-RESULT:'

const ResultSchema = z.object({
  head: z.string().min(7),
  nonce: z.string().min(8),
  items: z.array(z.object({ id: z.string().min(1), exitCode: z.number().int().nullable(), tail: z.string().default('') })),
})
type FleetVerifyAnswer = z.infer<typeof ResultSchema>

const ProofSchema = z.object({ id: z.string(), status: z.enum(['passed', 'failed']), verdict: z.enum(['failed', 'blocked', 'fleet-verified']), evidence: z.string() })

const StateSchema = z.object({
  head: z.string(),
  /** The command ids asked for: a different set on the same head (a new contract) is a new task. */
  ids: z.array(z.string()),
  nonce: z.string(),
  workspaceId: z.string(),
  /** The fleet's own id for the task (`q-…`), the evidence a person can look up. */
  task: z.string(),
  submittedAt: z.string(),
  result: z.array(ProofSchema).optional(),
})
type FleetVerifyState = z.infer<typeof StateSchema>

export const fleetVerifyStatePath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'fleet-verify.json')

/** One command the task runs: a DoD item or contract outcome id, and the shell line. */
export interface FleetVerifyCommand { readonly id: string; readonly command: string }

export const renderFleetVerifyBrief = (input: { readonly head: string; readonly nonce: string; readonly commands: readonly FleetVerifyCommand[] }): string => `# Verify commit ${input.head.slice(0, 12)}

You are a verification run. Policy: **read-only** everywhere except this task's own worktree. Never edit tracked files, commit, push, open a pull request or touch anything outside the worktree.

1. Check out exactly commit \`${input.head}\` in this worktree (detached), and install its dependencies from the lockfile if it has one.
2. Run each command below from the worktree root, one after the other, and keep its exit code and the last 40 lines of its output:
${input.commands.map((item) => `   - \`${item.id}\`: \`${item.command}\``).join('\n')}
3. Do not fix anything and do not judge the result; a command that cannot start has a non-zero exit code and its error as the tail.

Finish by printing one line starting with \`${RESULT_MARKER}\` followed by a single-line JSON object with the keys \`head\` (the full sha you checked out), \`nonce\` (exactly \`${input.nonce}\`) and \`items\` (one object per command: \`id\`, \`exitCode\` (a number, or null if it timed out) and \`tail\` (the output lines, as one string)). Nothing after that line.
`

/** The last result line in the task's output that parses; the brief's own description of it does not. */
export const parseFleetVerifyResult = (screen: string): FleetVerifyAnswer | null => {
  for (const line of screen.split(/\r?\n/).reverse()) {
    const at = line.indexOf(RESULT_MARKER)
    if (at < 0) continue
    try { const parsed = ResultSchema.safeParse(JSON.parse(line.slice(at + RESULT_MARKER.length).trim())); if (parsed.success) return parsed.data } catch { /* the brief's wording, or noise */ }
  }
  return null
}

export interface FleetVerifyResult {
  readonly status: 'done' | 'waiting'
  readonly detail: string
  /** One per command when `done`: `fleet-verified` on exit 0, else `failed` (or `blocked` when the task gave no result). */
  readonly proofs: readonly DodProof[]
}

export interface FleetVerifyInput {
  readonly stateDir: string
  readonly connector: RunnerConnector
  readonly issue: string
  readonly head: string
  readonly commands: readonly FleetVerifyCommand[]
  readonly now: Date
  /** A task with no result after this long is blocked, not pending. */
  readonly timeoutMs: number
  /** Classifies a failed command's tail as the machine's fault (`blocked: environment`) rather than the change's. */
  readonly environmentFailure?: (output: string) => string | null
}

const slug = (value: string): string => value.replaceAll(/[^A-Za-z0-9_-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40) || 'issue'
const clip = (value: string, max = 600): string => { const text = value.trim(); return text.length > max ? `…${text.slice(-max)}` : text }

/**
 * One step of the fleet verify of a PR head; deliver calls it every pass until it stops saying `waiting`. The first
 * call submits (base = the PR head), later ones read the task's output. A judged head is never run twice.
 */
export const verifyOnFleet = async (input: FleetVerifyInput): Promise<FleetVerifyResult> => {
  const { connector, head, commands } = input
  const path = fleetVerifyStatePath(input.stateDir, input.issue)
  const ids = commands.map((item) => item.id)
  const state = readJsonFile(path, StateSchema)
  const same = state?.head === head && state.ids.join('\n') === ids.join('\n')
  const remove = async (id: string): Promise<void> => { try { await connector.removeWorkspace({ id, force: true }) } catch { /* the result stands; a leftover record is housekeeping */ } }
  if (same && state.result) return { status: 'done', detail: `fleet task ${state.task} already judged ${head.slice(0, 7)}`, proofs: state.result }

  if (!state || !same) {
    if (state && !state.result) await remove(state.workspaceId)
    const nonce = randomUUID()
    const workspace = await connector.createWorkspace({ name: `verify-${slug(input.issue)}-${head.slice(0, 7)}`, branch: `verify/${slug(input.issue)}-${head.slice(0, 7)}`, baseBranch: head })
    const terminal = await connector.launchAgent({ workspace, command: '', title: 'verify' })
    const sent = await connector.send({ terminal, text: renderFleetVerifyBrief({ head, nonce, commands }) })
    if (!sent.delivered) { await remove(workspace.id); return { status: 'waiting', detail: `fleet verify not submitted, retried next pass: ${sent.detail}`, proofs: [] } }
    const task = /\b(q-[\w-]+)/.exec(sent.detail)?.[1] ?? workspace.id
    mkdirSync(join(input.stateDir, 'issues', input.issue), { recursive: true })
    writeJsonAtomic(path, { head, ids, nonce, workspaceId: workspace.id, task, submittedAt: input.now.toISOString() } satisfies FleetVerifyState)
    return { status: 'waiting', detail: `fleet verify task ${task} submitted for ${head.slice(0, 7)} (${ids.join(', ')})`, proofs: [] }
  }

  const finish = async (proofs: readonly z.infer<typeof ProofSchema>[], detail: string): Promise<FleetVerifyResult> => {
    writeJsonAtomic(path, { ...state, result: [...proofs] } satisfies FleetVerifyState)
    await remove(state.workspaceId)
    return { status: 'done', detail, proofs }
  }
  const unanswered = (why: string) => finish(commands.map((item) => ({ id: item.id, status: 'failed' as const, verdict: 'blocked' as const, evidence: `blocked: fleet task ${state.task} ${why}; \`${item.command}\` was not verified on ${head.slice(0, 12)}` })), `fleet task ${state.task} ${why}`)
  const observed = (await connector.observeWorkspaces()).find((item) => item.id === state.workspaceId)
  const answer = parseFleetVerifyResult(await connector.readScreen({ terminal: state.workspaceId, lines: 400 }))
  // A line for another submission or another commit is not this result.
  if (answer && answer.nonce === state.nonce && (head.startsWith(answer.head) || answer.head.startsWith(head))) {
    const proofs = commands.map((item) => {
      const ran = answer.items.find((candidate) => candidate.id === item.id)
      if (!ran) return { id: item.id, status: 'failed' as const, verdict: 'blocked' as const, evidence: `blocked: fleet task ${state.task} returned no result for \`${item.command}\`` }
      const result = ran.exitCode === null ? 'timed out' : `exit ${ran.exitCode}`
      const headline = `fleet task ${state.task} ran \`${item.command}\` on ${head.slice(0, 12)}: ${result}`
      const evidence = `${headline}${ran.tail.trim() ? `\n${clip(ran.tail)}` : ''}`
      if (ran.exitCode === 0) return { id: item.id, status: 'passed' as const, verdict: 'fleet-verified' as const, evidence }
      const environment = ran.exitCode === null ? null : input.environmentFailure?.(ran.tail) ?? null
      return environment ? { id: item.id, status: 'failed' as const, verdict: 'blocked' as const, evidence: `blocked: environment — ${environment} (${headline}; not a failure of the change)` } : { id: item.id, status: 'failed' as const, verdict: 'failed' as const, evidence }
    })
    return finish(proofs, `fleet task ${state.task}: ${proofs.filter((proof) => proof.status === 'passed').length}/${proofs.length} passed`)
  }
  if (observed?.state === 'failed' || observed?.state === 'cancelled') return unanswered(`${observed.state} before it printed a result`)
  if (observed?.state === 'done') return unanswered('finished without a result')
  if (input.now.getTime() - Date.parse(state.submittedAt) > input.timeoutMs) return unanswered(`printed no result within ${Math.round(input.timeoutMs / 60_000)} min`)
  return { status: 'waiting', detail: `waiting for fleet verify task ${state.task} on ${head.slice(0, 7)}`, proofs: [] }
}
