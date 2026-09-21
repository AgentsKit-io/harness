import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLAN_CLOSE, PLAN_OPEN, VOTE_CLOSE, VOTE_OPEN, loadLoopConfig, parsePlanOutput, parseVoteOutput, readStoredPlan, renderPlanForBrief, renderPlanPrompt, renderVotePrompt, runPlanWithVotes, tallyVotes, writeStoredPlan } from '../src/index.js'
import type { CastVote, CommandResult, CommandRunner, LoadedLoopConfig, RankedModel, StoredPlan, TaskContract, TaskPlan } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const setup = (overlay = 'worker:\n  plan:\n    enabled: true\n'): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-plan-vote-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

const contract: TaskContract = {
  intent: 'add a health endpoint',
  scope: { inScope: ['src/api'], outOfScope: [] },
  outcomes: [{ id: 'o1', description: '/health answers 200', check: { kind: 'command', command: 'pnpm test api' } }],
  ambiguities: [], touchpoints: ['src/api/health.ts'], risks: [],
} as TaskContract

const plan: TaskPlan = { summary: 'add the route and a test', steps: [{ id: 's1', description: 'add src/api/health.ts', files: ['src/api/health.ts'] }], tests: ['src/api/health.test.ts covers 200'], risks: [] }

const candidate = (provider: string, model: string): RankedModel => ({ provider, model, tier: 0, reason: 'test', remainingPercent: null, effort: 'medium' } as RankedModel)
const planners = [candidate('claude', 'opus')]
const voters = [candidate('claude', 'opus'), candidate('codex', 'gpt-5.6-sol'), candidate('grok', 'grok-4-fast')]

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, durationMs: 1 })
const planOut = (value: TaskPlan = plan): string => `thinking…\n${PLAN_OPEN}\n${JSON.stringify(value)}\n${PLAN_CLOSE}\n`
const voteOut = (vote: 'approve' | 'reject', objections: string[] = []): string => `${VOTE_OPEN}\n${JSON.stringify({ vote, objections })}\n${VOTE_CLOSE}`

/** A runner that answers plan prompts and vote prompts from queues, and records which prompts it saw. */
const scripted = (votes: readonly string[][]): CommandRunner & { readonly prompts: string[] } => {
  const prompts: string[] = []
  let cycle = -1
  let voteIndex = 0
  return {
    prompts,
    run: async (argv) => {
      const prompt = argv.find((argument) => argument.includes('LOOP_PLAN') || argument.includes('LOOP_VOTE')) ?? argv.join(' ')
      prompts.push(prompt)
      if (prompt.includes('You are the planner')) { cycle += 1; voteIndex = 0; return ok(planOut()) }
      const round = votes[cycle] ?? []
      const answer = round[voteIndex] ?? voteOut('reject', ['no vote scripted'])
      voteIndex += 1
      return ok(answer)
    },
  }
}

describe('parsing plans and votes', () => {
  it('reads the last block and rejects anything that is not a usable plan', () => {
    expect(parsePlanOutput(planOut())).toEqual(plan)
    expect(parsePlanOutput(`${planOut()}`.replace(`${PLAN_OPEN}\n`, `${PLAN_OPEN}\n\`\`\`json\n`).replace(`\n${PLAN_CLOSE}`, '\n```\n' + PLAN_CLOSE))).toEqual(plan)
    expect(() => parsePlanOutput('no markers here')).toThrow(/no plan block/i)
    expect(() => parsePlanOutput(`${PLAN_OPEN}{ broken ${PLAN_CLOSE}`)).toThrow(/not valid JSON/)
    expect(() => parsePlanOutput(`${PLAN_OPEN}${JSON.stringify({ summary: 'x', steps: [] })}${PLAN_CLOSE}`)).toThrow(/failed validation/)
  })

  it('discards a rejection that names no objection — it cannot be answered', () => {
    expect(parseVoteOutput(voteOut('approve'))).toEqual({ vote: 'approve', objections: [] })
    expect(parseVoteOutput(voteOut('reject', ['o1 is not reached by any step']))).toEqual({ vote: 'reject', objections: ['o1 is not reached by any step'] })
    expect(() => parseVoteOutput(voteOut('reject'))).toThrow(/at least one concrete objection/)
  })

  it('counts approvals and collects the distinct objections', () => {
    const cast = (vote: 'approve' | 'reject', objections: string[] = []): CastVote => ({ vote, objections, provider: 'p', model: 'm' })
    expect(tallyVotes([cast('approve'), cast('approve'), cast('reject', ['a'])], 2)).toEqual({ approved: true, objections: ['a'] })
    expect(tallyVotes([cast('approve'), cast('reject', ['a']), cast('reject', ['a', 'b'])], 2)).toEqual({ approved: false, objections: ['a', 'b'] })
    expect(tallyVotes([], 1)).toEqual({ approved: false, objections: [] })
  })
})

describe('the prompts', () => {
  it('gives the planner the contract, and the objections when replanning', () => {
    const loaded = setup()
    const first = renderPlanPrompt({ issue: 'ENG-1', config: loaded.config, contract })
    expect(first).toContain('o1: /health answers 200')
    expect(first).toContain(PLAN_OPEN)
    expect(first).not.toContain('Objections raised')
    const again = renderPlanPrompt({ issue: 'ENG-1', config: loaded.config, contract, objections: ['no test for the new route'] })
    expect(again).toContain('Objections raised against your previous plan')
    expect(again).toContain('no test for the new route')
  })

  it('tells the voter the threshold and treats the plan as data, not instructions', () => {
    const prompt = renderVotePrompt({ issue: 'ENG-1', config: setup().config, contract, plan })
    expect(prompt).toContain('2 of 3 approvals')
    expect(prompt).toContain('Style preferences are not objections')
    expect(prompt).toMatch(/untrusted|BEGIN|data/i)
  })
})

describe('planner → vote → replan', () => {
  it('stops at the first cycle that reaches the threshold', async () => {
    const loaded = setup()
    const runner = scripted([[voteOut('approve'), voteOut('approve'), voteOut('reject', ['naming'])]])
    const stored = await runPlanWithVotes({ runner, config: loaded.config, root: loaded.root, issue: 'ENG-1', contract, contractDigest: 'c1', planner: planners, voters })
    expect(stored).toMatchObject({ status: 'approved', cycles: 1, contractDigest: 'c1', issue: 'ENG-1' })
    expect(stored.votes).toHaveLength(3)
    expect(stored.votes.map((vote) => vote.model)).toEqual(['opus', 'gpt-5.6-sol', 'grok-4-fast'])
    expect(runner.prompts.filter((prompt) => prompt.includes('You are the planner'))).toHaveLength(1)
  })

  it('replans with the objections and approves on a later cycle', async () => {
    const loaded = setup()
    const runner = scripted([
      [voteOut('reject', ['no test for the new route']), voteOut('reject', ['no test for the new route']), voteOut('approve')],
      [voteOut('approve'), voteOut('approve'), voteOut('approve')],
    ])
    const stored = await runPlanWithVotes({ runner, config: loaded.config, root: loaded.root, issue: 'ENG-1', contract, contractDigest: 'c1', planner: planners, voters })
    expect(stored).toMatchObject({ status: 'approved', cycles: 2 })
    const replan = runner.prompts.filter((prompt) => prompt.includes('You are the planner'))
    expect(replan).toHaveLength(2)
    expect(replan[1]).toContain('no test for the new route')
  })

  it('gives up after maxCycles and hands the unresolved objections to a human', async () => {
    const loaded = setup('worker:\n  plan:\n    enabled: true\n    maxCycles: 2\n')
    const runner = scripted([
      [voteOut('reject', ['scope creep']), voteOut('reject', ['scope creep']), voteOut('approve')],
      [voteOut('reject', ['scope creep']), voteOut('reject', ['still unclear']), voteOut('approve')],
    ])
    const stored = await runPlanWithVotes({ runner, config: loaded.config, root: loaded.root, issue: 'ENG-1', contract, contractDigest: 'c1', planner: planners, voters })
    expect(stored).toMatchObject({ status: 'no-consensus', cycles: 2 })
    expect(stored.unresolved).toEqual(['scope creep', 'still unclear'])
  })

  it('fails loudly when no planner candidate can produce a plan', async () => {
    const loaded = setup()
    const broken: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'model unavailable', timedOut: false, durationMs: 1 }) }
    await expect(runPlanWithVotes({ runner: broken, config: loaded.config, root: loaded.root, issue: 'ENG-1', contract, contractDigest: 'c1', planner: planners, voters })).rejects.toThrow(/Planning failed on every candidate/)
    await expect(runPlanWithVotes({ runner: scripted([]), config: loaded.config, root: loaded.root, issue: 'ENG-1', contract, contractDigest: 'c1', planner: [], voters })).rejects.toThrow(/No planner provider/)
  })
})

describe('the approved plan on disk and in the brief', () => {
  it('round-trips through the state directory', () => {
    const loaded = setup()
    expect(readStoredPlan(loaded.stateDir, 'ENG-1')).toBeNull()
    const stored: StoredPlan = { schemaVersion: 1, issue: 'ENG-1', generatedAt: '2026-09-19T12:00:00.000Z', provider: 'claude', model: 'opus', plan, digest: 'd1', contractDigest: 'c1', cycles: 1, votes: [{ vote: 'approve', objections: [], provider: 'claude', model: 'opus' }], status: 'approved', unresolved: [] }
    writeStoredPlan(loaded.stateDir, stored)
    expect(readStoredPlan(loaded.stateDir, 'ENG-1')).toEqual(stored)
  })

  it('reaches the worker only once it is approved', () => {
    const approved: StoredPlan = { schemaVersion: 1, issue: 'ENG-1', generatedAt: 'now', provider: 'claude', model: 'opus', plan, digest: 'd1abcdef0000', contractDigest: 'c1', cycles: 2, votes: [{ vote: 'approve', objections: [], provider: 'claude', model: 'opus' }, { vote: 'approve', objections: [], provider: 'codex', model: 'gpt' }], status: 'approved', unresolved: [] }
    const brief = renderPlanForBrief(approved)
    expect(brief).toContain('2/2 agents approved, 2 cycle(s)')
    expect(brief).toContain('s1: add src/api/health.ts')
    expect(brief).toContain('src/api/health.test.ts covers 200')
    expect(brief).toContain('do not silently replace it')
    expect(renderPlanForBrief({ ...approved, status: 'no-consensus' })).toBe('')
    expect(renderPlanForBrief(null)).toBe('')
  })
})
