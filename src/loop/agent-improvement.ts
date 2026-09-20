import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CommandRunner } from '../adapters/command.js'
import { hashJson } from '../kernel/hash.js'
import { loadAgentRegistry, resolveAgentForRole, type AgentRegistry } from './agent-registry.js'
import type { LoadedLoopConfig, LoopConfig } from './config.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { readLoopEvents } from './retro.js'

/** Roles whose instructions a machine may not change on its own, whatever the evidence. */
export const CRITICAL_ROLES: readonly string[] = ['architect', 'reviewer']

export interface RoleSignal {
  readonly role: string
  /** Outcomes the loop can attribute to this role, in the window. */
  readonly reviewFindings: number
  readonly fixRounds: number
  readonly escalations: number
  readonly contraryVotes: number
  readonly runs: number
  /** Bad outcomes per run — the number that says whether a role is worth improving. */
  readonly ratio: number
}

const EVENTS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  reviewer: ['pr.reviewed'],
  builder: ['worker.ci-round', 'worker.review-round', 'worker.dispatch-failed'],
  planner: ['plan.voted', 'plan.escalated'],
  orchestrator: ['contract.escalated', 'contract.failed'],
}

/**
 * Correlate outcomes with the role that produced them.
 *
 * Only events the loop already writes are used: no new telemetry, and nothing inferred from a model's own
 * account of itself. A role with no runs in the window has no signal — not a perfect score.
 */
export const roleSignals = (stateDir: string, sinceMs: number): readonly RoleSignal[] => {
  const events = readLoopEvents(stateDir, sinceMs).filter((event) => Date.parse(event.at) >= sinceMs)
  return Object.entries(EVENTS_BY_ROLE).map(([role, types]) => {
    const mine = events.filter((event) => types.includes(event.type))
    const reviewFindings = mine.filter((event) => event.type === 'pr.reviewed' && event['status'] === 'findings').length
    const fixRounds = mine.filter((event) => event.type.endsWith('-round')).length
    const escalations = mine.filter((event) => event.type.endsWith('.escalated') || event.type.endsWith('.failed')).length
    const contraryVotes = mine.filter((event) => event.type === 'plan.voted').reduce((total, event) => {
      const votes = typeof event['votes'] === 'number' ? event['votes'] : 0
      const approvals = typeof event['approvals'] === 'number' ? event['approvals'] : votes
      return total + Math.max(0, votes - approvals)
    }, 0)
    const bad = reviewFindings + fixRounds + escalations + contraryVotes
    return { role, reviewFindings, fixRounds, escalations, contraryVotes, runs: mine.length, ratio: mine.length ? bad / mine.length : 0 }
  }).filter((signal) => signal.runs > 0).sort((left, right) => right.ratio - left.ratio)
}

export interface AgentProposal {
  readonly role: string
  readonly agentId: string
  readonly path: string
  readonly instructionsFile: string
  readonly before: string
  readonly after: string
  readonly addedLines: number
  readonly reason: string
  readonly digest: string
}

export interface ImprovementRecord {
  readonly role: string
  readonly agentId: string
  readonly at: string
  readonly digest: string
  readonly status: 'adopted' | 'rejected' | 'needs-human' | 'reverted'
  readonly detail: string
  readonly evidence: Readonly<Record<string, unknown>>
}

export interface ImprovementState { readonly history: readonly ImprovementRecord[] }

export const improvementStatePath = (stateDir: string): string => join(stateDir, 'agent-improvements.json')

export const readImprovementState = (stateDir: string): ImprovementState => {
  try { return { history: (JSON.parse(readFileSync(improvementStatePath(stateDir), 'utf8')) as ImprovementState).history ?? [] } } catch { return { history: [] } }
}

/** Build the proposal: the agent's current instructions plus one dated note naming what the evidence showed. */
export const proposeAgentChange = (input: {
  readonly loaded: LoadedLoopConfig
  readonly registry: AgentRegistry
  readonly signal: RoleSignal
  readonly note: string
  readonly now: Date
}): AgentProposal | null => {
  let resolved
  try { resolved = resolveAgentForRole(input.registry, input.signal.role) } catch { return null }
  const path = resolved.entry.path
  if (!path) return null
  const instructionsFile = resolve(input.loaded.root, path, resolved.entry.instructions)
  const before = existsSync(instructionsFile) ? readFileSync(instructionsFile, 'utf8') : ''
  const note = `\n<!-- loop-auto ${input.now.toISOString().slice(0, 10)} -->\n- ${input.note}\n`
  const after = `${before.trimEnd()}\n${note}`
  return {
    role: input.signal.role, agentId: resolved.agentId, path, instructionsFile, before, after,
    addedLines: note.trim().split('\n').length,
    reason: `${input.signal.role}: ${input.signal.ratio.toFixed(2)} bad outcome(s) per run over ${input.signal.runs} run(s)`,
    digest: hashJson({ after }).slice(0, 12),
  }
}

export interface EvalGate { readonly ran: boolean; readonly passed: boolean; readonly detail: string }

/**
 * Run the project's agent eval and decide whether the change may be adopted.
 *
 * "Not worse" is the bar, not "better": an instruction change that leaves the score alone but makes the agent
 * cheaper or clearer is still worth keeping, and a change that cannot be measured is never adopted.
 */
export const runEvalGate = async (input: { readonly config: LoopConfig; readonly runner: CommandRunner; readonly cwd: string }): Promise<EvalGate> => {
  const argv = input.config.agents.evalCommand
  if (!argv.length) return { ran: false, passed: false, detail: 'no agents.evalCommand declared; a change that cannot be measured is not adopted' }
  try {
    const result = await input.runner.run(argv, { timeoutMs: input.config.agents.evalTimeoutSec * 1000, cwd: input.cwd })
    return result.code === 0
      ? { ran: true, passed: true, detail: `${argv[0]} exited 0` }
      : { ran: true, passed: false, detail: `${argv[0]} exited ${result.code ?? 'null'}: ${(result.stderr || result.stdout).trim().slice(0, 200)}` }
  } catch (error) { return { ran: true, passed: false, detail: error instanceof Error ? error.message : String(error) } }
}

export interface ImprovementOutcome { readonly status: ImprovementRecord['status']; readonly proposal: AgentProposal | null; readonly detail: string; readonly gate: EvalGate | null }

/**
 * Propose one improvement, measure it, and keep it only if the eval still passes.
 *
 * Three things a machine never does here: touch a critical role's instructions (`architect`, `reviewer`), write
 * more than `agents.maxAutoLines` lines, or publish anything back to the registry. All three are a human's.
 */
export const improveAgent = async (input: {
  readonly loaded: LoadedLoopConfig
  readonly runner: CommandRunner
  readonly signal: RoleSignal
  readonly note: string
  readonly now?: () => Date
  readonly dryRun?: boolean
}): Promise<ImprovementOutcome> => {
  const { loaded } = input
  const now = (input.now ?? (() => new Date()))()
  const registryPath = resolve(loaded.root, loaded.config.agents.registryPath)
  if (!existsSync(registryPath)) return { status: 'rejected', proposal: null, detail: 'no agents.registry.yaml', gate: null }
  const registry = loadAgentRegistry(registryPath)
  const proposal = proposeAgentChange({ loaded, registry, signal: input.signal, note: input.note, now })
  if (!proposal) return { status: 'rejected', proposal: null, detail: `no installed agent for role ${input.signal.role}`, gate: null }

  const record = (status: ImprovementRecord['status'], detail: string, gate: EvalGate | null): ImprovementOutcome => {
    if (!input.dryRun) {
      const state = readImprovementState(loaded.stateDir)
      mkdirSync(dirname(improvementStatePath(loaded.stateDir)), { recursive: true })
      writeJsonAtomic(improvementStatePath(loaded.stateDir), { history: [...state.history, { role: proposal.role, agentId: proposal.agentId, at: now.toISOString(), digest: proposal.digest, status, detail, evidence: { ...input.signal, note: input.note } }] })
    }
    return { status, proposal, detail, gate }
  }

  if (CRITICAL_ROLES.includes(proposal.role)) return record('needs-human', `${proposal.role} is a critical role; the proposal is recorded for a human to apply`, null)
  if (proposal.addedLines > loaded.config.agents.maxAutoLines) return record('needs-human', `the change is ${proposal.addedLines} lines, over agents.maxAutoLines (${loaded.config.agents.maxAutoLines})`, null)
  if (input.dryRun) return record('needs-human', 'dry-run: nothing written', null)

  writeFileSync(proposal.instructionsFile, proposal.after, 'utf8')
  const gate = await runEvalGate({ config: loaded.config, runner: input.runner, cwd: loaded.root })
  if (!gate.passed) {
    // Put it back exactly as it was. An agent left half-improved is worse than one never touched.
    writeFileSync(proposal.instructionsFile, proposal.before, 'utf8')
    return record('reverted', `eval did not pass, change reverted: ${gate.detail}`, gate)
  }
  return record('adopted', `eval passed (${gate.detail})`, gate)
}
