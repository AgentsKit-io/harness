import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessDod, parseLoopConfigText, readDodEvidence, renderDodForBrief, renderDodMarkdown } from '../src/index.js'
import type { LoopConfig, TaskContract } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const DOD = `
dod:
  items:
    - id: verify
      description: lint and tests pass
      kind: command
      command: [pnpm, lint]
    - id: test-for-new-code
      description: new code ships a test
      kind: file-changed
      glob: "**/*.test.ts"
    - id: no-todo
      description: no TODO left behind
      kind: pattern-absent
      pattern: "TODO"
      paths: ["src/**"]
`

const config = (extra = DOD): LoopConfig => parseLoopConfigText(`${exampleYaml}${extra}`)

const contract: TaskContract = {
  intent: 'do the thing',
  scope: { inScope: ['a'], outOfScope: [] },
  outcomes: [{ id: 'o1', description: 'endpoint answers 200', check: { kind: 'command', command: 'pnpm test api' } }],
  ambiguities: [], touchpoints: [], risks: [],
} as TaskContract

describe('reading the worker\'s proofs', () => {
  it('reads an empty set from a missing, unreadable or malformed file instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-dod-')); cleanups.push(dir)
    expect(readDodEvidence(null, config())).toEqual({ project: [], outcomes: [] })
    expect(readDodEvidence(dir, config())).toEqual({ project: [], outcomes: [] })
    mkdirSync(join(dir, '.ak-loop'), { recursive: true })
    writeFileSync(join(dir, '.ak-loop', 'dod.json'), '{ not json')
    expect(readDodEvidence(dir, config())).toEqual({ project: [], outcomes: [] })
    writeFileSync(join(dir, '.ak-loop', 'dod.json'), JSON.stringify({ project: [{ id: 'verify', status: 'passed', evidence: 'exit 0' }, { id: 'bad', status: 'maybe' }], outcomes: 'nope' }))
    expect(readDodEvidence(dir, config())).toEqual({ project: [{ id: 'verify', status: 'passed', evidence: 'exit 0' }], outcomes: [] })
  })
})

describe('judging both lists', () => {
  const evidence = { project: [{ id: 'verify', status: 'passed' as const, evidence: 'pnpm lint → exit 0' }], outcomes: [{ id: 'o1', status: 'passed' as const, evidence: 'curl → 200' }] }

  it('decides file-changed and pattern-absent itself, and asks the worker for the command item', () => {
    const assessment = assessDod({ config: config(), contract, evidence, prFiles: ['src/a.ts', 'src/a.test.ts'], fileContents: { 'src/a.ts': 'export const a = 1\n' } })
    expect(assessment.complete).toBe(true)
    expect(assessment.lines.map((line) => [line.id, line.status, line.source])).toEqual([
      ['verify', 'proven', 'worker'],
      ['test-for-new-code', 'proven', 'harness'],
      ['no-todo', 'proven', 'harness'],
      ['o1', 'proven', 'worker'],
    ])
  })

  it('separates "not proven yet" from "proven and failing" — they are different instructions', () => {
    const assessment = assessDod({ config: config(), contract, evidence: { project: [{ id: 'verify', status: 'failed', evidence: 'pnpm lint → exit 1' }], outcomes: [] }, prFiles: ['src/a.ts'], fileContents: { 'src/a.ts': 'const x = 1 // TODO\n' } })
    expect(assessment.complete).toBe(false)
    expect(assessment.failed).toEqual(['verify', 'test-for-new-code', 'no-todo'])
    expect(assessment.missing).toEqual(['o1'])
    expect(assessment.lines.find((line) => line.id === 'no-todo')?.evidence).toContain('TODO found in src/a.ts')
    expect(assessment.lines.find((line) => line.id === 'test-for-new-code')?.evidence).toContain('no changed file matches')
  })

  it('leaves a pattern-absent item to the worker when no file content is available', () => {
    const assessment = assessDod({ config: config(), contract: null, evidence: { project: [], outcomes: [] }, prFiles: ['src/a.ts'] })
    expect(assessment.lines.find((line) => line.id === 'no-todo')).toMatchObject({ status: 'missing', source: 'worker' })
  })

  it('judges only the contract outcomes when the project declares no items', () => {
    const assessment = assessDod({ config: config(''), contract, evidence, prFiles: [] })
    expect(assessment.lines.map((line) => line.list)).toEqual(['issue'])
    expect(assessment.complete).toBe(true)
  })
})

describe('what reaches the PR and the worker', () => {
  it('renders one row per item with its evidence', () => {
    const markdown = renderDodMarkdown(assessDod({ config: config(), contract, evidence: { project: [], outcomes: [] }, prFiles: [] }))
    expect(markdown).toContain('## Definition of Done')
    expect(markdown).toContain('| project | `verify` |')
    expect(markdown).toContain('Missing:')
  })

  it('tells the worker what to prove and exactly where to write the proof', () => {
    const brief = renderDodForBrief(config())
    expect(brief).toContain('`verify`: lint and tests pass — run `pnpm lint` (exit 0)')
    expect(brief).toContain('.ak-loop/dod.json')
    expect(brief).toContain('blocks the merge')
    expect(renderDodForBrief(config(''))).toBe('')
  })
})
