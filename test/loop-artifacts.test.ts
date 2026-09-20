import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessDod, loadLoopConfig, missingArtifacts, readPhaseArtifacts, readPlanArtifact, readVerifyArtifact, renderArtifactsForBrief, verifyProofs } from '../src/index.js'
import type { LoopConfig } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8')

const config = (): LoopConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-artifacts-cfg-')); cleanups.push(dir)
  writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
  return loadLoopConfig(join(dir, 'loop.config.yaml')).config
}

/** A worktree holding whatever the caller says the worker left behind. */
const worktree = (files: Readonly<Record<string, string>> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentskit-loop-artifacts-')); cleanups.push(dir)
  mkdirSync(join(dir, '.ak-loop'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, '.ak-loop', name), body)
  return dir
}

const verifyJson = JSON.stringify({ ranAt: '2026-09-20T10:00:00.000Z', command: 'pnpm test', exitCode: 0, outcomes: [{ id: 'o1', status: 'passed', evidence: '1338 passed' }] })

describe('phase artifacts', () => {
  it('reports each file as present only when it is there and parses', () => {
    const cfg = config()
    const complete = readPhaseArtifacts(worktree({ 'plan.md': '# what I did\n- step one\n', 'verify.json': verifyJson, 'dod.json': '{"project":[],"outcomes":[]}' }), cfg)
    expect(complete.every((artifact) => artifact.present && artifact.valid)).toBe(true)
    expect(complete.find((artifact) => artifact.name === 'verify')?.detail).toContain('pnpm test')
    expect(missingArtifacts(complete, ['plan', 'verify', 'dod'])).toEqual([])
  })

  it('treats a file that exists but does not match its schema as worse than a missing one', () => {
    const cfg = config()
    const artifacts = readPhaseArtifacts(worktree({ 'verify.json': '{"outcomes": [{"id": "", "status": "maybe"}]}' }), cfg)
    const verify = artifacts.find((artifact) => artifact.name === 'verify')
    expect(verify).toMatchObject({ present: true, valid: false })
    expect(verify?.detail).toBe('present but does not match the schema')
    // Present-but-invalid still blocks, and the file is named either way.
    expect(missingArtifacts(artifacts, ['verify']).map((artifact) => artifact.file)).toEqual(['.ak-loop/verify.json'])
    expect(readVerifyArtifact(worktree({ 'verify.json': 'not json at all' }))).toBeNull()
  })

  it('reads nothing at all from a worktree the harness does not have', () => {
    const cfg = config()
    expect(readPlanArtifact(null)).toBeNull()
    expect(readVerifyArtifact(undefined)).toBeNull()
    expect(readPhaseArtifacts(worktree(), cfg).map((artifact) => artifact.present)).toEqual([false, false, false])
    expect(readPlanArtifact(worktree({ 'plan.md': '   \n' }))).toBeNull() // empty counts as absent
  })

  it('hands verify.json outcomes to the definition of done in the shape it already understands', () => {
    const cfg = config()
    const proofs = verifyProofs(readVerifyArtifact(worktree({ 'verify.json': verifyJson })))
    expect(proofs).toEqual([{ id: 'o1', status: 'passed', evidence: '1338 passed' }])
    const contract = { intent: 'i', scope: { inScope: [], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'it works', check: { kind: 'command' as const, command: 'pnpm test' } }], touchpoints: [], risks: [] }
    const assessed = assessDod({ config: cfg, contract, evidence: { project: [], outcomes: proofs } })
    expect(assessed).toMatchObject({ complete: true, missing: [], failed: [] })
    // Without the proof the same outcome is `missing` — "prove it", not "fix it".
    expect(assessDod({ config: cfg, contract, evidence: { project: [], outcomes: [] } }).missing).toEqual(['o1'])
  })

  it('names the three files, and the DoD evidence path the project configured, in the worker brief', () => {
    const cfg = config()
    const brief = renderArtifactsForBrief(cfg)
    expect(brief).toContain('.ak-loop/plan.md')
    expect(brief).toContain('.ak-loop/verify.json')
    expect(brief).toContain(cfg.dod.evidenceFile)
    expect(brief).toContain('fix round naming it')
  })
})
