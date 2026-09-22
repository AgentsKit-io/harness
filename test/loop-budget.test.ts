import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRoutingPolicy, composeLoopConfig, issueBudget, issueSpend, loadLoopConfig, modelForChange, rankModels, withinProviderBudget } from '../src/index.js'
import type { LoopConfig, ProviderAvailability, RankedModel } from '../src/index.js'

const exampleYaml = readFileSync(join(process.cwd(), 'loop.config.example.yaml'), 'utf8').replace('person: my-linear-display-name', 'person: person')
const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// The overlay rides in the machine layer, so the example config stays a single YAML mapping.
const config = (overlay = ''): LoopConfig => composeLoopConfig({ text: exampleYaml, ...(overlay ? { localText: overlay } : {}) })

const provider = (id: string, usedPercent: number | null): ProviderAvailability => ({
  id, available: true, reasons: [], bin: id, auth: 'subscription',
  usage: { status: usedPercent === null ? 'unknown' : 'ok', error: null, exhausted: false, resetsAt: null, hasAuth: true, windows: usedPercent === null ? [] : [{ kind: 'session', usedPercent, windowMinutes: null, resetsAt: null }] },
} as unknown as ProviderAvailability)

const model = (providerId: string, name: string, tier: number, preferenceIndex: number, remainingPercent: number | null): RankedModel =>
  ({ provider: providerId, model: name, tier, preferenceIndex, remainingPercent, reason: `yaml tier ${tier + 1}`, orcaAgent: providerId, tui: '', effort: 'medium' } as RankedModel)

describe('the per-provider budget', () => {
  it('leaves the rest of the window for the human, and never judges an unknown one', () => {
    const budgeted = config('budget:\n  perProvider: 80\n')
    const result = withinProviderBudget(budgeted, [provider('claude', 85), provider('codex', 40), provider('grok', null)])
    expect(result.map((item) => item.available)).toEqual([false, true, true])
    expect(result[0]?.reasons.at(-1)).toContain('ceiling 80%')
    // 100 (the default) changes nothing at all.
    expect(withinProviderBudget(config(), [provider('claude', 99)])[0]?.available).toBe(true)
  })

  it('keeps an over-budget provider out of the ranking entirely', () => {
    const budgeted = config('budget:\n  perProvider: 50\n')
    const ranked = rankModels(budgeted, 'builder', [provider('claude', 90), provider('codex', 10)])
    expect(ranked.every((item) => item.provider !== 'claude')).toBe(true)
  })
})

describe('routing policy', () => {
  const candidates = [model('claude', 'opus', 0, 0, 20), model('codex', 'sol', 0, 1, 70), model('grok', 'fast', 2, 2, 95)]

  it('changes nothing under quality-first', () => {
    expect(applyRoutingPolicy(config(), candidates)).toEqual(candidates)
  })

  it('spreads by remaining window under usage-balanced', () => {
    const ordered = applyRoutingPolicy(config('models:\n  routing:\n    policy: usage-balanced\n'), candidates)
    expect(ordered.map((item) => item.model)).toEqual(['fast', 'sol', 'opus'])
    expect(ordered[0]?.reason).toContain('usage-balanced (95% left)')
  })

  it('under cost-first prefers declared cost, and the last tier when nothing is declared', () => {
    const byTier = applyRoutingPolicy(config('models:\n  routing:\n    policy: cost-first\n'), candidates)
    expect(byTier.map((item) => item.model)).toEqual(['fast', 'opus', 'sol'])
    expect(byTier[0]?.reason).toContain('tier 3')

    const declared = applyRoutingPolicy(config('models:\n  routing:\n    policy: cost-first\n  cost:\n    codex/sol: 1\n    claude/opus: 9\n'), candidates)
    expect(declared.map((item) => item.model)).toEqual(['sol', 'opus', 'fast'])
    expect(declared[0]?.reason).toContain('cost 1')
  })
})

describe('the per-issue ceiling', () => {
  const setup = (overlay: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentskit-budget-')); cleanups.push(dir)
    writeFileSync(join(dir, 'loop.config.yaml'), exampleYaml)
    writeFileSync(join(dir, 'loop.config.local.yaml'), overlay)
    const loaded = loadLoopConfig(join(dir, 'loop.config.yaml'), { AK_HARNESS_NO_GLOBAL: '1' })
    mkdirSync(loaded.stateDir, { recursive: true })
    const event = (payload: Record<string, unknown>): void => appendFileSync(join(loaded.stateDir, 'events.ndjson'), `${JSON.stringify({ at: '2026-09-19T12:00:00.000Z', type: 'pr.reviewed', ...payload })}\n`)
    return { loaded, event }
  }

  it('adds up what the loop already spent on one issue', () => {
    const { loaded, event } = setup('budget:\n  perIssueTokens: 100\n')
    event({ issue: 'ENG-1', totalTokens: 40 })
    event({ issue: 'ENG-1', inputTokens: 20, outputTokens: 10 })
    event({ issue: 'ENG-2', totalTokens: 500 })
    expect(issueSpend(loaded.stateDir, 'ENG-1')).toEqual({ issue: 'ENG-1', totalTokens: 70, calls: 2 })
    expect(issueBudget(loaded.config, loaded.stateDir, 'ENG-1').exceeded).toBe(false)
    event({ issue: 'ENG-1', totalTokens: 50 })
    const verdict = issueBudget(loaded.config, loaded.stateDir, 'ENG-1')
    expect(verdict).toMatchObject({ exceeded: true, spent: 120, ceiling: 100 })
    expect(verdict.reason).toContain('120 of 100 tokens')
  })

  it('is off by default: no ceiling means no verdict to trip over', () => {
    const { loaded, event } = setup('linear:\n  teamKey: ENG\n')
    event({ issue: 'ENG-1', totalTokens: 10_000_000 })
    expect(issueBudget(loaded.config, loaded.stateDir, 'ENG-1')).toMatchObject({ exceeded: false, ceiling: 0 })
  })
})

describe('choosing the model from the change', () => {
  const candidates = [model('claude', 'opus', 0, 0, 50), model('grok', 'fast', 2, 2, 90)]

  it('sends a small or documentation-only change to the cheapest candidate', () => {
    expect(modelForChange({ candidates, files: ['README.md', 'docs/a.md'], changedLines: 800, smallChangeLines: 50, criticalPaths: [] })).toMatchObject({ model: candidates[1], reason: 'documentation-only change' })
    expect(modelForChange({ candidates, files: ['src/a.ts'], changedLines: 20, smallChangeLines: 50, criticalPaths: [] }).model?.model).toBe('fast')
  })

  it('keeps the strongest for a large change or a critical path', () => {
    expect(modelForChange({ candidates, files: ['src/a.ts'], changedLines: 400, smallChangeLines: 50, criticalPaths: [] }).model?.model).toBe('opus')
    const critical = modelForChange({ candidates, files: ['src/security/token.ts'], changedLines: 3, smallChangeLines: 50, criticalPaths: ['src/security/'] })
    expect(critical.model?.model).toBe('opus')
    expect(critical.reason).toContain('critical path')
  })

  it('returns nothing to choose when there is nothing available', () => {
    expect(modelForChange({ candidates: [], files: [], changedLines: 0, smallChangeLines: 50, criticalPaths: [] })).toEqual({ model: null, reason: 'no candidate available' })
  })

  it('sizes a fix round off the incremental diff, but still checks criticalPaths against every file the PR touches', () => {
    // This round's own diff is a tiny, non-critical doc tweak...
    const sized = modelForChange({ candidates, files: ['README.md'], allFiles: ['README.md', 'src/security/token.ts'], changedLines: 2, smallChangeLines: 50, criticalPaths: ['src/security/'] })
    // ...but an earlier round touched a critical path, and allFiles (the whole PR) still carries it.
    expect(sized.model?.model).toBe('opus')
    expect(sized.reason).toContain('critical path')
  })

  it('without allFiles, criticalPaths falls back to checking files (unchanged pre-existing behaviour)', () => {
    const sized = modelForChange({ candidates, files: ['README.md'], changedLines: 2, smallChangeLines: 50, criticalPaths: ['src/security/'] })
    expect(sized.model?.model).toBe('fast')
  })
})
