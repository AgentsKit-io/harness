import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { fail } from '../kernel/errors.js'
import { hashJson } from '../kernel/hash.js'
import { providerIdentity, renderHeadlessArgv, type LoopConfig } from './config.js'
import { classifyProviderFailure, untrusted, type ProviderFailure, type TaskContract } from './contract.js'
import { writeJsonAtomic } from './fs-atomic.js'
import type { RankedModel } from './routing.js'

export const PLAN_OPEN = '<<<LOOP_PLAN'
export const PLAN_CLOSE = 'LOOP_PLAN>>>'
export const VOTE_OPEN = '<<<LOOP_VOTE'
export const VOTE_CLOSE = 'LOOP_VOTE>>>'

const nonEmpty = z.string().trim().min(1)

export const TaskPlanSchema = z.object({
  summary: nonEmpty,
  /** Ordered work, each step naming what changes. A plan with no steps is not a plan. */
  steps: z.array(z.object({ id: nonEmpty, description: nonEmpty, files: z.array(z.string().trim()).default([]) })).min(1),
  /** Tests to write or extend, so "tested" is decided before the code exists, not after. */
  tests: z.array(nonEmpty).default([]),
  risks: z.array(nonEmpty).default([]),
})
export type TaskPlan = z.infer<typeof TaskPlanSchema>

export const PlanVoteSchema = z.object({
  vote: z.enum(['approve', 'reject']),
  /** A rejection must say what is concretely wrong. A vote without an objection is noise, not a review. */
  objections: z.array(nonEmpty).default([]),
})
export type PlanVote = z.infer<typeof PlanVoteSchema>

export interface CastVote extends PlanVote { readonly provider: string; readonly model: string }

export interface StoredPlan {
  readonly schemaVersion: 1
  readonly issue: string
  readonly generatedAt: string
  readonly provider: string
  readonly model: string
  readonly plan: TaskPlan
  readonly digest: string
  readonly contractDigest: string
  readonly cycles: number
  readonly votes: readonly CastVote[]
  readonly status: 'approved' | 'no-consensus'
  /** Objections still standing when the cycles ran out — what a human is being asked to settle. */
  readonly unresolved: readonly string[]
}

export const PLAN_SCHEMA_VERSION = 1 as const

export const planPath = (stateDir: string, issue: string): string => join(stateDir, 'issues', issue, 'plan.json')

export const readStoredPlan = (stateDir: string, issue: string): StoredPlan | null => {
  const path = planPath(stateDir, issue)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as StoredPlan } catch { return null }
}

export const writeStoredPlan = (stateDir: string, plan: StoredPlan): void => {
  const path = planPath(stateDir, plan.issue)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, plan)
}

const between = (text: string, open: string, close: string, label: string): string => {
  const start = text.lastIndexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end < 0 || end <= start) return fail(`Output contains no ${label} block.`, 'INVALID_INPUT')
  return text.slice(start + open.length, end).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

export const parsePlanOutput = (stdout: string): TaskPlan => {
  let parsed: unknown
  try { parsed = JSON.parse(between(stdout, PLAN_OPEN, PLAN_CLOSE, 'plan')) } catch (error) { return fail(`Plan block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_INPUT') }
  const result = TaskPlanSchema.safeParse(parsed)
  if (!result.success) return fail(`Plan block failed validation: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 'INVALID_INPUT')
  return result.data
}

export const parseVoteOutput = (stdout: string): PlanVote => {
  let parsed: unknown
  try { parsed = JSON.parse(between(stdout, VOTE_OPEN, VOTE_CLOSE, 'vote')) } catch (error) { return fail(`Vote block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_INPUT') }
  const result = PlanVoteSchema.safeParse(parsed)
  if (!result.success) return fail(`Vote block failed validation: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 'INVALID_INPUT')
  // A rejection with no objection cannot be answered, so it is not allowed to count as one.
  if (result.data.vote === 'reject' && !result.data.objections.length) return fail('A rejecting vote must list at least one concrete objection.', 'INVALID_INPUT')
  return result.data
}

const contractBlock = (contract: TaskContract): string => [
  `Intent: ${contract.intent}`,
  `In scope: ${contract.scope.inScope.join('; ')}`,
  contract.scope.outOfScope.length ? `Out of scope: ${contract.scope.outOfScope.join('; ')}` : '',
  `Outcomes to satisfy:\n${contract.outcomes.map((outcome) => `- ${outcome.id}: ${outcome.description} (check: ${outcome.check.kind}${outcome.check.command ? ` → ${outcome.check.command}` : ''})`).join('\n') || '- none declared'}`,
  contract.touchpoints.length ? `Likely touchpoints: ${contract.touchpoints.join(', ')}` : '',
  contract.risks.length ? `Risks: ${contract.risks.join('; ')}` : '',
].filter(Boolean).join('\n')

export const renderPlanPrompt = (input: { readonly issue: string; readonly config: LoopConfig; readonly contract: TaskContract; readonly objections?: readonly string[] }): string => `You are the planner for ${input.config.project.repo}, issue ${input.issue}. Write the technical plan a worker will implement. You are not writing code and you are not deciding whether to proceed — the machine does that.

## Frozen contract (the boundary; do not widen it)
${contractBlock(input.contract)}

Project verification: \`${input.config.delivery.verifyCommand}\`
${input.objections?.length ? `\n## Objections raised against your previous plan — address each one explicitly\n${input.objections.map((objection) => `- ${untrusted(`vote:${input.issue}`, objection)}`).join('\n')}\n` : ''}
Produce the plan as JSON between the exact markers ${PLAN_OPEN} and ${PLAN_CLOSE}, nothing else between them:
{
  "summary": "one sentence: the approach",
  "steps": [ { "id": "s1", "description": "what changes and why", "files": ["path/that/will/change"] } ],
  "tests": ["the test to write or extend, named by file and behaviour"],
  "risks": ["what could break, and how the plan contains it"]
}
Rules: every contract outcome must be reachable by the steps; new behaviour gets a test in \`tests\`; prefer the smallest change that satisfies the contract; never plan work outside the contract's scope.`

export const renderVotePrompt = (input: { readonly issue: string; readonly config: LoopConfig; readonly contract: TaskContract; readonly plan: TaskPlan }): string => `You are one of ${input.config.worker.plan.votes} reviewers voting on a technical plan for ${input.config.project.repo}, issue ${input.issue}. ${input.config.worker.plan.approvals} of ${input.config.worker.plan.votes} approvals let the work start.

## Frozen contract
${contractBlock(input.contract)}

## Proposed plan
${untrusted(`plan:${input.issue}`, JSON.stringify(input.plan, null, 2))}

Vote as JSON between the exact markers ${VOTE_OPEN} and ${VOTE_CLOSE}, nothing else between them:
{ "vote": "approve" | "reject", "objections": ["concrete, addressable problem"] }

Reject only for something a planner can act on: an outcome no step reaches, a step that leaves the contract's scope, a missing test for new behaviour, a risk with no containment, or a step whose files contradict the contract's touchpoints. Style preferences are not objections. A rejection without at least one concrete objection is discarded.`

interface HeadlessCall { readonly candidate: RankedModel; readonly prompt: string }

const callHeadless = async (input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly root: string; readonly timeoutMs: number; readonly call: HeadlessCall }): Promise<{ readonly stdout: string } | { readonly failure: ProviderFailure }> => {
  const { candidate } = input.call
  const { settings } = providerIdentity(input.config, candidate.provider)
  const argv = renderHeadlessArgv(settings, candidate.model, input.call.prompt, candidate.effort)
  if (!argv) return { failure: { provider: candidate.provider, model: candidate.model, kind: 'other', detail: `no headless argv template (models.providers.${candidate.provider}.headless)` } }
  const outcome = await input.runner.run(argv, { timeoutMs: input.timeoutMs, cwd: input.root })
  const detail = `${outcome.stderr.trim()}\n${outcome.stdout.trim()}`.trim().slice(0, 600)
  if (outcome.timedOut || outcome.code !== 0) return { failure: { provider: candidate.provider, model: candidate.model, kind: classifyProviderFailure(detail, outcome.timedOut), detail: outcome.timedOut ? `timed out after ${input.timeoutMs}ms` : `exited ${outcome.code ?? 'null'}: ${detail || 'no output'}` } }
  return { stdout: outcome.stdout }
}

/** Count the votes. Separated from the calls so the decision itself is a pure, testable function. */
export const tallyVotes = (votes: readonly CastVote[], approvals: number): { readonly approved: boolean; readonly objections: readonly string[] } => ({
  approved: votes.filter((vote) => vote.vote === 'approve').length >= approvals,
  objections: [...new Set(votes.filter((vote) => vote.vote === 'reject').flatMap((vote) => vote.objections))],
})

export interface PlanWithVotesInput {
  readonly runner: CommandRunner
  readonly config: LoopConfig
  readonly root: string
  readonly issue: string
  readonly contract: TaskContract
  readonly contractDigest: string
  /** Ranked candidates for the planner (strong model) and for the voters, in preference order. */
  readonly planner: readonly RankedModel[]
  readonly voters: readonly RankedModel[]
  readonly now?: () => Date
  readonly onProviderFailure?: (failure: ProviderFailure) => void
  readonly onCycle?: (cycle: number, votes: readonly CastVote[]) => void
  /** Ceiling for one planner call. Unset = `worker.plan.timeoutMs`; a flow may shorten it per role. */
  readonly plannerTimeoutMs?: number
  /** Ceiling for one vote call. Unset = `worker.plan.timeoutMs`. */
  readonly voteTimeoutMs?: number
  /**
   * False when the flow switched the `vote` phase off: the planner's first parseable plan stands, recorded with
   * zero votes so nothing downstream can mistake it for consensus.
   */
  readonly requireVotes?: boolean
}

/**
 * Planner → vote → replan, until consensus or the cycle ceiling.
 *
 * The model produces the plan and the votes; **the machine counts them and decides**. Running out of cycles is not
 * a failure to retry — three models disagreeing three times is an ambiguous requirement, which is a human's
 * problem, and the unresolved objections are exactly what that human is being asked to settle.
 */
export const runPlanWithVotes = async (input: PlanWithVotesInput): Promise<StoredPlan> => {
  const { plan: settings } = input.config.worker
  if (!input.planner.length) fail('No planner provider is available to plan this issue.', 'INVALID_STATE')
  const now = (input.now ?? (() => new Date()))()
  const failures: ProviderFailure[] = []
  let objections: readonly string[] = []
  let lastPlan: { readonly plan: TaskPlan; readonly candidate: RankedModel } | null = null
  let lastVotes: readonly CastVote[] = []

  for (let cycle = 1; cycle <= settings.maxCycles; cycle += 1) {
    let proposed: { readonly plan: TaskPlan; readonly candidate: RankedModel } | null = null
    for (const candidate of input.planner) {
      const result = await callHeadless({ runner: input.runner, config: input.config, root: input.root, timeoutMs: input.plannerTimeoutMs ?? settings.timeoutMs, call: { candidate, prompt: renderPlanPrompt({ issue: input.issue, config: input.config, contract: input.contract, objections }) } })
      if ('failure' in result) { failures.push(result.failure); if (result.failure.kind !== 'other') input.onProviderFailure?.(result.failure); continue }
      try { proposed = { plan: parsePlanOutput(result.stdout), candidate }; break } catch (error) { failures.push({ provider: candidate.provider, model: candidate.model, kind: 'output', detail: error instanceof Error ? error.message : String(error) }) }
    }
    if (!proposed) return fail(`Planning failed on every candidate: ${failures.map((failure) => `${failure.provider}/${failure.model} [${failure.kind}] ${failure.detail.split('\n')[0]}`).join(' | ')}`, 'HARNESS_ERROR')
    lastPlan = proposed

    // A flow may buy the plan without buying the jury. The plan then stands as written and is stored with an empty
    // vote list, so `renderPlanForBrief` and every reader downstream say "0/0 approved" instead of implying a
    // consensus that nobody was asked for.
    if (input.requireVotes === false) {
      input.onCycle?.(cycle, [])
      return {
        schemaVersion: PLAN_SCHEMA_VERSION, issue: input.issue, generatedAt: now.toISOString(),
        provider: proposed.candidate.provider, model: proposed.candidate.model, plan: proposed.plan,
        digest: hashJson(proposed.plan), contractDigest: input.contractDigest, cycles: cycle, votes: [], status: 'approved', unresolved: [],
      }
    }

    const votes: CastVote[] = []
    // One vote per distinct candidate where possible; with fewer candidates than votes the list wraps, and the
    // record says which model cast which vote, so "three votes" never silently means "one model, three times".
    for (let index = 0; index < settings.votes; index += 1) {
      const candidate = input.voters[index % Math.max(1, input.voters.length)]
      if (!candidate) break
      const result = await callHeadless({ runner: input.runner, config: input.config, root: input.root, timeoutMs: input.voteTimeoutMs ?? settings.timeoutMs, call: { candidate, prompt: renderVotePrompt({ issue: input.issue, config: input.config, contract: input.contract, plan: proposed.plan }) } })
      if ('failure' in result) { failures.push(result.failure); if (result.failure.kind !== 'other') input.onProviderFailure?.(result.failure); continue }
      try { votes.push({ ...parseVoteOutput(result.stdout), provider: candidate.provider, model: candidate.model }) } catch (error) { failures.push({ provider: candidate.provider, model: candidate.model, kind: 'output', detail: error instanceof Error ? error.message : String(error) }) }
    }
    lastVotes = votes
    input.onCycle?.(cycle, votes)
    const tally = tallyVotes(votes, settings.approvals)
    if (tally.approved) {
      return {
        schemaVersion: PLAN_SCHEMA_VERSION, issue: input.issue, generatedAt: now.toISOString(),
        provider: proposed.candidate.provider, model: proposed.candidate.model, plan: proposed.plan,
        digest: hashJson(proposed.plan), contractDigest: input.contractDigest, cycles: cycle, votes, status: 'approved', unresolved: [],
      }
    }
    objections = tally.objections
  }

  return {
    schemaVersion: PLAN_SCHEMA_VERSION, issue: input.issue, generatedAt: now.toISOString(),
    provider: lastPlan?.candidate.provider ?? 'unknown', model: lastPlan?.candidate.model ?? 'unknown',
    plan: lastPlan?.plan ?? { summary: 'no plan reached consensus', steps: [{ id: 's0', description: 'none', files: [] }], tests: [], risks: [] },
    digest: lastPlan ? hashJson(lastPlan.plan) : '', contractDigest: input.contractDigest,
    cycles: settings.maxCycles, votes: lastVotes, status: 'no-consensus', unresolved: objections,
  }
}

/** The approved plan as the worker sees it in its brief. */
export const renderPlanForBrief = (stored: StoredPlan | null): string => {
  if (!stored || stored.status !== 'approved') return ''
  const steps = stored.plan.steps.map((step) => `- ${step.id}: ${step.description}${step.files.length ? ` — files: ${step.files.join(', ')}` : ''}`).join('\n')
  return `
## Approved plan (${stored.votes.filter((vote) => vote.vote === 'approve').length}/${stored.votes.length} agents approved, ${stored.cycles} cycle(s), digest ${stored.digest.slice(0, 12)})
${stored.plan.summary}

${steps}
${stored.plan.tests.length ? `\nTests to write or extend:\n${stored.plan.tests.map((test) => `- ${test}`).join('\n')}\n` : ''}${stored.plan.risks.length ? `Risks the plan accepts: ${stored.plan.risks.join('; ')}\n` : ''}
This plan was reviewed and approved before you started. Follow it; if it turns out to be wrong, say so in the PR body and explain what you did instead — do not silently replace it.
`
}
