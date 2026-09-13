import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderAvailability, ProviderUsage } from '../src/adapters/providers.js'
import { remainingUsagePercent, usageRankTuple } from '../src/adapters/providers.js'
import { LoopConfigSchema } from '../src/loop/config.js'
import { parseGrokModelsOutput, readCliModelsCache, resolveCatalogCandidates } from '../src/loop/model-catalog/index.js'
import { rankModels, selectModel } from '../src/loop/routing.js'

const usage = (windows: { kind: string; usedPercent: number }[], exhausted = false): ProviderUsage => ({
  status: 'ok',
  error: null,
  windows: windows.map((window) => ({ ...window, windowMinutes: 60, resetsAt: null })),
  exhausted,
  resetsAt: null,
  hasAuth: true,
})

const avail = (id: string, usedPercent: number, available = true): ProviderAvailability => ({
  id,
  binary: `/bin/${id}`,
  hookState: 'installed',
  auth: 'ok',
  usage: usage([{ kind: 'weekly', usedPercent }], usedPercent >= 100),
  probe: 'skipped',
  coolingDownUntil: null,
  available: available && usedPercent < 100,
  reasons: usedPercent >= 100 ? ['usage exhausted'] : [],
})

const base = (routing: Record<string, unknown> = {}) => LoopConfigSchema.parse({
  project: { name: 'demo', repo: 'Acme/demo', stateDir: '.codex/loop' },
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
    },
  },
  delivery: { verifyCommand: 'pnpm test' },
})

describe('usage-aware routing', () => {
  it('remainingUsagePercent uses the most constrained window for max', () => {
    expect(remainingUsagePercent(usage([{ kind: 'session', usedPercent: 10 }, { kind: 'weekly', usedPercent: 80 }]), 'max')).toBe(20)
    expect(remainingUsagePercent(usage([{ kind: 'session', usedPercent: 10 }, { kind: 'weekly', usedPercent: 80 }]), 'session')).toBe(90)
  })

  it('tiers mode keeps declaration order (0.6 behaviour)', () => {
    const config = base({ mode: 'tiers' })
    const selected = selectModel(config, 'orchestrator', [avail('codex', 90), avail('claude', 10)]).selected
    expect(selected).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' })
  })

  it('hybrid mode picks higher remaining usage inside the same tier', () => {
    const config = base({ mode: 'hybrid', preferKnownUsage: true })
    // codex listed first but nearly exhausted; claude has more remaining → claude wins in tier 1
    const selected = selectModel(config, 'orchestrator', [avail('codex', 95), avail('claude', 20)]).selected
    expect(selected).toMatchObject({ provider: 'claude', model: 'opus' })
    expect(selected?.remainingPercent).toBe(80)
  })

  it('hybrid falls through to next tier when tier-1 is exhausted', () => {
    const config = base({ mode: 'hybrid' })
    const selected = selectModel(config, 'orchestrator', [avail('codex', 100), avail('claude', 100), avail('grok', 30)]).selected
    expect(selected).toMatchObject({ provider: 'grok', model: 'grok-4.5' })
  })

  it('dynamic flattens and prefers remaining usage over tier order', () => {
    const config = base({ mode: 'dynamic' })
    const ranked = rankModels(config, 'builder', [avail('codex', 90), avail('claude', 5), avail('grok', 40)])
    expect(ranked[0]).toMatchObject({ provider: 'claude' })
  })

  it('rankModels honors a configured pin before usage ranking', () => {
    const config = base({ mode: 'catalog', pin: { reviewer: 'claude/opus' } })
    const ranked = rankModels(config, 'reviewer', [avail('codex', 5), avail('claude', 90)])
    expect(ranked[0]).toMatchObject({ provider: 'claude', model: 'opus', reason: 'pinned claude/opus' })
  })

  it('preferKnownUsage ranks known remaining before unknown', () => {
    const known = usageRankTuple(usage([{ kind: 'weekly', usedPercent: 50 }]), 'max', true)
    const unknown = usageRankTuple({ status: 'unknown', error: null, windows: [], exhausted: false, resetsAt: null, hasAuth: true }, 'max', true)
    expect(known[0]).toBeLessThan(unknown[0]!)
  })

  it('parseGrokModelsOutput extracts model ids', () => {
    expect(parseGrokModelsOutput('Available models:\n  - grok-4.6\n  * grok-4.5 (default)\n')).toEqual(['grok-4.6', 'grok-4.5'])
  })

  it('catalog mode merges builtin candidates for available providers', async () => {
    const config = base({ mode: 'catalog' })
    const refs = await resolveCatalogCandidates({
      config,
      role: 'builder',
      availableProviderIds: ['grok'],
    })
    expect(refs.some((ref) => ref.provider === 'grok')).toBe(true)
    const selected = selectModel(config, 'builder', [avail('grok', 20)], refs).selected
    expect(selected?.provider).toBe('grok')
  })

  describe('CLI catalog cache', () => {
    const cleanups: string[] = []
    afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
    const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-catalog-cache-')); cleanups.push(dir); return dir }
    const grokRunner = (calls: string[][]) => ({ run: async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, stdout: '- grok-4.6\n', stderr: '', timedOut: false, durationMs: 1 } } })

    it('spawns the CLI once, then serves the cache until it goes stale', async () => {
      const config = base({ mode: 'catalog' })
      const stateDir = tempStateDir()
      const calls: string[][] = []
      const runner = grokRunner(calls)
      let now = new Date('2026-09-13T00:00:00.000Z')
      const args = { config, role: 'builder' as const, availableProviderIds: ['grok'], runner, stateDir, now: () => now }

      const first = await resolveCatalogCandidates(args)
      expect(first.some((ref) => ref.model.includes('grok-4.6'))).toBe(true)
      expect(calls).toHaveLength(1)
      expect(readCliModelsCache(stateDir, 'grok')?.ids).toEqual(['grok-4.6'])

      now = new Date(now.getTime() + 60 * 60_000) // 1h later, well inside the 6h default cliCacheHours
      await resolveCatalogCandidates(args)
      expect(calls).toHaveLength(1) // served from cache, no second spawn

      now = new Date(now.getTime() + 6 * 3_600_000) // past cliCacheHours
      await resolveCatalogCandidates(args)
      expect(calls).toHaveLength(2) // cache was stale, spawned again
    })

    it('falls back to the stale cache instead of an empty list when a refresh attempt fails', async () => {
      const config = base({ mode: 'catalog' })
      const stateDir = tempStateDir()
      const failingRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1 }) }
      const okRunner = grokRunner([])
      let now = new Date('2026-09-13T00:00:00.000Z')
      await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['grok'], runner: okRunner, stateDir, now: () => now })
      expect(readCliModelsCache(stateDir, 'grok')?.ids).toEqual(['grok-4.6'])

      now = new Date(now.getTime() + 7 * 3_600_000) // force a stale-cache refresh attempt
      const refs = await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['grok'], runner: failingRunner, stateDir, now: () => now })
      expect(refs.some((ref) => ref.model.includes('grok-4.6'))).toBe(true) // kept the stale cache instead of going empty
    })
  })
})
