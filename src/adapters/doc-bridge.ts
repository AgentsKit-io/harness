import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashJson } from '../kernel/hash.js'
import { hashContextSnapshot } from '../context/index.js'
import type { AdapterTelemetry } from '../kernel/adapter-contract.js'
import type { ContextProvider, ContextQuery, ContextReference } from '../context/index.js'

interface IndexEntry { readonly id?: unknown; readonly type?: unknown; readonly title?: unknown; readonly path?: unknown; readonly description?: unknown; readonly body?: unknown; readonly tags?: unknown; readonly contentHash?: unknown }
interface IndexDocument { readonly contentHash?: unknown; readonly knowledge?: unknown; readonly lookup?: unknown }

const index = (root: string, indexPath: string): IndexDocument => JSON.parse(readFileSync(resolve(root, indexPath), 'utf8')) as IndexDocument
const text = (entry: IndexEntry): string => [entry.id, entry.type, entry.title, entry.path, entry.description, entry.body, ...(Array.isArray(entry.tags) ? entry.tags : [])].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
const sourceHash = (document: IndexDocument): string => typeof document.contentHash === 'string' && document.contentHash.length > 0 ? document.contentHash : hashJson(document)
const tokenSeparator = /[^\p{L}\p{N}@/_-]+/gu
const tokenize = (value: string): string[] => value.toLowerCase().split(tokenSeparator).filter((token) => token.length >= 2)
const containsToken = (value: string, token: string): boolean => {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) return value.includes(token)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:s|es)?(?:[^\\p{L}\\p{N}]|$)`, 'u').test(value)
}
const score = (value: string, query: string): number => tokenize(query).reduce((total, token) => total + (containsToken(value, token) ? token.length : 0), 0)
const matches = (entry: IndexEntry, query: ContextQuery): number => {
  const needle = query.query.trim()
  if (!needle) return 0
  const value = text(entry)
  if (query.scope?.length && !query.scope.some((scope) => containsToken(value, scope.toLowerCase()))) return 0
  return score(value, needle)
}

const ownershipEntries = (document: IndexDocument): IndexEntry[] => {
  if (typeof document.lookup !== 'object' || document.lookup === null || Array.isArray(document.lookup)) return []
  const ownership = (document.lookup as { ownership?: unknown }).ownership
  if (typeof ownership !== 'object' || ownership === null || Array.isArray(ownership)) return []
  return Object.entries(ownership).flatMap(([id, value]) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const owner = value as Record<string, unknown>
    const path = typeof owner['agentDoc'] === 'string' ? owner['agentDoc'] : owner['path']
    if (!path) return []
    const description = typeof owner['purpose'] === 'string' ? owner['purpose'] : undefined
    const body = [owner['purpose'], owner['group'], owner['layer'], owner['agentDoc'], owner['humanDoc']]
      .filter((item): item is string => typeof item === 'string')
      .join(' ')
    return [{ id: typeof owner['id'] === 'string' ? owner['id'] : id, type: 'ownership', path, ...(description ? { description } : {}), ...(body ? { body } : {}) }]
  })
}

export interface DocBridgeContextProviderOptions {
  readonly root: string
  readonly indexPath?: string
  /** Reject indexes older than this many hours; 0 or undefined disables the age guard. */
  readonly maxAgeHours?: number
  readonly now?: () => number
}

export interface DocBridgeIndexInspection {
  readonly present: boolean
  readonly path: string
  readonly contentHash: string | null
  readonly mtimeMs: number | null
  readonly ageHours: number | null
  readonly error: string | null
}

/** Read-only inspection for doctor freshness checks (no network, no rebuild). */
export const inspectDocBridgeIndex = (root: string, indexPath = '.doc-bridge/index.json', now = Date.now()): DocBridgeIndexInspection => {
  const path = resolve(root, indexPath)
  if (!existsSync(path)) return { present: false, path, contentHash: null, mtimeMs: null, ageHours: null, error: null }
  try {
    const stat = statSync(path)
    const document = JSON.parse(readFileSync(path, 'utf8')) as IndexDocument
    const contentHash = sourceHash(document)
    const ageHours = Math.max(0, (now - stat.mtimeMs) / 3_600_000)
    return { present: true, path, contentHash, mtimeMs: stat.mtimeMs, ageHours, error: null }
  } catch (error) {
    return { present: true, path, contentHash: null, mtimeMs: null, ageHours: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export const createDocBridgeContextProvider = ({ root, indexPath = '.doc-bridge/index.json', maxAgeHours, now = Date.now }: DocBridgeContextProviderOptions): ContextProvider => ({
  id: 'doc-bridge',
  version: '1.1.0',
  resolve: async (query) => {
    const started = Date.now()
    const ageBudget = maxAgeHours ?? 0
    const inspection = ageBudget > 0 ? inspectDocBridgeIndex(root, indexPath, now()) : null
    if (inspection?.error) throw new Error(`Doc Bridge index is unreadable: ${inspection.error}`)
    if (inspection?.ageHours !== null && inspection?.ageHours !== undefined && inspection.ageHours > ageBudget) {
      throw new Error(`Doc Bridge index is ${inspection.ageHours.toFixed(1)}h old; refresh it before resolving context.`)
    }
    const document = index(root, indexPath)
    const contentHash = sourceHash(document)
    const knowledge = Array.isArray(document.knowledge)
      ? document.knowledge.filter((value): value is IndexEntry => typeof value === 'object' && value !== null && !Array.isArray(value))
      : []
    const ranked = [...knowledge, ...ownershipEntries(document)]
      .map((entry) => ({ entry, score: matches(entry, query) }))
      .filter(({ score: entryScore }) => entryScore > 0)
    const byPath = new Map<string, { readonly entry: IndexEntry; readonly score: number }>()
    for (const candidate of ranked) {
      const path = typeof candidate.entry.path === 'string' ? candidate.entry.path : String(candidate.entry.id ?? '')
      const current = byPath.get(path)
      if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.entry.type === 'ownership' && current.entry.type !== 'ownership')) byPath.set(path, candidate)
    }
    const entries = [...byPath.values()]
      .sort((left, right) => right.score - left.score || String(left.entry.id ?? '').localeCompare(String(right.entry.id ?? '')))
      .slice(0, 8)
    const maxScore = entries[0]?.score ?? 1
    const references: ContextReference[] = entries.flatMap(({ entry, score: entryScore }) => typeof entry.id === 'string' && typeof entry.path === 'string' ? [{ id: entry.id, uri: `doc-bridge://${entry.path}`, ...(typeof entry.title === 'string' ? { title: entry.title } : {}), contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : contentHash, relevance: entryScore / maxScore }] : [])
    const telemetry: AdapterTelemetry = { status: 'measured', durationMs: Date.now() - started, contextReferences: references.length, contextCostTokens: Math.max(1, Math.ceil(JSON.stringify(references).length / 4)) }
    return { providerId: 'doc-bridge', query, references, sourceHash: contentHash, snapshotHash: hashContextSnapshot({ providerId: 'doc-bridge', query, references, sourceHash: contentHash }), resolvedAt: new Date().toISOString(), assurance: 'contract-tested', telemetry }
  },
})
