import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/adapters/command.js'
import { assessDod } from '../src/loop/dod.js'
import { createProcessRunner } from '../src/loop/process.js'
import { readDeliveryState, deliveryStatePath } from '../src/loop/deliver-state.js'
import { isProven, meetsVerdict, migrateVerdict, patchIdOfPullRequest, readVerdictRecord, reviewLevel, verdictsHold, verdictRank, VERDICT_LEVELS, verdictRecordPath, type RunFingerprint } from '../src/loop/verdict.js'
import { parseLoopConfigText, readDodEvidence } from '../src/index.js'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-verdict-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const fingerprint: RunFingerprint = { contract: 'c1', guardPolicy: 'g1', model: 'claude/sonnet', baseSha: 'base1' }
const record = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, head: 'h1', patchId: 'p1', fingerprint, at: '2026-10-20T00:00:00.000Z', items: [{ id: 'o1', list: 'issue', description: '', verdict: 'unit-verified', evidence: 'ok' }], ...over })

describe('verdict levels', () => {
  it('orders weakest to strongest and compares against a minimum', () => {
    expect(VERDICT_LEVELS).toEqual(['failed', 'blocked', 'type-check-only', 'unit-verified', 'fleet-verified', 'ci-verified', 'live-verified'])
    expect(meetsVerdict('ci-verified', 'unit-verified')).toBe(true)
    expect(meetsVerdict('fleet-verified', 'unit-verified')).toBe(true)
    expect(meetsVerdict('fleet-verified', 'ci-verified')).toBe(false)
    expect(meetsVerdict('ci-verified', 'live-verified')).toBe(false)
    expect(VERDICT_LEVELS.map(verdictRank)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(meetsVerdict('live-verified', 'unit-verified')).toBe(true)
    expect(meetsVerdict('unit-verified', 'unit-verified')).toBe(true)
    expect(meetsVerdict('type-check-only', 'unit-verified')).toBe(false)
    expect(VERDICT_LEVELS.filter(isProven)).toEqual(['type-check-only', 'unit-verified', 'fleet-verified', 'ci-verified', 'live-verified'])
  })

  it('migrates the legacy pass/fail to a level', () => {
    expect(migrateVerdict('passed')).toBe('unit-verified')
    expect(migrateVerdict('failed')).toBe('failed')
    expect(migrateVerdict('live-verified')).toBe('live-verified')
    expect(migrateVerdict('great')).toBeNull()
    expect(migrateVerdict(undefined)).toBeNull()
    expect([reviewLevel('clean'), reviewLevel('findings'), reviewLevel('incomplete')]).toEqual(['unit-verified', 'failed', 'blocked'])
  })

  it('migrates stored delivery state: reviews without a level get one from their status', () => {
    const stateDir = tmp()
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    const review = { at: 'x', provider: 'codex', model: 'm', blocking: 0, attempts: 1 }
    writeFileSync(deliveryStatePath(stateDir, 'ENG-1'), JSON.stringify({ issue: 'ENG-1', reviews: { a: { ...review, status: 'clean' }, b: { ...review, status: 'incomplete' }, c: { ...review, status: 'findings', verdict: 'live-verified' } } }))
    const reviews = readDeliveryState(stateDir, 'ENG-1').reviews
    expect([reviews['a']?.verdict, reviews['b']?.verdict, reviews['c']?.verdict]).toEqual(['unit-verified', 'blocked', 'live-verified'])
  })

  it('migrates a stored verdict record that still says passed', () => {
    const stateDir = tmp()
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(verdictRecordPath(stateDir, 'ENG-1'), JSON.stringify(record({ items: [{ id: 'o1', list: 'issue', verdict: 'passed' }] })))
    expect(readVerdictRecord(stateDir, 'ENG-1')?.items[0]).toMatchObject({ verdict: 'unit-verified', evidence: '', description: '' })
    writeFileSync(verdictRecordPath(stateDir, 'ENG-1'), '{ not json')
    expect(readVerdictRecord(stateDir, 'ENG-1')).toBeNull()
    expect(readVerdictRecord(stateDir, 'ENG-404')).toBeNull()
  })
})

describe('verdicts bound to the patch', () => {
  const stored = record() as unknown as NonNullable<ReturnType<typeof readVerdictRecord>>
  it('hold for the same patch-id, contract and guard policy — whatever the head, base or model', () => {
    expect(verdictsHold(stored, { patchId: 'p1', fingerprint })).toBe(true)
    expect(verdictsHold(stored, { patchId: 'p1', fingerprint: { ...fingerprint, baseSha: 'rebased', model: 'codex/gpt' } })).toBe(true)
  })
  it('do not hold for another patch, contract or guard policy, or when either patch-id is unknown', () => {
    expect(verdictsHold(stored, { patchId: 'p2', fingerprint })).toBe(false)
    expect(verdictsHold(stored, { patchId: 'p1', fingerprint: { ...fingerprint, contract: 'c2' } })).toBe(false)
    expect(verdictsHold(stored, { patchId: 'p1', fingerprint: { ...fingerprint, guardPolicy: 'g2' } })).toBe(false)
    expect(verdictsHold(stored, { patchId: null, fingerprint })).toBe(false)
    expect(verdictsHold({ ...stored, patchId: null }, { patchId: null, fingerprint })).toBe(false)
    expect(verdictsHold(null, { patchId: 'p1', fingerprint })).toBe(false)
  })
})

describe('patchIdOfPullRequest', () => {
  const runnerFor = (diff: { code: number; stdout: string }, patchId: { code: number; stdout: string }, seen: { argv: string[][]; stdin: (string | undefined)[] } = { argv: [], stdin: [] }): CommandRunner => ({
    run: async (argv, options) => { seen.argv.push([...argv]); seen.stdin.push(options?.stdin); const out = argv[0] === 'gh' ? diff : patchId; return { code: out.code, stdout: out.stdout, stderr: '', timedOut: false, durationMs: 1 } },
  })
  const id = 'a'.repeat(40)

  it('pipes the PR diff to `git patch-id --stable` and returns its first field', async () => {
    const seen = { argv: [] as string[][], stdin: [] as (string | undefined)[] }
    expect(await patchIdOfPullRequest(runnerFor({ code: 0, stdout: 'diff --git a b\n' }, { code: 0, stdout: `${id} ${'0'.repeat(40)}\n` }, seen), { repo: 'o/r', number: 7 })).toBe(id)
    expect(seen.argv).toEqual([['gh', 'pr', 'diff', '7', '--repo', 'o/r'], ['git', 'patch-id', '--stable']])
    expect(seen.stdin[1]).toBe('diff --git a b\n')
  })

  it('is null when the diff or patch-id is unavailable, empty, malformed or throws', async () => {
    expect(await patchIdOfPullRequest(runnerFor({ code: 1, stdout: '' }, { code: 0, stdout: id }), { repo: 'o/r', number: 7 })).toBeNull()
    expect(await patchIdOfPullRequest(runnerFor({ code: 0, stdout: '  ' }, { code: 0, stdout: id }), { repo: 'o/r', number: 7 })).toBeNull()
    expect(await patchIdOfPullRequest(runnerFor({ code: 0, stdout: 'd' }, { code: 1, stdout: id }), { repo: 'o/r', number: 7 })).toBeNull()
    expect(await patchIdOfPullRequest(runnerFor({ code: 0, stdout: 'd' }, { code: 0, stdout: 'not-a-hash' }), { repo: 'o/r', number: 7 })).toBeNull()
    expect(await patchIdOfPullRequest({ run: async () => { throw new Error('spawn gh ENOENT') } }, { repo: 'o/r', number: 7 })).toBeNull()
  })
})

describe('process runner stdin', () => {
  it('writes `stdin` to the child, which is how a diff reaches `git patch-id`', async () => {
    const out = await createProcessRunner().run([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'diff --git a b\n', timeoutMs: 10_000 })
    expect(out).toMatchObject({ code: 0, stdout: 'diff --git a b\n' })
  })
})

describe('definition of done with verdict levels', () => {
  const config = parseLoopConfigText(readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person'))
  const contract = { intent: 'x', scope: { inScope: [], outOfScope: [] }, outcomes: [{ id: 'o1', description: 'one', check: { kind: 'command', command: 'pnpm test' } }, { id: 'o2', description: 'two', check: { kind: 'manual' } }], ambiguities: [], hitl: [], touchpoints: [], risks: [] } as never
  const proof = (id: string, verdict: string, extra: Record<string, unknown> = {}) => ({ id, status: verdict === 'failed' || verdict === 'blocked' ? 'failed' : 'passed', verdict, evidence: id, ...extra }) as never

  it('reads a level written by the worker, and the legacy status when there is none', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.ak-loop'), { recursive: true })
    writeFileSync(join(dir, config.dod.evidenceFile), JSON.stringify({ project: [], outcomes: [{ id: 'a', verdict: 'live-verified', evidence: 'e' }, { id: 'b', status: 'passed' }, { id: 'c', verdict: 'blocked' }, { id: 'd', status: 'failed', verdict: 'live-verified' }, { id: 'e', verdict: 'nonsense' }] }))
    expect(readDodEvidence(dir, config).outcomes).toEqual([
      { id: 'a', status: 'passed', evidence: 'e', verdict: 'live-verified' },
      { id: 'b', status: 'passed', evidence: '' },
      { id: 'c', status: 'failed', evidence: '', verdict: 'blocked' },
      { id: 'd', status: 'failed', evidence: '', verdict: 'live-verified' },
    ])
  })

  it('puts each item at its level, blocked apart from failed, and below-minimum apart from proven', () => {
    const assessed = assessDod({ config, contract, evidence: { project: [], outcomes: [proof('o1', 'type-check-only'), proof('o2', 'blocked')] }, minVerdict: 'unit-verified' })
    expect(assessed.lines.map((line) => [line.id, line.status, line.verdict])).toEqual([['o1', 'proven', 'type-check-only'], ['o2', 'blocked', 'blocked']])
    expect(assessed).toMatchObject({ complete: false, below: ['o1'], blocked: ['o2'], failed: [], missing: [] })
  })

  it('treats a legacy passed proof as unit-verified and an item without a proof as having no level', () => {
    const legacy = assessDod({ config, contract, evidence: { project: [], outcomes: [{ id: 'o1', status: 'passed', evidence: 'x' }] }, minVerdict: 'unit-verified' })
    expect(legacy.lines.map((line) => line.verdict)).toEqual(['unit-verified', null])
    expect(legacy).toMatchObject({ complete: false, missing: ['o2'], below: [] })
  })

  it('is complete when every item meets the minimum, and has no floor when none is given', () => {
    const evidence = { project: [], outcomes: [proof('o1', 'unit-verified'), proof('o2', 'live-verified')] }
    expect(assessDod({ config, contract, evidence, minVerdict: 'unit-verified' }).complete).toBe(true)
    expect(assessDod({ config, contract, evidence, minVerdict: 'live-verified' })).toMatchObject({ complete: false, below: ['o1'] })
    expect(assessDod({ config, contract, evidence: { project: [], outcomes: [proof('o1', 'type-check-only'), proof('o2', 'type-check-only')] } }).complete).toBe(true)
  })
})
