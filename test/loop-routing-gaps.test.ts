import { describe, expect, it } from 'vitest'
import type { ProviderAvailability, ProviderUsage } from '../src/adapters/providers.js'
import { LoopConfigSchema } from '../src/loop/config.js'
import { rankModels, routeAllRoles, selectModel } from '../src/loop/routing.js'

const usage = (windows: { kind: string; usedPercent: number }[], exhausted = false): ProviderUsage => ({
  status: 'ok', error: null, windows: windows.map((window) => ({ ...window, windowMinutes: 60, resetsAt: null })), exhausted, resetsAt: null, hasAuth: true,
})

const avail = (id: string, usedPercent: number, available = true): ProviderAvailability => ({
  id, binary: `/bin/${id}`, hookState: 'installed', auth: 'ok', usage: usage([{ kind: 'weekly', usedPercent }], usedPercent >= 100), probe: 'skipped', coolingDownUntil: null,
  available: available && usedPercent < 100, reasons: usedPercent >= 100 ? ['usage exhausted'] : [],
})

const base = (routing: Record<string, unknown> = {}) => LoopConfigSchema.parse({
  project: { name: 'demo', repo: 'Acme/demo', stateDir: '.ak-loop' },
  linear: { workspaceId: 'ws', teamKey: 'ENG', person: 'alice' },
  models: {
    routing,
    orchestrator: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4.5']],
    reviewer: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4.5']],
    builder: [['codex/gpt-5.6-luna', 'claude/sonnet'], ['grok/grok-4.5']],
    watcher: [['claude/haiku'], ['grok/grok-4.5']],
    providers: {
      claude: { bin: 'claude', auth: 'subscription', tui: 'claude --model {model}', headless: ['claude', '-p', '{prompt}'] },
      codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model}', headless: ['codex', 'exec', '{prompt}'] },
      grok: { bin: 'grok', auth: 'subscription', tui: 'grok -m {model}', headless: ['grok', '-p', '{prompt}', '-m', '{model}'] },
      opencode: { bin: 'opencode', auth: 'subscription', tui: 'opencode -m {model}', headless: ['opencode', '-p', '{prompt}', '-m', '{model}'] },
    },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

describe('allowedProvider filtering', () => {
  it('excludes a provider named in excludeProviders even when it is available', () => {
    const config = base({ mode: 'tiers', excludeProviders: ['codex'] })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10), avail('claude', 10)])
    expect(decision.selected).toMatchObject({ provider: 'claude' })
    expect(decision.skipped.some((skip) => skip.reasons.includes('provider excluded by models.routing') && skip.ref.provider === 'codex')).toBe(true)
  })

  it('restricts candidates to includeProviders when non-empty', () => {
    const config = base({ mode: 'tiers', includeProviders: ['claude'] })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10), avail('claude', 10)])
    expect(decision.selected).toMatchObject({ provider: 'claude' })
    expect(decision.skipped.every((skip) => skip.ref.provider !== 'claude')).toBe(true)
  })
})

describe('availableFromTiers detection reasons', () => {
  it('reports "provider was not detected" when the provider never appears in the availability list', () => {
    const config = base({ mode: 'tiers' })
    const decision = selectModel(config, 'orchestrator', [avail('claude', 10)])
    const skip = decision.skipped.find((item) => item.ref.provider === 'codex')
    expect(skip?.reasons).toEqual(['provider was not detected'])
  })
})

describe('applyPin edge cases', () => {
  it('falls through to normal ranking when the pinned provider is unavailable and pinStrict is false', () => {
    const config = base({ mode: 'tiers', pin: { orchestrator: 'grok/grok-4.5' }, pinStrict: false })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10), avail('grok', 100)])
    expect(decision.selected).toMatchObject({ provider: 'codex' })
    expect(decision.skipped.some((skip) => skip.tier === -1 && skip.ref.provider === 'grok')).toBe(true)
  })

  it('returns null when the pinned provider is unavailable and pinStrict is true', () => {
    const config = base({ mode: 'tiers', pin: { orchestrator: 'grok/grok-4.5' }, pinStrict: true })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10), avail('grok', 100)])
    expect(decision.selected).toBeNull()
  })

  it('reports "pinned provider was not detected" when the pin references a provider absent from availability', () => {
    const config = base({ mode: 'tiers', pin: { orchestrator: 'grok/grok-4.5' } })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10)])
    expect(decision.skipped.find((skip) => skip.tier === -1)?.reasons).toEqual(['pinned provider was not detected'])
  })
})

describe('extraCandidates filtering', () => {
  it('ignores an extra candidate whose provider is excluded or unavailable', () => {
    const config = base({ mode: 'dynamic', excludeProviders: ['grok'] })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 10)], [{ provider: 'grok', model: 'grok-4.5' }, { provider: 'claude', model: 'opus' }])
    expect(decision.selected?.provider).not.toBe('grok')
  })

  it('ignores an extra candidate for a provider absent from the availability list', () => {
    const config = base({ mode: 'dynamic' })
    const decision = selectModel(config, 'orchestrator', [avail('codex', 90)], [{ provider: 'opencode', model: 'glm' }])
    expect(decision.selected?.provider).toBe('codex')
  })
})

describe('selectModel fallback branches across modes', () => {
  it('tiers mode falls back to an extra candidate when no YAML tier candidate is available', () => {
    const config = base({ mode: 'tiers' })
    const decision = selectModel(config, 'orchestrator', [avail('opencode', 10)], [{ provider: 'opencode', model: 'glm' }])
    expect(decision.selected).toMatchObject({ provider: 'opencode', reason: 'catalog' })
  })

  it('hybrid mode falls back to a catalog extra when every YAML tier is empty', () => {
    const config = base({ mode: 'hybrid' })
    const decision = selectModel(config, 'orchestrator', [avail('opencode', 10)], [{ provider: 'opencode', model: 'glm' }])
    expect(decision.selected).toMatchObject({ provider: 'opencode' })
    expect(decision.selected?.reason).toContain('hybrid catalog')
  })

  it('hybrid mode returns null when neither YAML tiers nor extras have anything available', () => {
    const config = base({ mode: 'hybrid' })
    const decision = selectModel(config, 'orchestrator', [])
    expect(decision.selected).toBeNull()
  })

  it('dynamic mode returns null when nothing is available at all', () => {
    const config = base({ mode: 'dynamic' })
    const decision = selectModel(config, 'orchestrator', [])
    expect(decision.selected).toBeNull()
  })
})

describe('routeAllRoles', () => {
  it('produces a decision for every model role', () => {
    const config = base({ mode: 'tiers' })
    const decisions = routeAllRoles(config, [avail('codex', 10), avail('claude', 10)])
    expect(Object.keys(decisions).sort()).toEqual(['builder', 'orchestrator', 'reviewer', 'watcher'])
    expect(decisions.orchestrator?.selected?.provider).toBe('codex')
  })

  it('passes extrasByRole through to the matching role only', () => {
    const config = base({ mode: 'dynamic' })
    const decisions = routeAllRoles(config, [avail('opencode', 10)], { builder: [{ provider: 'opencode', model: 'glm' }] })
    expect(decisions.builder?.selected?.provider).toBe('opencode')
    expect(decisions.orchestrator?.selected).toBeNull()
  })
})

describe('rankModels pin and mode ordering', () => {
  it('excludes a duplicate of the pinned model from the trailing ranked list', () => {
    const config = base({ mode: 'tiers', pin: { orchestrator: 'codex/gpt-5.6-sol' } })
    const ranked = rankModels(config, 'orchestrator', [avail('codex', 10), avail('claude', 10)])
    expect(ranked[0]).toMatchObject({ provider: 'codex', reason: 'pinned codex/gpt-5.6-sol' })
    expect(ranked.filter((item) => item.provider === 'codex' && item.model === 'gpt-5.6-sol')).toHaveLength(1)
  })

  it('returns an empty list when the pin is unavailable and pinStrict is true', () => {
    const config = base({ mode: 'tiers', pin: { orchestrator: 'grok/grok-4.5' }, pinStrict: true })
    const ranked = rankModels(config, 'orchestrator', [avail('codex', 10), avail('grok', 100)])
    expect(ranked).toEqual([])
  })

  it('ignores extra candidates that are excluded or unavailable in rankModels too', () => {
    const config = base({ mode: 'dynamic', excludeProviders: ['grok'] })
    const ranked = rankModels(config, 'orchestrator', [avail('codex', 10)], [{ provider: 'grok', model: 'grok-4.5' }, { provider: 'opencode', model: 'glm' }])
    expect(ranked.every((item) => item.provider !== 'grok')).toBe(true)
  })

  it('orders hybrid results tier-by-tier with extras appended last', () => {
    const config = base({ mode: 'hybrid' })
    const ranked = rankModels(config, 'orchestrator', [avail('codex', 10), avail('claude', 10), avail('grok', 10), avail('opencode', 10)], [{ provider: 'opencode', model: 'glm' }])
    expect(ranked.map((item) => item.provider)).toEqual(['codex', 'claude', 'grok', 'opencode'])
  })
})
