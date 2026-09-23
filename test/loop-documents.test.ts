import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approveDesign, approvePlan, designExcerptFor, designPathFor, loadLoopConfig, prdPathFor, renderDesignMarkdown, renderPrdMarkdown, startPlan, writeDesignDocument, writePrdDocument } from '../src/index.js'
import type { Design, LoadedLoopConfig, PlanStageState, Prd } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const NOW = new Date('2026-09-19T12:00:00.000Z')

const PRD: Prd = {
  objective: 'let ops see whether the service is alive',
  users: ['ops'],
  inScope: ['the /health route'],
  outOfScope: ['authentication'],
  nonGoals: ['a status page'],
  constraints: ['no new dependency'],
  successCriteria: ['/health answers 200 in under 50 ms'],
  risks: ['the check could hide a failing dependency'],
}

const DESIGN: Design = {
  summary: 'one route, one handler, no state.',
  modules: [{ name: 'api', responsibility: 'serve /health', boundary: 'never touches the database' }],
  contracts: [{ name: 'HealthResponse', shape: '{ status: "ok" }' }],
  decisions: [{ id: 'd1', decision: 'no dependency check inside /health', because: 'a liveness probe that fails on a slow dependency takes the service down with it' }],
  sequence: ['route first, then the test'],
  risks: [],
}

const setup = (overlay = ''): LoadedLoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-documents-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  if (overlay) writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
  const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
  mkdirSync(loaded.stateDir, { recursive: true })
  return loaded
}

const planWith = (overrides: Partial<PlanStageState> = {}): PlanStageState => ({
  ...startPlan('let ops see whether the service is alive', NOW),
  prd: PRD,
  rounds: [{ at: NOW.toISOString(), question: 'Who is this for?', answer: 'ops — they carry the pager', field: 'users' }],
  ...overrides,
})

describe('the PRD document', () => {
  it('is written where the config says, with the answers that produced it', () => {
    const loaded = setup()
    const approved = approvePlan({ ...planWith(), phase: 'review' }, 'emerson', NOW)
    const written = writePrdDocument(loaded, approved)
    expect(written?.path).toBe(prdPathFor(loaded, approved.id))
    const text = readFileSync(written!.path, 'utf8')
    expect(text).toContain('# PRD — let ops see whether the service is alive')
    expect(text).toContain('approved by emerson@')
    expect(text).toContain('- /health answers 200 in under 50 ms')
    // The interview is part of the record: how it was decided, not only what was decided.
    expect(text).toContain('Who is this for?')
    expect(text).toContain('ops — they carry the pager')
    expect(text).toContain(`<!-- loop:prd:${approved.id} -->`)
  })

  it('honours a different path, and writes nothing under backend none', () => {
    const custom = setup('documents:\n  prdPath: docs/product\n')
    const approved = approvePlan({ ...planWith(), phase: 'review' }, 'emerson', NOW)
    expect(writePrdDocument(custom, approved)?.path).toContain(join('docs', 'product'))

    const off = setup('documents:\n  backend: none\n')
    expect(writePrdDocument(off, approved)).toBeNull()
    expect(existsSync(prdPathFor(off, approved.id))).toBe(false)
  })

  it('writes nothing for a plan with no objective yet', () => {
    expect(writePrdDocument(setup(), startPlan('', NOW))).toBeNull()
  })
})

describe('the design document', () => {
  it('records the vote, the modules, the contracts and the decisions', () => {
    const loaded = setup()
    const state: PlanStageState = {
      ...planWith({ phase: 'architect', design: DESIGN, designCycles: 2 }),
      designVotes: [
        { vote: 'approve', objections: [], provider: 'claude', model: 'opus' },
        { vote: 'approve', objections: [], provider: 'codex', model: 'sol' },
        { vote: 'reject', objections: ['naming'], provider: 'grok', model: 'fast' },
      ],
    }
    const approved = approveDesign(state, 'emerson', NOW, loaded.config, { acceptObjections: true })
    const written = writeDesignDocument(loaded, approved)
    expect(written?.path).toBe(designPathFor(loaded, approved.id))
    const text = readFileSync(written!.path, 'utf8')
    expect(text).toContain('2/3 agents approved after 2 cycle(s)')
    expect(text).toContain('**api** — serve /health · never: never touches the database')
    expect(text).toContain('**HealthResponse** — `{ status: "ok" }`')
    expect(text).toContain('**d1** — no dependency check inside /health')
    expect(text).toContain('because: a liveness probe that fails')
    // Turning a decision into a numbered ADR stays a human gesture, and the document says so.
    expect(text).toContain('is a human gesture; the loop never writes one')
  })

  it('writes nothing when there is no design, or under backend none', () => {
    const loaded = setup()
    expect(writeDesignDocument(loaded, planWith({ phase: 'architect' }))).toBeNull()
    const off = setup('documents:\n  backend: none\n')
    expect(writeDesignDocument(off, planWith({ phase: 'architect', design: DESIGN }))).toBeNull()
  })
})

describe('the design an issue carries', () => {
  it('finds the module, the contract or the decision the issue names', () => {
    expect(designExcerptFor(DESIGN, 'api')).toContain('serve /health')
    expect(designExcerptFor(DESIGN, 'API')).toContain('serve /health')
    expect(designExcerptFor(DESIGN, 'HealthResponse')).toContain('{ status: "ok" }')
    expect(designExcerptFor(DESIGN, 'd1')).toContain('no dependency check')
  })

  it('falls back to the summary rather than handing the worker a reference it cannot resolve', () => {
    expect(designExcerptFor(DESIGN, 'something-else')).toBe(DESIGN.summary)
    expect(designExcerptFor(null, 'api')).toBe('')
  })
})

describe('rendering on its own', () => {
  it('marks a document written before approval as pending', () => {
    expect(renderPrdMarkdown(planWith(), PRD, null)).toContain('approved by pending')
    expect(renderDesignMarkdown(planWith({ design: DESIGN }), DESIGN, null)).toContain('approved by pending')
  })
})
