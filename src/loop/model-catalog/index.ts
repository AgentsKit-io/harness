import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner } from '../../adapters/command.js'
import type { LoopConfig, ModelReference } from '../config.js'
import type { ModelRole } from '../../kernel/model-policy.js'
import { parseModelRef } from '../config.js'
import builtinJson from './builtin.json' with { type: 'json' }
import aliasesJson from './aliases.json' with { type: 'json' }

export type ModelQuality = 'frontier' | 'balanced' | 'fast'

export interface CatalogModel {
  readonly id: string
  readonly quality: ModelQuality
  readonly codingScore: number
  readonly source: 'cli' | 'artificial-analysis' | 'builtin' | 'yaml'
  readonly creator?: string
}

export interface ProviderCatalog {
  readonly creator?: string
  readonly models: readonly CatalogModel[]
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

export const loadBuiltinCatalog = (): Readonly<Record<string, ProviderCatalog>> => {
  const raw = builtinJson as { providers: Record<string, { creator?: string; models: { id: string; quality: ModelQuality; codingScore: number }[] }> }
  return Object.fromEntries(Object.entries(raw.providers).map(([id, value]) => [id, {
    creator: value.creator,
    models: value.models.map((model) => ({ ...model, source: 'builtin' as const, creator: value.creator })),
  }]))
}

export const loadAliases = (): Readonly<Record<string, Readonly<Record<string, string>>>> =>
  (aliasesJson as { aliases: Record<string, Record<string, string>> }).aliases

export const resolveAlias = (provider: string, modelId: string, aliases = loadAliases()): string =>
  aliases[provider]?.[modelId] ?? aliases[provider]?.[modelId.toLowerCase()] ?? modelId

/** Parse `grok models` human output into model ids. */
export const parseGrokModelsOutput = (stdout: string): readonly string[] => {
  const models: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]?\s*(grok-[a-z0-9][a-z0-9._-]*)\b/i) ?? line.match(/^\s*\*\s*(grok-[a-z0-9][a-z0-9._-]*)\b/i)
    if (match?.[1]) models.push(match[1])
  }
  return [...new Set(models)]
}

export const listCliModels = async (
  provider: string,
  bin: string,
  runner: CommandRunner,
  timeoutMs = 20_000,
): Promise<readonly string[]> => {
  if (provider === 'grok') {
    const outcome = await runner.run([bin, 'models'], { timeoutMs })
    if (outcome.code !== 0 && !outcome.stdout.trim()) return []
    return parseGrokModelsOutput(`${outcome.stdout}\n${outcome.stderr}`)
  }
  // Other CLIs: fail-soft until they expose a stable list command.
  return []
}

export interface ArtificialAnalysisModel {
  readonly slug: string
  readonly name: string
  readonly creatorSlug: string
  readonly codingIndex: number | null
  readonly intelligenceIndex: number | null
}

export const parseArtificialAnalysisPayload = (payload: unknown): readonly ArtificialAnalysisModel[] => {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = Array.isArray(root['data']) ? root['data'] : Array.isArray(payload) ? payload : []
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const creator = row['model_creator'] && typeof row['model_creator'] === 'object' && !Array.isArray(row['model_creator'])
      ? row['model_creator'] as Record<string, unknown>
      : {}
    const evaluations = row['evaluations'] && typeof row['evaluations'] === 'object' && !Array.isArray(row['evaluations'])
      ? row['evaluations'] as Record<string, unknown>
      : {}
    const slug = typeof row['slug'] === 'string' ? row['slug'] : typeof row['id'] === 'string' ? row['id'] : null
    if (!slug) return []
    return [{
      slug,
      name: typeof row['name'] === 'string' ? row['name'] : slug,
      creatorSlug: typeof creator['slug'] === 'string' ? creator['slug'] : 'unknown',
      codingIndex: typeof evaluations['artificial_analysis_coding_index'] === 'number' ? evaluations['artificial_analysis_coding_index'] as number : null,
      intelligenceIndex: typeof evaluations['artificial_analysis_intelligence_index'] === 'number' ? evaluations['artificial_analysis_intelligence_index'] as number : null,
    }]
  })
}

export const readAaCache = (stateDir: string): { readonly fetchedAt: string; readonly models: readonly ArtificialAnalysisModel[] } | null => {
  const path = join(stateDir, 'catalog', 'artificial-analysis.json')
  if (!existsSync(path)) return null
  try {
    const raw = readJson<{ fetchedAt: string; models: ArtificialAnalysisModel[] }>(path)
    return { fetchedAt: raw.fetchedAt, models: raw.models }
  } catch { return null }
}

export const writeAaCache = (stateDir: string, models: readonly ArtificialAnalysisModel[]): void => {
  const path = join(stateDir, 'catalog', 'artificial-analysis.json')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export const fetchArtificialAnalysisModels = async (input: {
  readonly endpoint: string
  readonly apiKey: string
  readonly timeoutMs?: number
}): Promise<readonly ArtificialAnalysisModel[]> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000)
  try {
    const response = await fetch(input.endpoint, {
      headers: { 'x-api-key': input.apiKey, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Artificial Analysis HTTP ${response.status}`)
    return parseArtificialAnalysisPayload(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

const creatorForProvider: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
  opencode: 'opencode',
}

const qualityRank: Record<ModelQuality, number> = { frontier: 3, balanced: 2, fast: 1 }

const matchesQuality = (model: CatalogModel, wanted: ModelQuality): boolean => {
  if (wanted === 'frontier') return model.quality === 'frontier' || model.codingScore >= 80
  if (wanted === 'balanced') return model.quality !== 'fast' || model.codingScore >= 65
  return true
}

/** Build catalog candidates for a role from CLI + builtin + optional AA, filtered by quality band. */
export const resolveCatalogCandidates = async (input: {
  readonly config: LoopConfig
  readonly role: ModelRole
  readonly availableProviderIds: readonly string[]
  readonly runner?: CommandRunner
  readonly stateDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
}): Promise<readonly ModelReference[]> => {
  const { config, role } = input
  const policy = config.models.roles[role]
  const sources = config.models.catalog.sources
  const builtin = loadBuiltinCatalog()
  const aliases = loadAliases()
  const byProvider = new Map<string, CatalogModel[]>()

  const push = (provider: string, model: CatalogModel): void => {
    const list = byProvider.get(provider) ?? []
    if (list.some((item) => item.id === model.id)) return
    list.push(model)
    byProvider.set(provider, list)
  }

  for (const provider of input.availableProviderIds) {
    if (sources.includes('builtin') && builtin[provider]) {
      for (const model of builtin[provider].models) push(provider, model)
    }
    if (sources.includes('cli') && input.runner) {
      const settings = config.models.providers[provider]
      if (settings) {
        try {
          const ids = await listCliModels(provider, settings.bin, input.runner)
          for (const id of ids) {
            const resolved = resolveAlias(provider, id, aliases)
            const existing = builtin[provider]?.models.find((model) => model.id === resolved)
            push(provider, existing ?? { id: resolved, quality: 'balanced', codingScore: 70, source: 'cli', creator: creatorForProvider[provider] })
          }
        } catch { /* fail-soft */ }
      }
    }
  }

  if (sources.includes('artificial-analysis') && config.models.catalog.artificialAnalysis.enabled && input.stateDir) {
    const aa = config.models.catalog.artificialAnalysis
    const env = input.env ?? process.env
    const key = env[aa.apiKeyEnv]?.trim()
    let models = readAaCache(input.stateDir)
    const now = input.now ?? (() => new Date())
    const stale = !models || (now().getTime() - Date.parse(models.fetchedAt)) > aa.cacheHours * 3_600_000
    if (key && stale) {
      try {
        const fresh = await fetchArtificialAnalysisModels({ endpoint: aa.endpoint, apiKey: key })
        writeAaCache(input.stateDir, fresh)
        models = { fetchedAt: now().toISOString(), models: fresh }
      } catch { /* keep cache */ }
    }
    if (models) {
      for (const provider of input.availableProviderIds) {
        const creator = creatorForProvider[provider] ?? provider
        const matches = models.models.filter((model) => model.creatorSlug === creator || model.creatorSlug.includes(creator))
        for (const model of matches) {
          const id = resolveAlias(provider, model.slug, aliases)
          const score = model.codingIndex ?? model.intelligenceIndex ?? 50
          const quality: ModelQuality = score >= 80 ? 'frontier' : score >= 60 ? 'balanced' : 'fast'
          push(provider, { id, quality, codingScore: score, source: 'artificial-analysis', creator })
        }
      }
    }
  }

  const refs: ModelReference[] = []
  for (const provider of input.availableProviderIds) {
    let models = byProvider.get(provider) ?? []
    if (policy.preferCreators.length) {
      const preferred = models.filter((model) => model.creator && policy.preferCreators.includes(model.creator))
      if (preferred.length) models = preferred
    }
    models = models.filter((model) => matchesQuality(model, policy.quality))
    models = [...models].sort((left, right) => {
      const qualityDelta = qualityRank[right.quality] - qualityRank[left.quality]
      if (qualityDelta) return qualityDelta
      return right.codingScore - left.codingScore
    })
    // Keep a few top models per provider so usage ranking still has choice.
    for (const model of models.slice(0, 3)) {
      refs.push(parseModelRef(`${provider}/${model.id}`))
    }
  }
  return refs
}
