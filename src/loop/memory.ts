import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextReference } from '../context/index.js'
import type { AgentMemoryAdapter, AgentMemoryHit, AgentMemoryKvStore, AgentMemoryRecord, MemoryScope } from '../kernel/memory.js'
import { createKvMemoryAdapter, validateMemoryRecord } from '../kernel/memory.js'
import { promoteLearnings, type LearningRecord } from '../kernel/learning.js'
import { hashJson } from '../kernel/hash.js'
import type { LoadedLoopConfig, LoopConfig } from './config.js'

export interface MemoryPromptSelection {
  readonly hits: readonly AgentMemoryHit[]
  readonly block: string
  readonly approxChars: number
}

export interface MemoryContextPlan {
  readonly hits: readonly AgentMemoryHit[]
  readonly references: readonly ContextReference[]
  readonly memoryBlock: string
  readonly issueCharBudget: number
  readonly approxCharsSaved: number
  readonly memoryDigest: string
  readonly docBridgeBefore: number
  readonly docBridgeAfter: number
}

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** Atomic JSON file KV under `dir` (index + one file per record). */
export const createFileMemoryKvStore = (dir: string): AgentMemoryKvStore => {
  mkdirSync(dir, { recursive: true })
  const pathFor = (key: string): string => join(dir, `${Buffer.from(key).toString('base64url')}.json`)
  const writeAtomic = (path: string, value: unknown): void => {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8')
    renameSync(tmp, path)
  }
  return {
    async get(key) {
      const path = pathFor(key)
      if (!existsSync(path)) return undefined
      try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { return undefined }
    },
    async set(key, value) { writeAtomic(pathFor(key), value) },
  }
}

export const createFileMemoryAdapter = (dir: string, options: { readonly id?: string; readonly version?: string } = {}): AgentMemoryAdapter =>
  createKvMemoryAdapter(createFileMemoryKvStore(dir), { id: options.id ?? 'loop-file', version: options.version ?? '1' })

export const openLoopMemory = (loaded: LoadedLoopConfig): AgentMemoryAdapter | null => {
  const { memory } = loaded.config
  if (!memory.enabled || memory.backend === 'none') return null
  return createFileMemoryAdapter(join(loaded.stateDir, memory.storePath))
}

export const memoryDigestOf = (hits: readonly AgentMemoryHit[]): string =>
  hashJson(hits.map((hit) => ({ id: hit.record.id, hash: hit.record.contentHash, stale: hit.stale })))

const scopeAllowed = (scope: MemoryScope, allowed: readonly MemoryScope[]): boolean => allowed.includes(scope)

/** Cap, filter stale/scope, and render a bounded “Approved memory” markdown block. */
export const selectMemoryForPrompt = (hits: readonly AgentMemoryHit[], config: LoopConfig['memory']): MemoryPromptSelection => {
  const filtered = hits
    .filter((hit) => hit.relevant)
    .filter((hit) => config.includeStale || !hit.stale)
    .filter((hit) => scopeAllowed(hit.record.scope, config.scopes))
    .slice(0, config.maxRecall)
  const lines: string[] = []
  let used = 0
  for (const hit of filtered) {
    const summary = clip(hit.record.summary, config.maxSummaryChars)
    const line = `- [${hit.record.scope}] ${summary}${hit.stale ? ' (STALE)' : ''}`
    if (used + line.length + 1 > config.maxBlockChars) break
    lines.push(line)
    used += line.length + 1
  }
  const block = lines.length ? `## Approved memory (must follow)\n${lines.join('\n')}\n` : ''
  return { hits: filtered.slice(0, lines.length), block, approxChars: block.length }
}

const coveredByMemory = (ref: ContextReference, hits: readonly AgentMemoryHit[]): boolean => {
  const hay = `${ref.id} ${ref.uri} ${ref.title ?? ''} ${ref.contentHash ?? ''}`.toLowerCase()
  return hits.some((hit) => {
    const needle = `${hit.record.id} ${hit.record.summary} ${hit.record.source}`.toLowerCase()
    return needle.split(/\s+/).filter((token) => token.length > 3).some((token) => hay.includes(token))
      || (ref.contentHash !== undefined && ref.contentHash === hit.record.contentHash)
  })
}

/** Prefer memory over Doc Bridge so adding memory reduces (not increases) prompt size. */
export const preferMemoryOverDocBridge = (
  references: readonly ContextReference[],
  hits: readonly AgentMemoryHit[],
  minKeep: number,
): { readonly references: readonly ContextReference[]; readonly dropped: number } => {
  if (!hits.length) return { references, dropped: 0 }
  const kept: ContextReference[] = []
  const deferred: ContextReference[] = []
  for (const ref of references) {
    if (coveredByMemory(ref, hits)) deferred.push(ref)
    else kept.push(ref)
  }
  while (kept.length < minKeep && deferred.length) kept.push(deferred.shift()!)
  return { references: kept, dropped: references.length - kept.length }
}

export const planMemoryContext = async (input: {
  readonly adapter: AgentMemoryAdapter | null
  readonly config: LoopConfig
  readonly issueId: string
  readonly issueTitle: string
  readonly project: string
  readonly references: readonly ContextReference[]
  readonly sourceRevision?: string
}): Promise<MemoryContextPlan> => {
  const { config } = input
  const memory = config.memory
  const issueBudgetDefault = config.contract.maxIssueChars
  if (!input.adapter || !memory.enabled) {
    return {
      hits: [],
      references: input.references,
      memoryBlock: '',
      issueCharBudget: issueBudgetDefault,
      approxCharsSaved: 0,
      memoryDigest: hashJson([]),
      docBridgeBefore: input.references.length,
      docBridgeAfter: input.references.length,
    }
  }
  let hits: readonly AgentMemoryHit[] = []
  try {
    const base = {
      issueId: input.issueId,
      project: input.project,
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    }
    // Prefer title tokens; fall back to project-scoped recall so continuous-improvement
    // records still surface when the issue id is not literally in the summary.
    const targeted = await input.adapter.recall({ ...base, query: input.issueTitle })
    hits = targeted.length
      ? targeted
      : await input.adapter.recall({ ...base, query: '' })
  } catch { hits = [] }
  const selected = selectMemoryForPrompt(hits, memory)
  const beforeChars = input.references.reduce((sum, ref) => sum + JSON.stringify(ref).length, 0) + issueBudgetDefault
  const preferred = memory.preferOverDocBridge
    ? preferMemoryOverDocBridge(input.references, selected.hits, memory.minDocBridgeWhenMemory)
    : { references: input.references, dropped: 0 }
  const issueCharBudget = selected.hits.length && memory.shrinkIssueCharsWhenMemory
    ? Math.min(issueBudgetDefault, memory.issueCharsWithMemory)
    : issueBudgetDefault
  const afterChars = preferred.references.reduce((sum, ref) => sum + JSON.stringify(ref).length, 0) + issueCharBudget + selected.approxChars
  return {
    hits: selected.hits,
    references: preferred.references,
    memoryBlock: selected.block,
    issueCharBudget,
    approxCharsSaved: Math.max(0, beforeChars - afterChars),
    memoryDigest: memoryDigestOf(selected.hits),
    docBridgeBefore: input.references.length,
    docBridgeAfter: preferred.references.length,
  }
}

export const learningToMemoryRecord = (
  learning: LearningRecord,
  meta: { readonly project: string; readonly sourceRevision: string; readonly scope?: MemoryScope },
): AgentMemoryRecord => validateMemoryRecord({
  id: learning.id,
  scope: meta.scope ?? 'project',
  summary: learning.text,
  source: `${learning.source}|${meta.project}|${learning.category}`,
  sourceRevision: meta.sourceRevision,
  contentHash: hashJson({ id: learning.id, text: learning.text, category: learning.category }),
  approved: true,
})

export interface LearningsLedger {
  readonly records: readonly LearningRecord[]
}

export const learningsPath = (stateDir: string): string => join(stateDir, 'learnings.json')

export const readLearningsLedger = (stateDir: string): LearningsLedger => {
  const path = learningsPath(stateDir)
  if (!existsSync(path)) return { records: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LearningsLedger
    return { records: Array.isArray(parsed.records) ? parsed.records : [] }
  } catch { return { records: [] } }
}

export const writeLearningsLedger = (stateDir: string, ledger: LearningsLedger): void => {
  mkdirSync(stateDir, { recursive: true })
  const path = learningsPath(stateDir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Merge proposed learnings into the ledger without changing promoted/rejected rows. */
export const upsertProposedLearnings = (stateDir: string, proposed: readonly LearningRecord[]): LearningsLedger => {
  const current = readLearningsLedger(stateDir)
  const byId = new Map(current.records.map((record) => [record.id, record]))
  for (const record of proposed) {
    const existing = byId.get(record.id)
    if (!existing || existing.status === 'proposed') byId.set(record.id, record)
  }
  const ledger = { records: [...byId.values()] }
  writeLearningsLedger(stateDir, ledger)
  return ledger
}

export const promoteLearningsToMemory = async (input: {
  readonly stateDir: string
  readonly config: LoopConfig
  readonly adapter: AgentMemoryAdapter | null
  readonly ids: readonly string[]
  readonly actor: string
  readonly sourceRevision: string
}): Promise<{ readonly ledger: LearningsLedger; readonly remembered: readonly string[] }> => {
  const ledger = readLearningsLedger(input.stateDir)
  const updated = promoteLearnings(ledger.records, { actor: input.actor, ids: input.ids, status: 'promoted' })
  writeLearningsLedger(input.stateDir, { records: updated })
  const remembered: string[] = []
  if (!input.adapter || !input.config.memory.enabled || !input.config.memory.writeOnPromote) {
    return { ledger: { records: updated }, remembered }
  }
  for (const record of updated) {
    if (record.status !== 'promoted' || !input.ids.includes(record.id)) continue
    if (!input.config.memory.categories.includes(record.category)) continue
    const memory = learningToMemoryRecord(record, { project: input.config.project.name, sourceRevision: input.sourceRevision })
    await input.adapter.remember(memory)
    remembered.push(record.id)
  }
  return { ledger: { records: updated }, remembered }
}
