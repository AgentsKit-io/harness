import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReviewArgv, parseReviewGaps, runCodeReview, type CodeReviewInput, type CodeReviewOutcome, type ReviewFinding } from '../src/adapters/code-review.js'
import type { CommandRunner } from '../src/adapters/command.js'
import { deliveryStatePath, readDeliveryState, retryReview } from '../src/loop/deliver.js'
import { writeJsonAtomic } from '../src/loop/fs-atomic.js'
import { acceptGaps, decideConvergence, renderLeftoversBody, reviewWithRetries } from '../src/loop/review-resilience.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'review-resilience-')); dirs.push(dir); return dir }

const finding = (severity: ReviewFinding['severity'], category: string | null = 'tests', title = 't'): ReviewFinding => ({ severity, file: 'a.ts', line: 1, title, detail: '', category })
const input = (resultFile: string): CodeReviewInput => ({ cli: 'agentskit-review', repo: 'org/repo', baseBranch: 'main', number: 7, provider: 'codex-cli', model: 'm1', profile: 'fast', votes: 1, minSeverity: 'med', deadlineMs: 60_000, maxCalls: 10, post: false, resultFile })

describe('stop rule', () => {
  it('converges after 2 rounds when checks are green and only medium/low findings remain', () => {
    expect(decideConvergence({ rounds: 2, checksGreen: true, findings: [finding('med'), finding('nit')] }).converge).toBe(true)
  })
  it('keeps asking before 2 rounds, on red checks, and for high / blocker / correctness / security findings', () => {
    expect(decideConvergence({ rounds: 1, checksGreen: true, findings: [finding('med')] }).converge).toBe(false)
    expect(decideConvergence({ rounds: 3, checksGreen: false, findings: [finding('med')] }).converge).toBe(false)
    expect(decideConvergence({ rounds: 2, checksGreen: true, findings: [finding('med'), finding('high')] }).converge).toBe(false)
    expect(decideConvergence({ rounds: 2, checksGreen: true, findings: [finding('blocker')] }).converge).toBe(false)
    expect(decideConvergence({ rounds: 2, checksGreen: true, findings: [finding('med', 'Correctness')] }).converge).toBe(false)
    expect(decideConvergence({ rounds: 2, checksGreen: true, findings: [finding('med', 'security')] }).converge).toBe(false)
  })
  it('lists every leftover and links the PR in the issue body', () => {
    const body = renderLeftoversBody({ repo: 'org/repo', pr: 9, head: 'abcdef1234', findings: [finding('med', 'tests', 'weak assertion'), finding('nit', null, 'naming')] })
    expect(body).toContain('weak assertion')
    expect(body).toContain('naming')
    expect(body).toContain('Linked PR: #9')
  })
})

describe('failing review report', () => {
  it('parses the files a review could not cover and why', () => {
    expect(parseReviewGaps({ review: { incompleteFiles: [{ file: 'e2e/a.spec.ts', reason: 'lens returned empty output' }, { path: 'e2e/b.spec.ts', error: 'file too large (3000 lines)' }, { file: 'c.ts', message: 'analysis tokens budget exceeded' }, 'd.ts'] } }).map((gap) => [gap.file, gap.reason])).toEqual([['e2e/a.spec.ts', 'empty-output'], ['e2e/b.spec.ts', 'size'], ['c.ts', 'limit'], ['d.ts', 'unknown']])
    expect(parseReviewGaps({ findings: [] })).toEqual([])
  })

  it('names the failed file and the reason in the incomplete summary', async () => {
    const dir = tmp()
    const resultFile = join(dir, 'r.json')
    const runner: CommandRunner = { run: async () => { writeFileSync(resultFile, JSON.stringify({ findings: [], incomplete: true, incompleteFiles: [{ file: 'e2e/a.spec.ts', reason: 'empty output' }] })); return { code: 2, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } }
    const outcome = await runCodeReview(runner, input(resultFile))
    expect(outcome.status).toBe('incomplete')
    expect(outcome.summary).toContain('e2e/a.spec.ts (empty-output: empty output)')
    expect(outcome.gaps).toHaveLength(1)
  })

  it('passes a slice to the review CLI as --file / --lines', () => {
    const argv = buildReviewArgv({ ...input('/tmp/x.json'), files: [{ path: 'e2e/a.spec.ts', range: [1, 800] }, { path: 'b.ts' }] })
    expect(argv.join(' ')).toContain('--file e2e/a.spec.ts --lines 1-800 --file b.ts')
  })
})

const outcome = (over: Partial<CodeReviewOutcome>): CodeReviewOutcome => ({ status: 'clean', exitCode: 0, findings: [], blocking: [], summary: '', provider: 'codex-cli', model: 'm1', resultParsed: true, rawTail: '', usage: { providerCalls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }, gaps: [], ...over })

describe('reviewWithRetries', () => {
  const gap = (file: string, reason: 'size' | 'empty-output' | 'limit' = 'empty-output') => ({ file, reason, detail: '' })
  const run = (script: (call: CodeReviewInput) => CodeReviewOutcome) => { const calls: CodeReviewInput[] = []; return { calls, run: async (call: CodeReviewInput) => { calls.push(call); return script(call) } } }

  it('retries a failed file alone, then with another model, and stops at the first that covers it', async () => {
    const fake = run((call) => !call.files ? outcome({ status: 'incomplete', exitCode: 2, gaps: [gap('e2e/a.spec.ts')] }) : call.model === 'm2' ? outcome({ findings: [finding('med')], blocking: [finding('med')], status: 'findings' }) : outcome({ status: 'incomplete', gaps: [gap('e2e/a.spec.ts')] }))
    const result = await reviewWithRetries({} as CommandRunner, input('/tmp/r.json'), { run: fake.run, fallback: { provider: 'claude-cli', model: 'm2' } })
    expect(fake.calls.map((call) => [call.files?.[0]?.path ?? 'all', call.model])).toEqual([['all', 'm1'], ['e2e/a.spec.ts', 'm1'], ['e2e/a.spec.ts', 'm2']])
    expect(fake.calls[2]?.provider).toBe('claude-cli')
    expect(result.status).toBe('findings')
    expect(result.gaps).toEqual([])
  })

  it('does not fail the whole review for one file: recovered files count, a clean retry makes it clean', async () => {
    const fake = run((call) => !call.files ? outcome({ status: 'incomplete', exitCode: 2, gaps: [gap('a.ts'), gap('b.ts')] }) : outcome({}))
    const result = await reviewWithRetries({} as CommandRunner, input('/tmp/r.json'), { run: fake.run })
    expect(result.status).toBe('clean')
    expect(result.usage.providerCalls).toBe(3)
  })

  it('reviews a very large file in chunks', async () => {
    const fake = run((call) => !call.files ? outcome({ status: 'incomplete', exitCode: 2, gaps: [gap('e2e/big.spec.ts', 'size')] }) : outcome({}))
    const result = await reviewWithRetries({} as CommandRunner, input('/tmp/r.json'), { run: fake.run, chunkLines: 800, lineCount: () => 2000 })
    expect(fake.calls.slice(1).map((call) => call.files?.[0]?.range)).toEqual([[1, 800], [801, 1600], [1601, 2000]])
    expect(result.status).toBe('clean')
  })

  it('stays incomplete and names what is still uncovered after the retries', async () => {
    const fake = run((call) => outcome({ status: 'incomplete', exitCode: 2, gaps: [gap(call.files?.[0]?.path ?? 'a.ts')] }))
    const result = await reviewWithRetries({} as CommandRunner, input('/tmp/r.json'), { run: fake.run, fallback: { provider: 'claude-cli', model: 'm2' } })
    expect(result.status).toBe('incomplete')
    expect(result.gaps.map((g) => g.file)).toEqual(['a.ts'])
    expect(result.summary).toContain('not reviewed: a.ts')
  })

  it('does not retry an incomplete review that named no file', async () => {
    const fake = run(() => outcome({ status: 'incomplete', exitCode: 2 }))
    await reviewWithRetries({} as CommandRunner, input('/tmp/r.json'), { run: fake.run })
    expect(fake.calls).toHaveLength(1)
  })
})

describe('review ran with gaps', () => {
  const gapped = outcome({ status: 'incomplete', gaps: [{ file: 'a.ts', reason: 'limit', detail: '' }] })
  it('is clean (listed) on a green PR with no blocking finding, not a hold', () => {
    const accepted = acceptGaps(gapped, true)
    expect(accepted.status).toBe('clean')
    expect(accepted.summary).toContain('review ran with gaps: a.ts')
    expect(accepted.gaps).toHaveLength(1)
  })
  it('stays incomplete on red checks, with blocking findings, or when no file was named', () => {
    expect(acceptGaps(gapped, false).status).toBe('incomplete')
    expect(acceptGaps({ ...gapped, blocking: [finding('high')] }, true).status).toBe('incomplete')
    expect(acceptGaps({ ...gapped, gaps: [] }, true).status).toBe('incomplete')
    expect(acceptGaps({ ...gapped, resultParsed: false }, true).status).toBe('incomplete')
  })
})

describe('retryReview', () => {
  const seed = (stateDir: string, issue: string, state: Record<string, unknown>): void => {
    mkdirSync(join(stateDir, 'issues', issue), { recursive: true })
    writeJsonAtomic(deliveryStatePath(stateDir, issue), state)
  }
  const base = { prNumber: 283, fixRounds: 0, nudges: [], handoffs: [], finishedAt: null, finalOutcome: null }

  it('drops incomplete reviews and the hold of an intake PR, keeping complete ones', () => {
    const stateDir = tmp()
    seed(stateDir, 'pr-283', { ...base, issue: 'pr-283', heldFor: 'h2', finalOutcome: 'held', finishedAt: '2026-10-25T00:00:00Z', reviews: { h1: { status: 'clean', at: 'x', provider: 'p', model: 'm', blocking: 0, attempts: 1 }, h2: { status: 'incomplete', at: 'x', provider: 'p', model: 'm', blocking: 0, attempts: 2 } } })
    const result = retryReview({ stateDir } as never, 283)
    expect(result).toEqual({ issue: 'pr-283', dropped: ['h2'] })
    const state = readDeliveryState(stateDir, 'pr-283')
    expect(Object.keys(state.reviews)).toEqual(['h1'])
    expect(state.heldFor).toBeNull()
    expect(state.finalOutcome).toBeNull()
    expect(state.finishedAt).toBeNull()
  })

  it('refuses a PR with nothing to retry', () => {
    const stateDir = tmp()
    seed(stateDir, 'pr-283', { ...base, issue: 'pr-283', heldFor: null, reviews: {} })
    expect(() => retryReview({ stateDir } as never, 283)).toThrow(/nothing to retry|no incomplete review/i)
    expect(() => retryReview({ stateDir } as never, 999)).toThrow(/No delivery recorded/)
  })
})
