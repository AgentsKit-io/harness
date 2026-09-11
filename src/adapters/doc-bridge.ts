import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashJson } from '../kernel/hash.js'
import { hashContextSnapshot } from '../context/index.js'
import type { AdapterTelemetry } from '../kernel/adapter-contract.js'
import type { ContextProvider, ContextQuery, ContextReference } from '../context/index.js'

interface IndexEntry { readonly id?: unknown; readonly type?: unknown; readonly title?: unknown; readonly path?: unknown; readonly description?: unknown; readonly body?: unknown; readonly tags?: unknown; readonly contentHash?: unknown }
interface IndexDocument { readonly contentHash?: unknown; readonly knowledge?: unknown }

const index = (root: string, indexPath: string): IndexDocument => JSON.parse(readFileSync(resolve(root, indexPath), 'utf8')) as IndexDocument
const text = (entry: IndexEntry): string => [entry.id, entry.type, entry.title, entry.path, entry.description, entry.body, ...(Array.isArray(entry.tags) ? entry.tags : [])].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
const sourceHash = (document: IndexDocument): string => typeof document.contentHash === 'string' && document.contentHash.length > 0 ? document.contentHash : hashJson(document)
const matches = (entry: IndexEntry, query: ContextQuery): boolean => {
  const needle = query.query.trim().toLowerCase()
  const scopes = query.scope?.map((scope) => scope.toLowerCase()) ?? []
  const value = text(entry)
  return Boolean(needle && value.includes(needle) && (scopes.length === 0 || scopes.some((scope) => value.includes(scope))))
}

export interface DocBridgeContextProviderOptions {
  readonly root: string
  readonly indexPath?: string
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

export const createDocBridgeContextProvider = ({ root, indexPath = '.doc-bridge/index.json' }: DocBridgeContextProviderOptions): ContextProvider => ({
  id: 'doc-bridge',
  version: '1.0.0',
  resolve: async (query) => {
    const started = Date.now()
    const document = index(root, indexPath)
    const contentHash = sourceHash(document)
    const entries = Array.isArray(document.knowledge) ? document.knowledge.filter((value): value is IndexEntry => typeof value === 'object' && value !== null && !Array.isArray(value)).filter((entry) => matches(entry, query)).sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? ''))).slice(0, 8) : []
    const references: ContextReference[] = entries.flatMap((entry) => typeof entry.id === 'string' && typeof entry.path === 'string' ? [{ id: entry.id, uri: `doc-bridge://${entry.path}`, ...(typeof entry.title === 'string' ? { title: entry.title } : {}), contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : contentHash, relevance: 1 }] : [])
    const telemetry: AdapterTelemetry = { status: 'measured', durationMs: Date.now() - started, contextReferences: references.length, contextCostTokens: Math.max(1, Math.ceil(JSON.stringify(references).length / 4)) }
    return { providerId: 'doc-bridge', query, references, sourceHash: contentHash, snapshotHash: hashContextSnapshot({ providerId: 'doc-bridge', query, references, sourceHash: contentHash }), resolvedAt: new Date().toISOString(), assurance: 'contract-tested', telemetry }
  },
})
