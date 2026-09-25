import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { CommandRunner } from '../adapters/command.js'
import { fail } from '../kernel/errors.js'
import { extractOutputBlock } from './output-block.js'
import { hashJson } from '../kernel/hash.js'
import { providerIdentity, renderHeadlessArgv, type LoadedLoopConfig, type LoopConfig } from './config.js'
import { classifyProviderFailure, untrusted, type ProviderFailure } from './contract.js'
import { writeJsonAtomic } from './fs-atomic.js'
import { designExcerptFor } from './documents.js'
import { renderLayersForPrompt } from './layers.js'
import { tallyVotes, type CastVote } from './plan-vote.js'
import type { RankedModel } from './routing.js'
import { readJsonFile } from '../kernel/json-file.js'
import { requireWritableTracker, resolveConnectors } from './connectors.js'

export const PRD_OPEN = '<<<LOOP_PRD'
export const PRD_CLOSE = 'LOOP_PRD>>>'
export const QUESTION_OPEN = '<<<LOOP_QUESTION'
export const QUESTION_CLOSE = 'LOOP_QUESTION>>>'
export const DESIGN_OPEN = '<<<LOOP_DESIGN'
export const DESIGN_CLOSE = 'LOOP_DESIGN>>>'
export const ISSUES_OPEN = '<<<LOOP_ISSUES'
export const ISSUES_CLOSE = 'LOOP_ISSUES>>>'

const nonEmpty = z.string().trim().min(1)

/**
 * The PRD's required fields. "No gap left" is exactly this: every field below filled and no open question —
 * not "the model feels it is done". A profile may demand more, never less.
 */
export const PrdSchema = z.object({
  objective: nonEmpty,
  users: z.array(nonEmpty).min(1),
  inScope: z.array(nonEmpty).min(1),
  outOfScope: z.array(nonEmpty).default([]),
  nonGoals: z.array(nonEmpty).default([]),
  constraints: z.array(nonEmpty).default([]),
  successCriteria: z.array(nonEmpty).min(1),
  risks: z.array(nonEmpty).default([]),
})
export type Prd = z.infer<typeof PrdSchema>

export const REQUIRED_PRD_FIELDS = ['objective', 'users', 'inScope', 'successCriteria'] as const

export const DesignSchema = z.object({
  summary: nonEmpty,
  modules: z.array(z.object({ name: nonEmpty, responsibility: nonEmpty, boundary: z.string().trim().default('') })).min(1),
  contracts: z.array(z.object({ name: nonEmpty, shape: nonEmpty })).default([]),
  decisions: z.array(z.object({ id: nonEmpty, decision: nonEmpty, because: nonEmpty })).default([]),
  sequence: z.array(nonEmpty).default([]),
  risks: z.array(nonEmpty).default([]),
})
export type Design = z.infer<typeof DesignSchema>

export const PlannedIssueSchema = z.object({
  title: nonEmpty,
  description: nonEmpty,
  /** The layer label this issue belongs to, from `layers` in the project config. */
  layer: z.string().trim().default(''),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  /** How a machine will know this issue is done — the seed of the contract's outcomes. */
  acceptance: z.array(nonEmpty).min(1),
  /** Which part of the design this issue implements. A ticket that points at nothing invents its own architecture. */
  designRef: nonEmpty,
  /**
   * Where the work happens when it is not a pull request to this repository (another repository, a deploy, an
   * external service); empty when it is. Such an issue is filed outside the queue's reach (`linear.outsideLabel`).
   */
  outside: z.string().trim().default(''),
})
export type PlannedIssue = z.infer<typeof PlannedIssueSchema>

/**
 * A list the interviewer reports while the PRD is still being filled. Two shapes a model produces for "one item"
 * or "nothing yet" are read for what they mean instead of failing the round: a bare string is a one-item list, and
 * an empty list (or blank string) is a gap, which `prdGaps` — not the parser — decides about. Observed with
 * `glm-5.3`, which answered `"users": "..."` and `"successCriteria": []` and lost the whole round to the schema.
 */
const interviewList = z.preprocess((value) => {
  if (typeof value === 'string') return value.trim() ? [value] : undefined
  if (Array.isArray(value)) { const items = value.filter((item) => !(typeof item === 'string' && !item.trim())); return items.length ? items : undefined }
  return value
}, z.array(nonEmpty).min(1).optional())

/** The PRD as the interview reports it: every field optional, lists tolerant of the shapes above. */
const InterviewPrdSchema = z.object({
  objective: z.preprocess((value) => typeof value === 'string' && !value.trim() ? undefined : value, nonEmpty.optional()),
  users: interviewList, inScope: interviewList, outOfScope: interviewList, nonGoals: interviewList,
  constraints: interviewList, successCriteria: interviewList, risks: interviewList,
})

export const QuestionSchema = z.object({
  /** Empty when the interviewer has no gap left to close. */
  question: z.string().trim().default(''),
  field: z.string().trim().default(''),
  options: z.array(nonEmpty).default([]),
  recommendation: z.string().trim().default(''),
  complete: z.boolean().default(false),
  prd: InterviewPrdSchema.default({}),
})
export type InterviewQuestion = z.infer<typeof QuestionSchema>

export type PlanPhase = 'interview' | 'review' | 'architect' | 'decompose' | 'done'

export interface PlanRound { readonly at: string; readonly question: string; readonly answer: string; readonly field: string }

export interface PlanStageState {
  readonly schemaVersion: 1
  readonly id: string
  readonly objective: string
  readonly phase: PlanPhase
  readonly prd: Partial<Prd>
  readonly rounds: readonly PlanRound[]
  readonly pending: InterviewQuestion | null
  readonly design: Design | null
  readonly designVotes: readonly CastVote[]
  readonly designCycles: number
  readonly issues: readonly (PlannedIssue & { readonly identifier?: string; readonly url?: string })[]
  readonly approvals: { readonly plan: string | null; readonly design: string | null }
  /** Objections a human chose to carry past the design gate; decompose must resolve each one inside an issue. */
  readonly acceptedObjections?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export const PLAN_STAGE_SCHEMA_VERSION = 1 as const

export const planStateDir = (stateDir: string, id: string): string => join(stateDir, 'plans', id)
export const planStatePath = (stateDir: string, id: string): string => join(planStateDir(stateDir, id), 'state.json')

export const readPlanState = (stateDir: string, id: string): PlanStageState | null => {
  const path = planStatePath(stateDir, id)
  if (!existsSync(path)) return null
  return readJsonFile(path, z.object({ id: z.string().min(1), phase: z.string().min(1) }).loose()) as PlanStageState | null
}

export const writePlanState = (stateDir: string, state: PlanStageState): void => {
  const path = planStatePath(stateDir, state.id)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, state)
}

export const listPlans = (stateDir: string): readonly PlanStageState[] => {
  const root = join(stateDir, 'plans')
  if (!existsSync(root)) return []
  try { return readdirSync(root).map((id) => readPlanState(stateDir, id)).filter((state): state is PlanStageState => state !== null).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) } catch { return [] }
}

export const planId = (objective: string, now: Date): string => `${now.toISOString().slice(0, 10)}-${hashJson({ objective, day: now.toISOString().slice(0, 10) }).slice(0, 8)}`

export const startPlan = (objective: string, now: Date): PlanStageState => ({
  schemaVersion: PLAN_STAGE_SCHEMA_VERSION,
  id: planId(objective, now), objective, phase: 'interview', prd: {}, rounds: [], pending: null,
  design: null, designVotes: [], designCycles: 0, issues: [], approvals: { plan: null, design: null },
  createdAt: now.toISOString(), updatedAt: now.toISOString(),
})

/** Required PRD fields still empty. This list — not the model's opinion — is what ends the interview. */
export const prdGaps = (prd: Partial<Prd>): readonly string[] => REQUIRED_PRD_FIELDS.filter((field) => {
  const value = prd[field]
  return Array.isArray(value) ? value.length === 0 : !value
})

const between = (text: string, open: string, close: string, label: string): string =>
  extractOutputBlock(text, open, close) ?? fail(`Output contains no ${label} block.`, 'INVALID_INPUT')

const parseBlock = <T>(stdout: string, open: string, close: string, label: string, schema: z.ZodType<T>): T => {
  let parsed: unknown
  try { parsed = JSON.parse(between(stdout, open, close, label)) } catch (error) { return fail(`${label} block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_INPUT') }
  const result = schema.safeParse(parsed)
  if (!result.success) return fail(`${label} block failed validation: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`, 'INVALID_INPUT')
  return result.data
}

export const parseQuestionOutput = (stdout: string): InterviewQuestion => parseBlock(stdout, QUESTION_OPEN, QUESTION_CLOSE, 'question', QuestionSchema)
export const parseDesignOutput = (stdout: string): Design => parseBlock(stdout, DESIGN_OPEN, DESIGN_CLOSE, 'design', DesignSchema)
export const parseIssuesOutput = (stdout: string): readonly PlannedIssue[] => parseBlock(stdout, ISSUES_OPEN, ISSUES_CLOSE, 'issues', z.array(PlannedIssueSchema).min(1))

const prdSoFar = (state: PlanStageState): string => `Objective as stated by the human: ${untrusted(`plan:${state.id}`, state.objective)}\n\nPRD so far:\n${JSON.stringify(state.prd, null, 2)}\n\nAnswers so far:\n${state.rounds.map((round) => `- Q: ${round.question}\n  A: ${untrusted(`plan:${state.id}`, round.answer)}`).join('\n') || '- none yet'}`

export const renderInterviewPrompt = (state: PlanStageState, config: LoopConfig): string => `You are interviewing a human to complete a PRD for ${config.project.repo}. **One question per round**, always with concrete alternatives and your recommendation. Never ask two things at once, never ask what the answers already say.

${prdSoFar(state)}

Required fields, all of which must end up filled: objective, users, inScope, successCriteria. Also fill outOfScope, nonGoals, constraints and risks whenever the answers support it.

Answer as JSON between the exact markers ${QUESTION_OPEN} and ${QUESTION_CLOSE}:
{
  "prd": { "...": "the PRD updated with everything the answers so far establish" },
  "question": "the single next question, or \\"\\" when nothing is left to ask",
  "field": "the PRD field this question fills",
  "options": ["two to four concrete alternatives"],
  "recommendation": "which option you recommend and in one sentence why",
  "complete": false
}
Set "complete": true only when every required field is filled and you have no open question left.`

export const renderArchitectPrompt = (state: PlanStageState, config: LoopConfig, objections: readonly string[] = []): string => `You are the architect for ${config.project.repo}. Produce the technical design for the whole PRD below — module boundaries, contracts, the decisions worth recording, the sequence, and the risks. You are not writing code and not deciding whether to proceed.

Approved PRD:
${JSON.stringify(state.prd, null, 2)}
${objections.length ? `\nObjections raised against your previous design — address each one explicitly:\n${objections.map((objection) => `- ${untrusted(`design:${state.id}`, objection)}`).join('\n')}\n` : ''}
Answer as JSON between the exact markers ${DESIGN_OPEN} and ${DESIGN_CLOSE}:
{
  "summary": "one paragraph: the shape of the solution",
  "modules": [ { "name": "…", "responsibility": "…", "boundary": "what it must never do" } ],
  "contracts": [ { "name": "…", "shape": "the schema or signature, precisely" } ],
  "decisions": [ { "id": "d1", "decision": "…", "because": "the tradeoff it settles" } ],
  "sequence": ["the order the work must happen in, and why"],
  "risks": ["…"]
}`

export const renderDesignVotePrompt = (state: PlanStageState, config: LoopConfig, design: Design): string => `You are one of ${config.worker.plan.votes} reviewers voting on a technical design for ${config.project.repo}. ${config.worker.plan.approvals} approvals let the decomposition start.

PRD:
${JSON.stringify(state.prd, null, 2)}

Proposed design:
${untrusted(`design:${state.id}`, JSON.stringify(design, null, 2))}

Vote as JSON between the exact markers <<<LOOP_VOTE and LOOP_VOTE>>>:
{ "vote": "approve" | "reject", "objections": ["concrete, addressable problem"] }

Reject only for something an architect can act on: a PRD success criterion no module serves, a boundary that contradicts another, a contract that cannot be implemented as written, a decision with no tradeoff, a sequence that depends on work it precedes. A rejection without a concrete objection is discarded.`

export const renderDecomposePrompt = (state: PlanStageState, config: LoopConfig): string => `You are decomposing an approved design into issues for ${config.project.repo}.

PRD:
${JSON.stringify(state.prd, null, 2)}

Approved design:
${JSON.stringify(state.design, null, 2)}
${state.acceptedObjections?.length ? `\nObjections the human carried past the design gate — each one must be settled as an explicit decision inside the issue it affects (in its description), never left for the worker to guess:\n${state.acceptedObjections.map((objection) => `- ${objection}`).join('\n')}\n` : ''}${renderLayersForPrompt(config)}
Answer as JSON between the exact markers ${ISSUES_OPEN} and ${ISSUES_CLOSE}: an array of issues, each one
{ "title": "…", "description": "what to do and why, referencing the design", "layer": "${layerChoices(config).length ? `<one of: ${layerChoices(config).join(', ')}>` : ''}", "priority": "urgent|high|medium|low", "acceptance": ["verifiable criterion a machine can check"], "designRef": "the module, contract or decision id this issue implements", "outside": "" }

Every issue is delivered by an agent opening a pull request to ${config.project.repo} — nothing else. Work that cannot be done that way (a change in another repository, a deploy, a setting in an external service) still gets an issue, with "outside" naming where it happens (e.g. "repository owner/other", "production deploy"); leave "outside" empty for everything that is a pull request here. Never split one PR here into an "outside" issue to avoid it.

Rules: every issue points at a part of the design — a ticket that points at nothing invents its own architecture. Every acceptance criterion must be checkable without a human's judgement. Order matters: follow the design's sequence. Split anything that cannot be delivered in one pull request.`

type HeadlessOutcome = { readonly stdout: string } | { readonly failure: ProviderFailure }

const callHeadless = async (input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly root: string; readonly timeoutMs: number; readonly candidate: RankedModel; readonly prompt: string }): Promise<HeadlessOutcome> => {
  const { settings } = providerIdentity(input.config, input.candidate.provider)
  const argv = renderHeadlessArgv(settings, input.candidate.model, input.prompt, input.candidate.effort)
  if (!argv) return { failure: { provider: input.candidate.provider, model: input.candidate.model, kind: 'other', detail: `no headless argv template (models.providers.${input.candidate.provider}.headless)` } }
  const outcome = await input.runner.run(argv, { timeoutMs: input.timeoutMs, cwd: input.root, promptOnStdin: true })
  const detail = `${outcome.stderr.trim()}\n${outcome.stdout.trim()}`.trim().slice(0, 600)
  if (outcome.timedOut || outcome.code !== 0) return { failure: { provider: input.candidate.provider, model: input.candidate.model, kind: classifyProviderFailure(detail, outcome.timedOut), detail: outcome.timedOut ? `timed out after ${input.timeoutMs}ms` : `exited ${outcome.code ?? 'null'}: ${detail || 'no output'}` } }
  return { stdout: outcome.stdout }
}

const firstUsable = async <T>(input: { readonly runner: CommandRunner; readonly config: LoopConfig; readonly root: string; readonly timeoutMs: number; readonly candidates: readonly RankedModel[]; readonly prompt: string; readonly parse: (stdout: string) => T; readonly label: string }): Promise<{ readonly value: T; readonly candidate: RankedModel }> => {
  const failures: ProviderFailure[] = []
  for (const candidate of input.candidates) {
    const outcome = await callHeadless({ ...input, candidate })
    if ('failure' in outcome) { failures.push(outcome.failure); continue }
    try { return { value: input.parse(outcome.stdout), candidate } } catch (error) { failures.push({ provider: candidate.provider, model: candidate.model, kind: 'output', detail: error instanceof Error ? error.message : String(error) }) }
  }
  return fail(`${input.label} failed on every candidate: ${failures.map((failure) => `${failure.provider}/${failure.model} [${failure.kind}] ${failure.detail.split('\n')[0]}`).join(' | ') || 'no candidate available'}`, 'HARNESS_ERROR')
}

export interface PlanStageDeps {
  readonly loaded: LoadedLoopConfig
  readonly runner: CommandRunner
  /** Where the model reads the repository — the base view (`ensureBaseView`). Defaults to `project.root`. */
  readonly readRoot?: string
  readonly candidates: readonly RankedModel[]
  readonly voters?: readonly RankedModel[]
  readonly now?: () => Date
}

/**
 * One interview round: ask the model for the next question, given everything answered so far.
 *
 * The machine — not the model — decides the interview is over: `complete` is only honoured when `prdGaps` is
 * empty. A model that declares itself done with an empty success criterion is simply asked again.
 */
export const interviewRound = async (deps: PlanStageDeps, state: PlanStageState): Promise<PlanStageState> => {
  const now = (deps.now ?? (() => new Date()))()
  const { value } = await firstUsable({ runner: deps.runner, config: deps.loaded.config, root: deps.readRoot ?? deps.loaded.root, timeoutMs: deps.loaded.config.worker.plan.stageTimeoutMs, candidates: deps.candidates, prompt: renderInterviewPrompt(state, deps.loaded.config), parse: parseQuestionOutput, label: 'Interview' })
  // An absent field in this round keeps what earlier rounds established; the parser turns "nothing yet" into absent.
  const prd = { ...state.prd, ...Object.fromEntries(Object.entries(value.prd).filter(([, field]) => field !== undefined)) }
  const gaps = prdGaps(prd)
  const done = value.complete && gaps.length === 0 && !value.question
  return { ...state, prd, pending: done ? null : value, phase: done ? 'review' : 'interview', updatedAt: now.toISOString() }
}

/** Record the human's answer to the pending question and clear it, so the next round asks something new. */
export const answerRound = (state: PlanStageState, answer: string, now: Date): PlanStageState => {
  if (!state.pending?.question) return fail('There is no open question to answer.', 'INVALID_STATE')
  return { ...state, rounds: [...state.rounds, { at: now.toISOString(), question: state.pending.question, answer, field: state.pending.field }], pending: null, updatedAt: now.toISOString() }
}

/** The human approves the PRD. The interview ending is the machine's call; this one is not. */
export const approvePlan = (state: PlanStageState, actor: string, now: Date): PlanStageState => {
  if (state.phase !== 'review') return fail(`The plan is in phase "${state.phase}"; only a plan in review can be approved.`, 'INVALID_STATE')
  const gaps = prdGaps(state.prd)
  if (gaps.length) return fail(`The PRD still has gaps: ${gaps.join(', ')}.`, 'INVALID_STATE')
  return { ...state, phase: 'architect', approvals: { ...state.approvals, plan: `${actor}@${now.toISOString()}` }, updatedAt: now.toISOString() }
}

/**
 * The system design for the whole PRD, voted on by the same 2-of-3 rule as an issue's plan.
 *
 * Consensus is not enough by itself: the design still waits for a human (`approveDesign`), because everything
 * built afterwards inherits it.
 */
export const architectRound = async (deps: PlanStageDeps, state: PlanStageState): Promise<PlanStageState> => {
  if (state.phase !== 'architect') return fail(`The plan is in phase "${state.phase}"; the architect runs after the PRD is approved.`, 'INVALID_STATE')
  const config = deps.loaded.config
  const now = (deps.now ?? (() => new Date()))()
  const voters = deps.voters ?? deps.candidates
  let objections: readonly string[] = []
  let design: Design | null = null
  let votes: readonly CastVote[] = []
  for (let cycle = 1; cycle <= config.worker.plan.maxCycles; cycle += 1) {
    const proposal = await firstUsable({ runner: deps.runner, config, root: deps.readRoot ?? deps.loaded.root, timeoutMs: config.worker.plan.stageTimeoutMs, candidates: deps.candidates, prompt: renderArchitectPrompt(state, config, objections), parse: parseDesignOutput, label: 'Design' })
    design = proposal.value
    const cast: CastVote[] = []
    for (let index = 0; index < config.worker.plan.votes; index += 1) {
      const candidate = voters[index % Math.max(1, voters.length)]
      if (!candidate) break
      const outcome = await callHeadless({ runner: deps.runner, config, root: deps.readRoot ?? deps.loaded.root, timeoutMs: config.worker.plan.stageTimeoutMs, candidate, prompt: renderDesignVotePrompt(state, config, design) })
      if ('failure' in outcome) continue
      try {
        const parsed = JSON.parse(between(outcome.stdout, '<<<LOOP_VOTE', 'LOOP_VOTE>>>', 'vote')) as { vote?: unknown; objections?: unknown }
        const vote = parsed.vote === 'approve' ? 'approve' : 'reject'
        const list = Array.isArray(parsed.objections) ? parsed.objections.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
        if (vote === 'reject' && !list.length) continue
        cast.push({ vote, objections: list, provider: candidate.provider, model: candidate.model })
      } catch { continue }
    }
    votes = cast
    const tally = tallyVotes(cast, config.worker.plan.approvals)
    if (tally.approved) return { ...state, design, designVotes: cast, designCycles: cycle, updatedAt: now.toISOString() }
    objections = tally.objections
  }
  return { ...state, design, designVotes: votes, designCycles: config.worker.plan.maxCycles, updatedAt: now.toISOString() }
}

export const designApproved = (state: PlanStageState, config: LoopConfig): boolean => state.design !== null && tallyVotes(state.designVotes, config.worker.plan.approvals).approved

/** Objections raised in the latest design round, even by voters who approved — consensus does not make them go away. */
export const openDesignObjections = (state: PlanStageState): readonly string[] => [...new Set(state.designVotes.flatMap((vote) => vote.objections))]

/**
 * The human design gate. Consensus is necessary, not sufficient: when any vote still carries an objection, the gate
 * refuses unless the human accepts them explicitly — and then they travel into decompose, which must settle each one
 * inside an issue. Observed: a 2-of-3 design was approved while two votes named the same missing decision (which
 * package gets the moved code); it resurfaced as two blocking contract escalations on the first issue.
 */
export const approveDesign = (state: PlanStageState, actor: string, now: Date, config: LoopConfig, options: { readonly acceptObjections?: boolean } = {}): PlanStageState => {
  if (state.phase !== 'architect') return fail(`The plan is in phase "${state.phase}"; only a design can be approved here.`, 'INVALID_STATE')
  if (!designApproved(state, config)) return fail('The design has not reached consensus yet; run the architect round again or settle the objections.', 'INVALID_STATE')
  const objections = openDesignObjections(state)
  if (objections.length && !options.acceptObjections) return fail(`The design reached consensus but ${objections.length} objection(s) are still open:\n- ${objections.join('\n- ')}\nRun the architect round again, or approve with --accept-objections to hand them to decompose as decisions each issue must settle.`, 'HUMAN_APPROVAL_REQUIRED')
  return { ...state, phase: 'decompose', approvals: { ...state.approvals, design: `${actor}@${now.toISOString()}` }, ...(objections.length ? { acceptedObjections: objections } : {}), updatedAt: now.toISOString() }
}

/** Break the approved design into issues. Nothing is written to the tracker here — that is `createPlannedIssues`. */
export const decomposeRound = async (deps: PlanStageDeps, state: PlanStageState): Promise<PlanStageState> => {
  if (state.phase !== 'decompose') return fail(`The plan is in phase "${state.phase}"; decomposition runs after the design is approved.`, 'INVALID_STATE')
  const now = (deps.now ?? (() => new Date()))()
  const { value } = await firstUsable({ runner: deps.runner, config: deps.loaded.config, root: deps.readRoot ?? deps.loaded.root, timeoutMs: deps.loaded.config.worker.plan.stageTimeoutMs, candidates: deps.candidates, prompt: renderDecomposePrompt(state, deps.loaded.config), parse: parseIssuesOutput, label: 'Decomposition' })
  return { ...state, issues: value.map((issue) => ({ ...issue })), updatedAt: now.toISOString() }
}

const priorityFor = (issue: PlannedIssue): string => issue.priority

/** Where the planned issues land, beyond the team: the epic they break down, and the project the queue drains. */
export interface PlannedIssueTarget {
  readonly parent?: string
  readonly project?: string
}

/**
 * The labels an issue needs so that, once a human moves it into the queue, the queue actually sees it: every
 * `requireLabels`, one of `anyLabels` (the first) when none is already there, and the issue's own layer.
 */
/** The labels a planned issue may carry as its layer: the configured layers, else the queue's `anyLabels`. */
const layerChoices = (config: LoopConfig): readonly string[] => config.layers.length ? config.layers.map((layer) => layer.label) : config.linear.anyLabels

export const plannedIssueLabels = (config: LoopConfig, layer?: string, outside?: string): readonly string[] => {
  if (outside) return [config.linear.outsideLabel]
  // Only a label the project declared becomes a label: a model asked to pick from an empty list writes the prompt's
  // own wording back ("no layers configured"), and the tracker refuses the whole issue for it.
  const known = layer && layerChoices(config).includes(layer) ? layer : undefined
  const labels = [...config.linear.requireLabels, ...(known ? [known] : [])]
  if (config.linear.anyLabels.length && !labels.some((label) => config.linear.anyLabels.includes(label))) labels.push(config.linear.anyLabels[0] as string)
  return [...new Set(labels)]
}

/**
 * Create the decomposed issues in the configured tracker, in the compatibility `entryState` — never in one of the
 * dispatchable compatibility states, which ARE
 * the queue. Moving them into the queue stays a human gesture; that is the single gate.
 *
 * They are created where the queue will look for them — the project it drains (when it drains exactly one, or
 * the one given), carrying its labels — and under the epic they came from. An issue the planner creates and the
 * queue cannot see is work that silently never happens.
 */
export const createPlannedIssues = async (deps: PlanStageDeps, state: PlanStageState, target: PlannedIssueTarget = {}): Promise<PlanStageState> => {
  const config = deps.loaded.config
  requireWritableTracker(config)
  const now = (deps.now ?? (() => new Date()))()
  const tracker = resolveConnectors({ runner: deps.runner, config }).tracker
  const entryState = config.linear.entryState
  const project = target.project ?? (config.linear.projects.length === 1 ? config.linear.projects[0] : undefined)
  const created: (PlannedIssue & { identifier?: string; url?: string })[] = []
  for (const issue of state.issues) {
    if (issue.identifier) { created.push(issue); continue }
    // The design travels as content, not as a pointer: a worker that cannot fetch the reference invents the
    // architecture instead of implementing the one that was approved.
    const excerpt = designExcerptFor(state.design, issue.designRef)
    const where = issue.outside ? `**Outside this loop — ${issue.outside}.** The loop delivers pull requests to ${config.project.repo} only, so it will not dispatch this issue (\`${config.linear.outsideLabel}\`); a person or another loop carries it.\n\n` : ''
    const description = `${where}${issue.description}\n\n**Acceptance**\n${issue.acceptance.map((item) => `- [ ] ${item}`).join('\n')}\n\n**Design — ${issue.designRef}**\n\n${excerpt || '_not found in the approved design_'}\n\n<!-- loop:plan:${state.id} -->`
    const result = await tracker.createIssue({
      title: issue.title, description, state: entryState,
      priority: priorityFor(issue), labels: plannedIssueLabels(config, issue.layer, issue.outside),
      ...(project ? { project } : {}), ...(target.parent ? { parent: target.parent } : {}),
      dedupeKey: `plan:${state.id}:${issue.title}`,
    })
    created.push({ ...issue, ...(result.identifier ? { identifier: result.identifier } : {}), ...(result.url ? { url: result.url } : {}) })
  }
  return { ...state, issues: created, phase: 'done', updatedAt: now.toISOString() }
}

export const renderPlanMarkdown = (state: PlanStageState): string => {
  const lines = [`# Plan ${state.id}`, '', `_${state.phase}_ · objective: ${state.objective}`, '', '## PRD', '```json', JSON.stringify(state.prd, null, 2), '```', '']
  if (state.rounds.length) { lines.push('## Interview', ''); for (const round of state.rounds) lines.push(`- **${round.field || 'q'}** — ${round.question}\n  - ${round.answer}`); lines.push('') }
  if (state.design) lines.push('## Design', '', state.design.summary, '', ...state.design.modules.map((module) => `- **${module.name}** — ${module.responsibility}${module.boundary ? ` (never: ${module.boundary})` : ''}`), '')
  if (state.designVotes.length) lines.push(`_Design votes: ${state.designVotes.filter((vote) => vote.vote === 'approve').length}/${state.designVotes.length} after ${state.designCycles} cycle(s)_`, '')
  if (state.issues.length) { lines.push('## Issues', ''); for (const issue of state.issues) lines.push(`- ${issue.identifier ? `\`${issue.identifier}\` ` : ''}${issue.title}${issue.layer ? ` · ${issue.layer}` : ''}${issue.outside ? ` · outside: ${issue.outside}` : ''} → ${issue.designRef}`); lines.push('') }
  lines.push(`Approvals: plan ${state.approvals.plan ?? 'pending'} · design ${state.approvals.design ?? 'pending'}`)
  return lines.join('\n')
}
