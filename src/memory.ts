import { fail } from './errors.js'

export const MEMORY_SCOPES = ['issue', 'project', 'global'] as const
export type MemoryScope = typeof MEMORY_SCOPES[number]

export interface AgentMemoryRecord {
  readonly id: string
  readonly scope: MemoryScope
  readonly summary: string
  readonly source: string
  readonly sourceRevision: string
  readonly contentHash: string
  readonly approved: true
}

export interface AgentMemoryHit {
  readonly record: AgentMemoryRecord
  readonly relevant: boolean
  readonly stale: boolean
}

export interface AgentMemoryAdapter {
  readonly id: string
  readonly version: string
  remember(record: AgentMemoryRecord): Promise<void>
  recall(input: { readonly query: string; readonly issueId?: string; readonly project?: string; readonly sourceRevision?: string }): Promise<readonly AgentMemoryHit[]>
}

export interface AgentMemoryKvStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' must be a non-empty string.', 'INVALID_INPUT')
  return (value as string).trim()
}

export const validateMemoryRecord = (record: AgentMemoryRecord): AgentMemoryRecord => {
  text(record.id, 'memory.id')
  if (!MEMORY_SCOPES.includes(record.scope)) fail('memory.scope is invalid.', 'INVALID_INPUT')
  text(record.summary, 'memory.summary')
  text(record.source, 'memory.source')
  text(record.sourceRevision, 'memory.sourceRevision')
  text(record.contentHash, 'memory.contentHash')
  if (record.approved !== true) fail('Only approved memory may enter the shared store.', 'POLICY_BLOCKED')
  return record
}

/** Minimal deterministic adapter for replay/tests; production uses @agentskit/memory through the same seam. */
export const createInMemoryMemoryAdapter = (options: { readonly id?: string; readonly version?: string } = {}): AgentMemoryAdapter => {
  const records = new Map<string, AgentMemoryRecord>()
  return {
    id: options.id ?? 'in-memory',
    version: options.version ?? '1',
    async remember(record) { records.set(validateMemoryRecord(record).id, record) },
    async recall({ query, issueId, project, sourceRevision }) {
      const needle = query.trim().toLowerCase()
      return [...records.values()].filter((record) => {
        const scopeMatch = record.scope === 'global' || (record.scope === 'issue' ? Boolean(issueId && record.source.includes(issueId)) : Boolean(project && record.source.includes(project)))
        return scopeMatch && (!needle || `${record.summary} ${record.source}`.toLowerCase().includes(needle))
      }).map((record) => ({ record, relevant: true, stale: sourceRevision !== undefined && record.sourceRevision !== sourceRevision }))
    },
  }
}

/** Bridges AgentsKit's KV memory stores without making the Harness depend on a backend. */
export const createKvMemoryAdapter = (store: AgentMemoryKvStore, options: { readonly id?: string; readonly version?: string } = {}): AgentMemoryAdapter => {
  const indexKey = 'agentskit-harness:memory:index'
  const matches = (record: AgentMemoryRecord, query: string, issueId?: string, project?: string): boolean => {
    const scopeMatch = record.scope === 'global' || (record.scope === 'issue' ? Boolean(issueId && record.source.includes(issueId)) : Boolean(project && record.source.includes(project)))
    return scopeMatch && (!query || `${record.summary} ${record.source}`.toLowerCase().includes(query))
  }
  return {
    id: options.id ?? 'agentskit-kv',
    version: options.version ?? '1',
    async remember(record) {
      const valid = validateMemoryRecord(record)
      const ids = (await store.get(indexKey))
      const index = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      if (!index.includes(valid.id)) await store.set(indexKey, [...index, valid.id].sort())
      await store.set(`agentskit-harness:memory:${valid.id}`, valid)
    },
    async recall({ query, issueId, project, sourceRevision }) {
      const ids = await store.get(indexKey)
      const records = Array.isArray(ids) ? await Promise.all(ids.filter((id): id is string => typeof id === 'string').map((id) => store.get(`agentskit-harness:memory:${id}`))) : []
      return records.filter((record): record is AgentMemoryRecord => Boolean(record && typeof record === 'object' && (record as AgentMemoryRecord).approved === true))
        .filter((record) => matches(record, query.trim().toLowerCase(), issueId, project))
        .map((record) => ({ record, relevant: true, stale: sourceRevision !== undefined && record.sourceRevision !== sourceRevision }))
    },
  }
}
