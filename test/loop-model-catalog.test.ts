import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopConfigSchema } from '../src/loop/config.js'
import {
  fetchArtificialAnalysisModels, listCliModels, parseArtificialAnalysisPayload, readAaCache, resolveAlias, resolveCatalogCandidates, writeAaCache,
} from '../src/loop/model-catalog/index.js'

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })
const tempStateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agentskit-catalog-')); cleanups.push(dir); return dir }

const base = (overrides: Record<string, unknown> = {}) => LoopConfigSchema.parse({
  project: { name: 'demo', repo: 'Acme/demo', stateDir: '.codex/loop' },
  linear: { workspaceId: 'ws', teamKey: 'ENG', person: 'alice' },
  models: {
    orchestrator: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4.5']],
    reviewer: [['codex/gpt-5.6-sol', 'claude/opus'], ['grok/grok-4.5']],
    builder: [['codex/gpt-5.6-luna', 'claude/sonnet'], ['grok/grok-4.5']],
    watcher: [['claude/haiku'], ['grok/grok-4.5']],
    providers: {
      claude: { bin: 'claude', auth: 'subscription', tui: 'claude --model {model}', headless: ['claude', '-p', '{prompt}'] },
      codex: { bin: 'codex', auth: 'subscription', tui: 'codex -m {model}', headless: ['codex', 'exec', '{prompt}'] },
      grok: { bin: 'grok', auth: 'subscription', tui: 'grok -m {model}', headless: ['grok', '-p', '{prompt}', '-m', '{model}'] },
    },
    ...overrides,
  },
  delivery: { verifyCommand: 'pnpm test' },
})

describe('model catalog: alias resolution', () => {
  it('resolves a known alias, falls back to a lowercase match, then to the input unchanged', () => {
    expect(resolveAlias('claude', 'claude-opus-4')).toBe('opus')
    expect(resolveAlias('claude', 'CLAUDE-OPUS-4')).toBe('opus')
    expect(resolveAlias('claude', 'some-unlisted-model')).toBe('some-unlisted-model')
    expect(resolveAlias('unknown-provider', 'anything')).toBe('anything')
  })
})

describe('model catalog: non-grok CLI listing', () => {
  it('returns an empty list for providers without a stable list command, without calling the runner', async () => {
    const run = vi.fn()
    const ids = await listCliModels('codex', 'codex', { run })
    expect(ids).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })
})

describe('model catalog: Artificial Analysis payload parsing', () => {
  it('reads models from a {data:[...]} envelope, skipping rows without a slug/id', () => {
    const models = parseArtificialAnalysisPayload({
      data: [
        { slug: 'gpt-5', name: 'GPT-5', model_creator: { slug: 'openai' }, evaluations: { artificial_analysis_coding_index: 85, artificial_analysis_intelligence_index: 90 } },
        { id: 'no-slug-field', model_creator: { slug: 'x' } },
        { name: 'missing identifiers entirely' },
      ],
    })
    expect(models).toEqual([
      { slug: 'gpt-5', name: 'GPT-5', creatorSlug: 'openai', codingIndex: 85, intelligenceIndex: 90 },
      { slug: 'no-slug-field', name: 'no-slug-field', creatorSlug: 'x', codingIndex: null, intelligenceIndex: null },
    ])
  })

  it('also accepts a bare array payload and defaults missing creator/evaluations gracefully', () => {
    const models = parseArtificialAnalysisPayload([{ slug: 'm1' }])
    expect(models).toEqual([{ slug: 'm1', name: 'm1', creatorSlug: 'unknown', codingIndex: null, intelligenceIndex: null }])
  })

  it('returns an empty list for a payload shaped as neither an array nor a {data} object', () => {
    expect(parseArtificialAnalysisPayload(null)).toEqual([])
    expect(parseArtificialAnalysisPayload('not an object')).toEqual([])
    expect(parseArtificialAnalysisPayload({ nope: true })).toEqual([])
  })
})

describe('model catalog: Artificial Analysis cache', () => {
  it('round-trips fetchedAt/models through the state dir', () => {
    const stateDir = tempStateDir()
    expect(readAaCache(stateDir)).toBeNull()
    const models = [{ slug: 'm1', name: 'M1', creatorSlug: 'openai', codingIndex: 80, intelligenceIndex: null }]
    writeAaCache(stateDir, models)
    expect(readAaCache(stateDir)?.models).toEqual(models)
  })

  it('treats a genuinely corrupt on-disk cache as absent instead of throwing', () => {
    const stateDir = tempStateDir()
    writeAaCache(stateDir, [])
    const path = join(stateDir, 'catalog', 'artificial-analysis.json')
    writeFileSync(path, '{not valid json')
    expect(readAaCache(stateDir)).toBeNull()
  })
})

describe('model catalog: fetchArtificialAnalysisModels', () => {
  it('parses a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ slug: 'm1', model_creator: {}, evaluations: {} }] }) }))
    const models = await fetchArtificialAnalysisModels({ endpoint: 'https://example.test/models', apiKey: 'k' })
    expect(models).toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith('https://example.test/models', expect.objectContaining({ headers: { 'x-api-key': 'k', accept: 'application/json' } }))
  })

  it('throws when the HTTP response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    await expect(fetchArtificialAnalysisModels({ endpoint: 'https://example.test/models', apiKey: 'k' })).rejects.toThrow('Artificial Analysis HTTP 503')
  })

  it('aborts the request once timeoutMs elapses', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    await expect(fetchArtificialAnalysisModels({ endpoint: 'https://example.test/models', apiKey: 'k', timeoutMs: 5 })).rejects.toThrow('aborted')
  })
})

describe('model catalog: resolveCatalogCandidates quality/creator filtering', () => {
  it('keeps only preferred-creator models when preferCreators matches at least one', async () => {
    const config = base({ mode: 'catalog', roles: { builder: { quality: 'fast', preferCreators: ['anthropic'] } } })
    const refs = await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['claude'] })
    // builtin claude catalog is entirely anthropic-authored, so the preferCreators filter should not empty the list
    expect(refs.some((ref) => ref.provider === 'claude')).toBe(true)
  })

  it('falls back to the unfiltered list when no model matches preferCreators', async () => {
    const config = base({ mode: 'catalog', roles: { builder: { quality: 'fast', preferCreators: ['nobody-makes-models-named-this'] } } })
    const refs = await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['claude'] })
    expect(refs.some((ref) => ref.provider === 'claude')).toBe(true)
  })

  it('merges Artificial Analysis candidates into the catalog when the source is enabled and the API key is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ slug: 'grok-9-experimental', model_creator: { slug: 'xai' }, evaluations: { artificial_analysis_coding_index: 92 } }] }),
    }))
    const stateDir = tempStateDir()
    const config = base({
      mode: 'catalog',
      catalog: { sources: ['artificial-analysis'], artificialAnalysis: { enabled: true, apiKeyEnv: 'AA_TEST_KEY', cacheHours: 24, endpoint: 'https://example.test/models' } },
    })
    const refs = await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['grok'], stateDir, env: { AA_TEST_KEY: 'secret' } })
    expect(refs.some((ref) => ref.model === 'grok-9-experimental')).toBe(true)
    expect(readAaCache(stateDir)?.models.some((model) => model.slug === 'grok-9-experimental')).toBe(true)
  })

  it('reuses the Artificial Analysis cache instead of refetching when it is still fresh, and skips fetching when no API key is set', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const stateDir = tempStateDir()
    writeAaCache(stateDir, [{ slug: 'cached-model', name: 'Cached', creatorSlug: 'xai', codingIndex: 70, intelligenceIndex: null }])
    const config = base({
      mode: 'catalog',
      catalog: { sources: ['artificial-analysis'], artificialAnalysis: { enabled: true, apiKeyEnv: 'AA_MISSING_KEY', cacheHours: 24, endpoint: 'https://example.test/models' } },
    })
    const refs = await resolveCatalogCandidates({ config, role: 'builder', availableProviderIds: ['grok'], stateDir, env: {} })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(refs.some((ref) => ref.model === 'cached-model')).toBe(true)
  })
})
