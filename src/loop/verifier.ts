import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile } from '../kernel/json-file.js'
import type { LoadedLoopConfig, LoopConfig } from './config.js'
import type { TaskContract } from './contract.js'
import type { DodProof } from './dod.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { RunnerConnector } from './runner-connector.js'

/**
 * The independent verifier (ADR-0046). The "proven" verdict for a PR comes from a run that did not write the code:
 * a separate workspace on the selected runner checks out the PR head, runs the project's commands and the contract
 * outcomes, and prints one verdict line with evidence per item. The writer's own handoff files and green CI are
 * inputs a human may read; they are never the verdict.
 */

const VERDICT_MARKER = 'LOOP-VERDICT:'

const VerdictSchema = z.object({
  verdict: z.enum(['proven', 'failed']),
  head: z.string().min(7),
  nonce: z.string().min(8),
  items: z.array(z.object({ id: z.string().min(1), status: z.enum(['passed', 'failed']), evidence: z.string() })),
})
export type VerifierVerdict = z.infer<typeof VerdictSchema>

const StateSchema = z.object({
  head: z.string(),
  nonce: z.string(),
  workspaceId: z.string(),
  terminal: z.string(),
  submittedAt: z.string(),
  /** Set once judged: the same head is never verified twice. */
  result: z.object({ status: z.enum(['proven', 'failed']), detail: z.string(), proofs: z.array(z.object({ id: z.string(), status: z.enum(['passed', 'failed']), evidence: z.string() })) }).optional(),
})
type VerifierState = z.infer<typeof StateSchema>

export const verifierStatePath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'verifier.json')

/** One thing the verifier must answer for, by id. */
export interface VerifierItem { readonly id: string; readonly what: string }

/** The starting verifier for a project, read from its stack: only commands the checkout actually defines. */
export const generateVerifierCommands = (root: string): readonly (readonly string[])[] => {
  const has = (file: string): boolean => existsSync(join(root, file))
  const out: (readonly string[])[] = []
  if (has('package.json')) {
    let scripts: Record<string, unknown> = {}
    try { scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {} } catch { /* unreadable package.json: no scripts */ }
    const run = has('pnpm-lock.yaml') ? ['pnpm', 'run'] : has('yarn.lock') ? ['yarn', 'run'] : has('bun.lock') || has('bun.lockb') ? ['bun', 'run'] : ['npm', 'run']
    for (const script of ['lint', 'typecheck', 'build', 'test']) if (typeof scripts[script] === 'string') out.push([...run, script])
  }
  if (has('pyproject.toml') || has('pytest.ini')) out.push(['python', '-m', 'pytest'])
  if (has('Cargo.toml')) out.push(['cargo', 'test'])
  if (has('go.mod')) out.push(['go', 'test', './...'])
  return out
}

/** What the verifier is asked to prove, with stable ids: the commands, the live checks, the project's command DoD items and the contract outcomes. */
export const verifierItems = (config: LoopConfig, root: string, contract: TaskContract | null): readonly VerifierItem[] => {
  const commands = config.verifier.commands.length ? config.verifier.commands : generateVerifierCommands(root)
  return [
    ...commands.map((argv, index): VerifierItem => ({ id: `cmd-${index + 1}`, what: `run \`${argv.join(' ')}\` (exit 0)` })),
    ...config.verifier.liveChecks.map((check, index): VerifierItem => ({ id: `live-${index + 1}`, what: `live check: ${check}` })),
    ...config.dod.items.filter((item) => item.kind === 'command' && item.command?.length).map((item): VerifierItem => ({ id: item.id, what: `${item.description} — run \`${(item.command ?? []).join(' ')}\` (exit 0)` })),
    ...(contract?.outcomes ?? []).map((outcome): VerifierItem => ({ id: outcome.id, what: `${outcome.description}${outcome.check.command ? ` — run \`${outcome.check.command}\`` : ` — check: ${outcome.check.kind}`}` })),
  ]
}

export const renderVerifierBrief = (input: { readonly issue: string; readonly pr: number; readonly head: string; readonly nonce: string; readonly items: readonly VerifierItem[] }): string => `# Independent verification — ${input.issue}, PR #${input.pr}

You are the verifier. You did **not** write this change and you must not change it: never edit, commit or push code. Your only output is a verdict.

1. Check out exactly commit \`${input.head}\` (fetch \`refs/pull/${input.pr}/head\` if it is not local) and install its dependencies from the lockfile.
2. Do not trust the PR description, the writer's \`.ak-loop/*.json\` files or the CI badge. Run each item below yourself and capture what you saw.
3. Items (the id is how the loop matches your answer):
${input.items.map((item) => `   - \`${item.id}\`: ${item.what}`).join('\n')}
4. An item passes only when you saw it pass. If you could not run it, it failed — say why in the evidence.

Finish by printing one line starting with \`${VERDICT_MARKER}\` followed by a single-line JSON object with the keys \`verdict\` ("proven" only if every item passed, otherwise "failed"), \`head\` (the full commit sha you checked out), \`nonce\` (exactly \`${input.nonce}\`) and \`items\` (an array of objects with \`id\`, \`status\` ("passed" or "failed") and \`evidence\` — the output or observation that shows it). Nothing after that line.
`

/** The last verdict line in the verifier's output that parses; an echo of the brief's own wording does not. */
export const parseVerdict = (screen: string): VerifierVerdict | null => {
  for (const line of screen.split(/\r?\n/).reverse()) {
    const at = line.indexOf(VERDICT_MARKER)
    if (at < 0) continue
    try {
      const parsed = VerdictSchema.safeParse(JSON.parse(line.slice(at + VERDICT_MARKER.length).trim()))
      if (parsed.success) return parsed.data
    } catch { /* not JSON: the brief's own description of the line, or noise */ }
  }
  return null
}

export interface VerifierJudgement { readonly status: 'proven' | 'failed'; readonly detail: string; readonly proofs: readonly DodProof[] }

/** Fail closed: proven needs this head, this submission, every asked item passed with evidence, and a `proven` verdict. */
export const judgeVerdict = (input: { readonly verdict: VerifierVerdict; readonly head: string; readonly nonce: string; readonly items: readonly VerifierItem[] }): VerifierJudgement => {
  const { verdict, head, items } = input
  const proofs: DodProof[] = verdict.items.map((item) => ({ id: item.id, status: item.status, evidence: item.evidence }))
  const reasons: string[] = []
  if (verdict.nonce !== input.nonce) reasons.push('verdict is for a different submission')
  if (!head.startsWith(verdict.head) && !verdict.head.startsWith(head)) reasons.push(`verdict is for ${verdict.head.slice(0, 12)}, not ${head.slice(0, 12)}`)
  for (const item of items) {
    const answer = verdict.items.find((candidate) => candidate.id === item.id)
    if (!answer) reasons.push(`no answer for ${item.id}`)
    else if (answer.status !== 'passed') reasons.push(`${item.id} failed: ${answer.evidence.slice(0, 160) || 'no evidence'}`)
    else if (!answer.evidence.trim()) reasons.push(`${item.id} passed without evidence`)
  }
  if (!items.length) reasons.push('nothing was asked of the verifier (no commands for this stack, no live checks, no outcomes)')
  if (verdict.verdict !== 'proven') reasons.push('the verifier did not call it proven')
  return reasons.length ? { status: 'failed', detail: reasons.join('; '), proofs } : { status: 'proven', detail: `${items.length} item(s) passed in an independent run`, proofs }
}

export interface VerifierResult {
  /** `unavailable`: no verdict can be had (no way to launch, the verifier died) — a person decides; never read as proven. */
  readonly status: 'proven' | 'failed' | 'waiting' | 'unavailable'
  readonly detail: string
  readonly proofs: readonly DodProof[]
}

const slug = (value: string): string => value.replaceAll(/[^A-Za-z0-9_-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40) || 'issue'

export interface VerifyInput {
  readonly loaded: LoadedLoopConfig
  readonly connector: RunnerConnector
  readonly issue: string
  readonly pr: number
  readonly head: string
  readonly contract: TaskContract | null
  readonly now: Date
  readonly dryRun: boolean
}

/**
 * One step of the verification of a PR head; deliver calls it every pass until it stops saying `waiting`. Submitting
 * and reading the answer are separate passes because a verifier is a run, not a function call. A new head is a new
 * verification: the old one's workspace is removed and its verdict is not reused.
 */
export const verifyIndependently = async (input: VerifyInput): Promise<VerifierResult> => {
  const { loaded, connector, issue, head } = input
  const { config } = loaded
  const path = verifierStatePath(loaded.stateDir, issue)
  const state = readJsonFile(path, StateSchema)
  const remove = async (id: string): Promise<void> => { try { await connector.removeWorkspace({ id, force: true }) } catch { /* the verdict stands; a leftover workspace is housekeeping */ } }
  const items = verifierItems(config, loaded.root, input.contract)

  if (state?.head === head && state.result) return { ...state.result, proofs: state.result.proofs }
  if (input.dryRun) return { status: 'waiting', detail: `would submit a verifier run for ${head.slice(0, 7)} (${items.length} item(s))`, proofs: [] }

  if (!state || state.head !== head) {
    if (state && !state.result) await remove(state.workspaceId)
    if (connector.id !== 'fleet' && !config.verifier.agentCommand) return { status: 'unavailable', detail: `verifier.enabled with runner "${connector.id}" needs verifier.agentCommand to launch the verifier`, proofs: [] }
    const nonce = randomUUID()
    const name = `verify-${slug(issue)}-${head.slice(0, 7)}`
    const workspace = await connector.createWorkspace({ name, branch: `verify/${slug(issue)}-${head.slice(0, 7)}`, baseBranch: config.project.baseBranch })
    const terminal = await connector.launchAgent({ workspace, command: config.verifier.agentCommand ?? '', title: 'verifier' })
    const sent = await connector.send({ terminal, text: renderVerifierBrief({ issue, pr: input.pr, head, nonce, items }) })
    if (!sent.delivered) { await remove(workspace.id); return { status: 'unavailable', detail: `the verifier brief was not delivered: ${sent.detail}`, proofs: [] } }
    mkdirSync(join(loaded.stateDir, 'issues', issue), { recursive: true })
    writeJsonAtomic(path, { head, nonce, workspaceId: workspace.id, terminal, submittedAt: input.now.toISOString() } satisfies VerifierState)
    return { status: 'waiting', detail: `verifier submitted for ${head.slice(0, 7)} (${sent.detail})`, proofs: [] }
  }

  const finish = async (result: VerifierJudgement): Promise<VerifierResult> => {
    writeJsonAtomic(path, { ...state, result: { ...result, proofs: [...result.proofs] } } satisfies VerifierState)
    await remove(state.workspaceId)
    return result
  }
  const observed = (await connector.observeWorkspaces()).find((item) => item.id === state.workspaceId)
  if (observed?.state === 'failed' || observed?.state === 'cancelled') { await remove(state.workspaceId); return { status: 'unavailable', detail: `the verifier run ${observed.state} before it returned a verdict`, proofs: [] } }
  const verdict = parseVerdict(await connector.readScreen({ terminal: state.terminal, lines: 400 }))
  if (verdict) return finish(judgeVerdict({ verdict, head, nonce: state.nonce, items }))
  const ageMs = input.now.getTime() - Date.parse(state.submittedAt)
  if (observed?.state === 'done') return finish({ status: 'failed', detail: 'the verifier run finished without a verdict', proofs: [] })
  if (ageMs > config.verifier.budget.timeoutMs) return finish({ status: 'failed', detail: `no verdict within the ${Math.round(config.verifier.budget.timeoutMs / 60_000)} min verifier budget`, proofs: [] })
  return { status: 'waiting', detail: `waiting for the verifier of ${head.slice(0, 7)}`, proofs: [] }
}

export const renderVerifierMarkdown = (head: string, result: Pick<VerifierResult, 'status' | 'detail' | 'proofs'>): string => [
  `## Independent verification — ${result.status === 'proven' ? '✅ proven' : '❌ not proven'}`,
  '',
  `_A separate run that did not write this code checked out \`${head.slice(0, 12)}\`: ${result.detail}_`,
  '',
  ...(result.proofs.length ? ['| | item | evidence |', '|---|---|---|', ...result.proofs.map((proof) => `| ${proof.status === 'passed' ? '✅' : '❌'} | \`${proof.id}\` | ${proof.evidence.replaceAll('\n', ' ').replaceAll('|', '\\|').slice(0, 200)} |`)] : []),
].join('\n')
