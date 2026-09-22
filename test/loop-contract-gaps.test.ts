import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractResetsAt, generateContract, parseLinearIssueDetail, parseStructuredContractOutput, readStoredContract, resolveDocContext, validateLoopConfig,
} from '../src/index.js'
import type { CommandResult, CommandRunner, RankedModel } from '../src/index.js'

describe('extractResetsAt', () => {
  it('parses a relative "resets in Nh" or "resets in Nm" phrase', () => {
    const now = new Date('2026-09-11T12:00:00.000Z')
    expect(extractResetsAt('You have hit your limit; resets in 3h', now)).toBe(new Date(now.getTime() + 3 * 3_600_000).toISOString())
    expect(extractResetsAt('resets in 45 minutes', now)).toBe(new Date(now.getTime() + 45 * 60_000).toISOString())
  })

  it('parses an absolute clock time and rolls over to the next day when it has already passed', () => {
    const now = new Date('2026-09-11T12:00:00.000Z')
    const resetsAt = extractResetsAt('resets 10:40pm (America/Sao_Paulo)', now)
    expect(resetsAt).not.toBeNull()
    const parsed = new Date(resetsAt!)
    expect(parsed.getHours()).toBe(22)
    expect(parsed.getMinutes()).toBe(40)

    const alreadyPassed = new Date('2026-09-11T23:00:00.000Z')
    const rolledOver = extractResetsAt('resets at 10:40pm', alreadyPassed)
    expect(new Date(rolledOver!).getTime()).toBeGreaterThan(alreadyPassed.getTime())
  })

  it('handles 12am/12pm correctly', () => {
    const now = new Date('2026-09-11T00:00:00.000Z')
    const noon = extractResetsAt('resets at 12:00pm', now)
    expect(new Date(noon!).getHours()).toBe(12)
    const midnight = extractResetsAt('resets at 12:00am', new Date('2026-09-11T01:00:00.000Z'))
    expect(new Date(midnight!).getHours()).toBe(0)
  })

  it('returns null when nothing matches', () => {
    expect(extractResetsAt('no timing information here')).toBeNull()
  })
})

describe('readStoredContract resilience', () => {
  it('returns null for a corrupt contract.json instead of throwing', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-contract-gaps-'))
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(stateDir, 'issues', 'ENG-1', 'contract.json'), 'not-json', 'utf8')
    expect(readStoredContract(stateDir, 'ENG-1')).toBeNull()
  })

  it('returns null when the stored issue identifier does not match', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'loop-contract-gaps-'))
    mkdirSync(join(stateDir, 'issues', 'ENG-1'), { recursive: true })
    writeFileSync(join(stateDir, 'issues', 'ENG-1', 'contract.json'), JSON.stringify({ schemaVersion: 1, issue: 'ENG-2' }), 'utf8')
    expect(readStoredContract(stateDir, 'ENG-1')).toBeNull()
  })
})

describe('resolveDocContext resilience', () => {
  it('returns [] when max is not positive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-contract-gaps-'))
    expect(await resolveDocContext(root, 'q', 0)).toEqual([])
  })

  it('returns [] when the index file does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-contract-gaps-'))
    expect(await resolveDocContext(root, 'q', 5)).toEqual([])
  })

  it('returns [] when the index exists but resolving throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-contract-gaps-'))
    mkdirSync(join(root, '.doc-bridge'), { recursive: true })
    writeFileSync(join(root, '.doc-bridge', 'index.json'), 'not-json', 'utf8')
    expect(await resolveDocContext(root, 'q', 5)).toEqual([])
  })
})

const config = validateLoopConfig({
  project: { name: 'demo', repo: 'org/demo' },
  linear: { workspaceId: 'ws-1', teamKey: 'ENG', person: 'person' },
  models: {
    orchestrator: [['codex/gpt-5.6-sol']],
    reviewer: [['codex/gpt-5.6-sol']],
    builder: [['codex/gpt-5.6-sol']],
    watcher: [['codex/gpt-5.6-sol']],
    providers: { codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model} --full-auto', headless: ['codex', 'exec', '{prompt}', '-m', '{model}'] } },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

const issue = parseLinearIssueDetail({
  issue: { id: 'i1', identifier: 'ENG-1', title: 'Title', url: 'https://linear.app/x', state: 'Todo', updatedAt: '2026-01-01T00:00:00.000Z' },
  description: 'do the thing',
  comments: [],
})

const candidate = (overrides: Partial<RankedModel> = {}): RankedModel => ({ provider: 'codex', model: 'gpt-5.6-sol', tier: 0, orcaAgent: 'codex', tui: 'codex -m gpt-5.6-sol', remainingPercent: null, reason: 'yaml tier 1', preferenceIndex: 0, effort: 'medium', ...overrides })

describe('generateContract', () => {
  it('rejects when there are no candidates and no orchestrator fallback', async () => {
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
    await expect(generateContract({ runner, config, root: '/tmp', issue, candidates: [], references: [] })).rejects.toThrow(/No orchestrator provider/)
  })

  it('calls onProviderCall once per attempt, success or failure, with timing/size — never a token or provider secret', async () => {
    const calls: Array<{ provider: string; model: string; exitCode: number | null; timedOut: boolean }> = []
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: `<<<LOOP_CONTRACT\n${JSON.stringify({ intent: 'x', scope: { inScope: ['a'] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] })}\nLOOP_CONTRACT>>>`, stderr: '', timedOut: false, durationMs: 42 }) }
    await generateContract({ runner, config, root: '/tmp', issue, candidates: [candidate()], references: [], onProviderCall: (event) => { calls.push(event) } })
    expect(calls).toEqual([{ provider: 'codex', model: candidate().model, effort: candidate().effort, durationMs: 42, exitCode: 0, timedOut: false, stdoutBytes: expect.any(Number), stderrBytes: expect.any(Number) }])
  })

  it('reports a missing headless argv template as a failure and exhausts all candidates', async () => {
    const noHeadlessConfig = validateLoopConfig({ ...config, models: { ...config.models, providers: { codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model}' } } } })
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) }
    await expect(generateContract({ runner, config: noHeadlessConfig, root: '/tmp', issue, candidates: [candidate()], references: [] })).rejects.toThrow(/no headless argv template/)
  })

  it('calls onProviderFailure for an auth-classified failure and falls through to the next candidate', async () => {
    const failures: string[] = []
    let calls = 0
    const runner: CommandRunner = {
      run: async (): Promise<CommandResult> => {
        calls += 1
        if (calls === 1) return { code: 1, stdout: 'Failed to authenticate: OAuth session expired', stderr: '', timedOut: false, durationMs: 1 }
        return { code: 0, stdout: `<<<LOOP_CONTRACT\n${JSON.stringify({ intent: 'x', scope: { inScope: ['a'] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] })}\nLOOP_CONTRACT>>>`, stderr: '', timedOut: false, durationMs: 1 }
      },
    }
    const result = await generateContract({
      runner, config, root: '/tmp', issue,
      candidates: [candidate({ provider: 'codex', model: 'first' }), candidate({ provider: 'codex', model: 'second' })],
      references: [],
      onProviderFailure: (failure) => { failures.push(failure.kind) },
    })
    expect(failures).toEqual(['auth'])
    expect(result.model).toBe('second')
  })

  it('does not call onProviderFailure for an "other"-classified failure', async () => {
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 1, stdout: 'some unexpected tool crash', stderr: '', timedOut: false, durationMs: 1 }) }
    let called = false
    await expect(generateContract({ runner, config, root: '/tmp', issue, candidates: [candidate()], references: [], onProviderFailure: () => { called = true } })).rejects.toThrow(/Contract generation failed/)
    expect(called).toBe(false)
  })

  it('records an "output" failure when the response has no parseable contract block, and fails after exhausting candidates', async () => {
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: 'no contract markers here', stderr: '', timedOut: false, durationMs: 1 }) }
    await expect(generateContract({ runner, config, root: '/tmp', issue, candidates: [candidate()], references: [] })).rejects.toThrow(/\[output\]/)
  })

  it('falls back to orchestrator.selected when candidates is omitted', async () => {
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: `<<<LOOP_CONTRACT\n${JSON.stringify({ intent: 'x', scope: { inScope: ['a'] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] })}\nLOOP_CONTRACT>>>`, stderr: '', timedOut: false, durationMs: 1 }) }
    const result = await generateContract({ runner, config, root: '/tmp', issue, orchestrator: { role: 'orchestrator', selected: candidate(), skipped: [] }, references: [] })
    expect(result.provider).toBe('codex')
  })

  // Regression: a provider whose model finishes plan-mode reasoning with the contract already "frozen" internally
  // (e.g. via a denied ExitPlanMode call) can reply with only a prose summary and never repeat the JSON between
  // markers — the run still exits 0 with real output, so it read as "no contract block" even though nothing failed.
  // `structuredOutputFlag` routes around the model's free-text reply entirely: the contract comes back through the
  // CLI's own `--json-schema`-validated `structured_output` field.
  const structuredConfig = validateLoopConfig({
    ...config,
    models: {
      ...config.models,
      providers: { codex: { ...config.models.providers['codex']!, structuredOutputFlag: ['--output-format', 'json', '--json-schema', '{schema}'] } },
    },
  })

  it('reads the contract from structured_output when the provider declares structuredOutputFlag, ignoring a free-text reply that never repeats it', async () => {
    const envelope = JSON.stringify({ type: 'result', result: 'The contract is frozen above.', structured_output: { intent: 'x', scope: { inScope: ['a'] } } })
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: envelope, stderr: '', timedOut: false, durationMs: 1 }) }
    const result = await generateContract({ runner, config: structuredConfig, root: '/tmp', issue, candidates: [candidate()], references: [] })
    expect(result.contract).toMatchObject({ intent: 'x', scope: { inScope: ['a'] } })
  })

  it('falls back to marker-scanning envelope.result when structured_output is absent', async () => {
    const envelope = JSON.stringify({ type: 'result', result: `<<<LOOP_CONTRACT\n${JSON.stringify({ intent: 'y', scope: { inScope: ['b'] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] })}\nLOOP_CONTRACT>>>` })
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: envelope, stderr: '', timedOut: false, durationMs: 1 }) }
    const result = await generateContract({ runner, config: structuredConfig, root: '/tmp', issue, candidates: [candidate()], references: [] })
    expect(result.contract.intent).toBe('y')
  })

  it('rejects a structured_output payload that fails contract validation', async () => {
    const envelope = JSON.stringify({ type: 'result', result: '', structured_output: { intent: '', scope: { inScope: [] } } })
    const runner: CommandRunner = { run: async (): Promise<CommandResult> => ({ code: 0, stdout: envelope, stderr: '', timedOut: false, durationMs: 1 }) }
    await expect(generateContract({ runner, config: structuredConfig, root: '/tmp', issue, candidates: [candidate()], references: [] })).rejects.toThrow(/Structured contract failed validation/)
  })
})

describe('parseStructuredContractOutput', () => {
  it('falls back to marker-scanning raw stdout when the envelope is not JSON', () => {
    const raw = `<<<LOOP_CONTRACT\n${JSON.stringify({ intent: 'z', scope: { inScope: ['c'] }, outcomes: [], ambiguities: [], touchpoints: [], risks: [] })}\nLOOP_CONTRACT>>>`
    expect(parseStructuredContractOutput(raw).intent).toBe('z')
  })
})
