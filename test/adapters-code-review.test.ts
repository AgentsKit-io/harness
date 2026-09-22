import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atLeast, buildReviewArgv, parseReviewEvidence, parseReviewResult, renderFindingsForWorker, runCodeReview, severityRank } from '../src/index.js'
import type { CodeReviewInput, CommandResult, CommandRunner, ReviewFinding } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('severityRank / atLeast', () => {
  it('ranks severities weakest-first and treats an unknown severity as the weakest', () => {
    expect(severityRank('nit')).toBe(0)
    expect(severityRank('blocker')).toBe(3)
    expect(severityRank('unknown-severity')).toBe(0)
  })

  it('atLeast is false for an unrecognised severity even against the lowest floor', () => {
    expect(atLeast('nit', 'nit')).toBe(true)
    expect(atLeast('high', 'med')).toBe(true)
    expect(atLeast('nit', 'high')).toBe(false)
    expect(atLeast('unknown-severity', 'nit')).toBe(false)
  })
})

describe('parseReviewResult', () => {
  it('reads findings from a top-level findings array, and normalizes common severity synonyms', () => {
    const result = parseReviewResult({ findings: [{ severity: 'critical', title: 't1' }, { severity: 'major' }, { severity: 'minor' }, { severity: 'warning' }, { severity: 'note' }, { severity: 'medium' }] })
    expect(result.findings.map((f) => f.severity)).toEqual(['blocker', 'high', 'med', 'high', 'med', 'med'])
  })

  it('falls back to a verifiedFindings array, and unwraps a nested review object', () => {
    expect(parseReviewResult({ verifiedFindings: [{ severity: 'blocker', title: 't' }] }).findings).toHaveLength(1)
    expect(parseReviewResult({ review: { findings: [{ severity: 'blocker', title: 't' }] } }).findings).toHaveLength(1)
  })

  it('reads location from a nested location object or flat fields, preferring location.line/startLine', () => {
    const nested = parseReviewResult({ findings: [{ severity: 'high', location: { file: 'a.ts', line: 10 } }] }).findings[0]
    expect(nested).toMatchObject({ file: 'a.ts', line: 10 })
    const startLine = parseReviewResult({ findings: [{ severity: 'high', location: { path: 'b.ts', startLine: 5 } }] }).findings[0]
    expect(startLine).toMatchObject({ file: 'b.ts', line: 5 })
    const flat = parseReviewResult({ findings: [{ severity: 'high', file: 'c.ts' }] }).findings[0]
    expect(flat).toMatchObject({ file: 'c.ts', line: null })
  })

  it('falls back through title/summary/message and rationale/suggestion/detail/description/body', () => {
    const bySummary = parseReviewResult({ findings: [{ severity: 'high', summary: 'from summary' }] }).findings[0]
    expect(bySummary?.title).toBe('from summary')
    const byMessage = parseReviewResult({ findings: [{ severity: 'high', message: 'from message' }] }).findings[0]
    expect(byMessage?.title).toBe('from message')
    const noTitle = parseReviewResult({ findings: [{ severity: 'high' }] }).findings[0]
    expect(noTitle?.title).toBe('finding')
    const detailed = parseReviewResult({ findings: [{ severity: 'high', rationale: 'why', suggestion: 'fix it' }] }).findings[0]
    expect(detailed?.detail).toBe('why\nSuggestion: fix it')
  })

  it('reads category from category or lens, and returns null blocking/incomplete when absent or non-boolean', () => {
    expect(parseReviewResult({ findings: [{ severity: 'high', lens: 'security' }] }).findings[0]?.category).toBe('security')
    expect(parseReviewResult({})).toMatchObject({ findings: [], blocking: null, incomplete: null })
    expect(parseReviewResult({ blocking: 'yes' as never })).toMatchObject({ blocking: null })
    expect(parseReviewResult({ blocking: true, incomplete: false })).toMatchObject({ blocking: true, incomplete: false })
  })

  it('tolerates a non-object, null, or array payload', () => {
    expect(parseReviewResult(null)).toEqual({ findings: [], blocking: null, incomplete: null })
    expect(parseReviewResult('nope')).toEqual({ findings: [], blocking: null, incomplete: null })
    expect(parseReviewResult([1, 2, 3])).toEqual({ findings: [], blocking: null, incomplete: null })
  })

  it('skips a non-object finding entry inside the findings array', () => {
    expect(parseReviewResult({ findings: [null, 'nope', { severity: 'high' }] }).findings).toHaveLength(1)
  })
})

const baseInput: CodeReviewInput = {
  cli: 'agentskit-review', repo: 'org/repo', number: 42, provider: 'codex', profile: 'strict', votes: 1,
  minSeverity: 'med', deadlineMs: 60_000, maxCalls: 10, post: false, resultFile: '/tmp/does-not-matter.json',
}

describe('parseReviewEvidence', () => {
  it('reads providerCalls and input/output tokens from evidence.usage', () => {
    const usage = parseReviewEvidence({ evidence: { providerCalls: 5, usage: { inputTokens: 1000, outputTokens: 200 } } })
    expect(usage).toEqual({ providerCalls: 5, inputTokens: 1000, outputTokens: 200, totalTokens: 1200 })
  })

  it('falls back to evidence.tokensUsed when usage does not break input/output apart', () => {
    const usage = parseReviewEvidence({ evidence: { providerCalls: 3, tokensUsed: 900 } })
    expect(usage).toEqual({ providerCalls: 3, inputTokens: null, outputTokens: null, totalTokens: 900 })
  })

  it('reads through a wrapping "review" key, same as parseReviewResult', () => {
    const usage = parseReviewEvidence({ review: { evidence: { providerCalls: 2 } } })
    expect(usage.providerCalls).toBe(2)
  })

  it('is all-null when there is no evidence at all, never throwing', () => {
    expect(parseReviewEvidence({})).toEqual({ providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null })
    expect(parseReviewEvidence(null)).toEqual({ providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null })
    expect(parseReviewEvidence('nope')).toEqual({ providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null })
  })
})

describe('buildReviewArgv', () => {
  it('includes optional flags only when provided', () => {
    const argv = buildReviewArgv(baseInput)
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--mode')
    expect(argv).not.toContain('--transport')
    expect(argv).not.toContain('--concurrency')
    expect(argv).not.toContain('--sarif')
    expect(argv).not.toContain('--post')
    const full = buildReviewArgv({ ...baseInput, model: 'gpt-5', mode: 'trusted-local', transport: 'headless', concurrency: 4, sarifFile: '/tmp/x.sarif', post: true })
    expect(full).toEqual(expect.arrayContaining(['--model', 'gpt-5', '--mode', 'trusted-local', '--transport', 'headless', '--concurrency', '4', '--sarif', '/tmp/x.sarif', '--post']))
  })

  it('omits --mode when mode is isolated (the CLI default)', () => {
    expect(buildReviewArgv({ ...baseInput, mode: 'isolated' })).not.toContain('--mode')
  })
})

const tempResultFile = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-code-review-')); cleanups.push(dir); return join(dir, 'result.json') }
const runner = (result: CommandResult): CommandRunner => ({ run: async () => result })
const cmd = (overrides: Partial<CommandResult> = {}): CommandResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, ...overrides })

describe('runCodeReview', () => {
  it('reports clean when the CLI exits 0 and the result file has no blocking findings', async () => {
    const resultFile = tempResultFile()
    writeFileSync(resultFile, JSON.stringify({ findings: [{ severity: 'nit', title: 'style nit' }] }))
    const outcome = await runCodeReview(runner(cmd({ code: 0 })), { ...baseInput, resultFile })
    expect(outcome).toMatchObject({ status: 'clean', exitCode: 0, resultParsed: true })
    expect(outcome.summary).toContain('clean at/above med')
  })

  it('reports findings when exit code is 1, even with no result file', async () => {
    const outcome = await runCodeReview(runner(cmd({ code: 1 })), { ...baseInput, resultFile: tempResultFile() })
    expect(outcome).toMatchObject({ status: 'findings', resultParsed: false })
  })

  it('reports findings when the result file has blocking findings, regardless of a clean exit code', async () => {
    const resultFile = tempResultFile()
    writeFileSync(resultFile, JSON.stringify({ findings: [{ severity: 'blocker', title: 'must fix' }] }))
    const outcome = await runCodeReview(runner(cmd({ code: 0 })), { ...baseInput, resultFile })
    expect(outcome.status).toBe('findings')
    expect(outcome.blocking).toHaveLength(1)
  })

  it('reports incomplete on timeout, exit code 2, null exit code, or an unexpected exit code', async () => {
    const input = { ...baseInput, resultFile: tempResultFile() }
    await expect(runCodeReview(runner(cmd({ timedOut: true })), input)).resolves.toMatchObject({ status: 'incomplete', exitCode: null })
    await expect(runCodeReview(runner(cmd({ code: 2 })), input)).resolves.toMatchObject({ status: 'incomplete' })
    await expect(runCodeReview(runner(cmd({ code: null })), input)).resolves.toMatchObject({ status: 'incomplete' })
    await expect(runCodeReview(runner(cmd({ code: 7 })), input)).resolves.toMatchObject({ status: 'incomplete' })
  })

  it('reports incomplete when the result file explicitly says incomplete, even on a clean exit', async () => {
    const resultFile = tempResultFile()
    writeFileSync(resultFile, JSON.stringify({ findings: [], incomplete: true }))
    const outcome = await runCodeReview(runner(cmd({ code: 0 })), { ...baseInput, resultFile })
    expect(outcome.status).toBe('incomplete')
  })

  it('treats an unparseable result file the same as a missing one (resultParsed: false)', async () => {
    const resultFile = tempResultFile()
    writeFileSync(resultFile, 'not json')
    const outcome = await runCodeReview(runner(cmd({ code: 0 })), { ...baseInput, resultFile })
    expect(outcome.resultParsed).toBe(false)
  })

  it('truncates rawTail to the last 800 characters of combined stderr+stdout', async () => {
    const outcome = await runCodeReview(runner(cmd({ code: 0, stdout: 'x'.repeat(1000) })), { ...baseInput, resultFile: tempResultFile() })
    expect(outcome.rawTail.length).toBeLessThanOrEqual(800)
  })

  it('carries provider-call/token usage from the result file, defaulting to all-null when absent', async () => {
    const resultFile = tempResultFile()
    writeFileSync(resultFile, JSON.stringify({ findings: [], evidence: { providerCalls: 4, usage: { inputTokens: 500, outputTokens: 100 } } }))
    const withUsage = await runCodeReview(runner(cmd({ code: 0 })), { ...baseInput, resultFile })
    expect(withUsage.usage).toEqual({ providerCalls: 4, inputTokens: 500, outputTokens: 100, totalTokens: 600 })

    const withoutResultFile = await runCodeReview(runner(cmd({ code: 1 })), { ...baseInput, resultFile: tempResultFile() })
    expect(withoutResultFile.usage).toEqual({ providerCalls: null, inputTokens: null, outputTokens: null, totalTokens: null })
  })

  it('passes cwd/env through to the runner when provided', async () => {
    const calls: unknown[] = []
    const trackingRunner: CommandRunner = { run: async (argv, options) => { calls.push(options); return cmd({ code: 0 }) } }
    await runCodeReview(trackingRunner, { ...baseInput, resultFile: tempResultFile(), cwd: '/work', env: { FOO: 'bar' } })
    expect(calls[0]).toMatchObject({ cwd: '/work', env: { FOO: 'bar' } })
  })
})

describe('renderFindingsForWorker', () => {
  const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({ severity: 'high', file: 'a.ts', line: 10, title: 't', detail: '', category: null, ...overrides })

  it('numbers findings and includes file:line when present, "general" otherwise', () => {
    const rendered = renderFindingsForWorker([finding(), finding({ file: null, line: null })])
    expect(rendered).toContain('1. [high] a.ts:10 — t')
    expect(rendered).toContain('2. [high] general — t')
  })

  it('appends detail only when it differs from the title, truncated to 400 chars', () => {
    const withDetail = renderFindingsForWorker([finding({ detail: 'longer explanation' })])
    expect(withDetail).toContain('longer explanation')
    const sameAsTitle = renderFindingsForWorker([finding({ detail: 't' })])
    expect(sameAsTitle).not.toContain('\n   t')
  })

  it('caps output at max findings and notes how many more exist', () => {
    const many = Array.from({ length: 20 }, (_, index) => finding({ title: `finding ${index}` }))
    const rendered = renderFindingsForWorker(many, 5)
    expect(rendered.split('\n').filter((line) => /^\d+\./.test(line))).toHaveLength(5)
    expect(rendered).toContain('… 15 more in the PR review.')
  })
})
