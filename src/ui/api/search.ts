import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { LoopConfig } from '../../loop/config.js'
import { readStoredContract } from '../../loop/contract.js'
import { readDodEvidence } from '../../loop/dod.js'
import { learningsPath, readLearningsLedger } from '../../loop/memory.js'
import { readLoopEvents, type LoopEvent } from '../../loop/retro.js'
import { readDispatchRecord } from '../../loop/tick.js'
import type { MetricsWindow, SearchHit, SearchResult, SearchType } from './contract.js'
import { METRICS_WINDOWS } from './metrics.js'

/**
 * `GET /api/v1/search` read model: case-insensitive substring match over the events of the window, the frozen
 * contracts, DoD evidence, stored reviews and the learnings ledger. Read-only. Every parsed document is cached in
 * memory under its file's mtime+size, so a repeated search only re-stats; the event log is read once per change of
 * its files and never beyond 30 days (`windowed:`).
 */

export const SEARCH_TYPES: readonly SearchType[] = ['event', 'contract', 'evidence', 'review', 'learning']
export const SEARCH_HIT_LIMIT = 200
const SNIPPET = 60

export interface SearchOptions {
  readonly types?: readonly SearchType[]
  readonly window?: MetricsWindow
  readonly issue?: string | null
  /** The loop config, to read the worker's DoD proofs (`dod.evidenceFile`) in each dispatched worktree. */
  readonly config?: LoopConfig
}

interface Doc { readonly type: SearchType; readonly issue: string | null; readonly title: string; readonly at: string | null; readonly source: string; readonly body: Readonly<Record<string, unknown>>; readonly text: string; readonly lower: string }

const doc = (fields: Omit<Doc, 'text' | 'lower'>, text: string): Doc => ({ ...fields, text, lower: text.toLowerCase() })

/** Readable one-line text for a record: `key: value` pairs, nested values as JSON. */
const flatten = (record: Readonly<Record<string, unknown>>): string =>
  Object.entries(record).filter(([key]) => key !== 'at').map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ')

const signature = (path: string): string | null => { try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}` } catch { return null } }

/** One cache per state dir: parsed file → docs, keyed by path and invalidated by mtime+size. */
const fileCache = new Map<string, { readonly signature: string; readonly docs: readonly Doc[] }>()
const cached = (path: string, parse: () => readonly Doc[]): readonly Doc[] => {
  const sig = signature(path)
  if (sig === null) { fileCache.delete(path); return [] }
  const hit = fileCache.get(path)
  if (hit?.signature === sig) return hit.docs
  const docs = parse()
  fileCache.set(path, { signature: sig, docs })
  return docs
}

const EVENT_FILE = /^events(?:-archive-\d+)?\.ndjson$/
const MAX_WINDOW_MS = METRICS_WINDOWS['30d']
const eventCache = new Map<string, { readonly signature: string; readonly readFromMs: number; readonly docs: readonly (Doc & { readonly ms: number })[] }>()

/** Events of the last 30 days as docs; reloaded only when an event file changes or the cached read no longer covers the window. */
const eventDocs = (stateDir: string, sinceMs: number, now: Date): readonly (Doc & { readonly ms: number })[] => {
  const files = existsSync(stateDir) ? readdirSync(stateDir).filter((name) => EVENT_FILE.test(name)).sort() : []
  const sig = files.map((name) => `${name}=${signature(join(stateDir, name))}`).join('|')
  const hit = eventCache.get(stateDir)
  if (hit && hit.signature === sig && hit.readFromMs <= sinceMs) return hit.docs
  const readFromMs = now.getTime() - MAX_WINDOW_MS
  const docs = readLoopEvents(stateDir, readFromMs).flatMap((event: LoopEvent) => {
    const ms = Date.parse(event.at)
    if (!Number.isFinite(ms) || ms < readFromMs) return []
    const evidence = event.type === 'dod.assessed'
    const issue = typeof event.issue === 'string' ? event.issue : null
    return [{ ...doc({ type: evidence ? 'evidence' : 'event', issue, title: evidence ? `DoD assessed${event['pr'] ? ` on PR #${String(event['pr'])}` : ''}` : event.type, at: event.at, source: 'events.ndjson', body: event }, `${event.type} · ${flatten(event)}`), ms }]
  })
  eventCache.set(stateDir, { signature: sig, readFromMs, docs })
  return docs
}

const issueDirs = (stateDir: string, issue: string | null | undefined): readonly string[] => {
  const root = join(stateDir, 'issues')
  if (issue) return existsSync(join(root, issue)) ? [issue] : []
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []
}

/** Only files touched inside the window can hold something from inside it (the same mtime bound the retro uses). */
const touchedSince = (path: string, sinceMs: number): boolean => { try { return statSync(path).mtimeMs >= sinceMs } catch { return false } }

const issueDocs = (stateDir: string, issue: string, sinceMs: number, config: LoopConfig | undefined, types: ReadonlySet<SearchType>): readonly Doc[] => {
  const dir = join(stateDir, 'issues', issue)
  const rel = (path: string): string => relative(stateDir, path).split('\\').join('/')
  const out: Doc[] = []
  const contractFile = join(dir, 'contract.json')
  if (types.has('contract') && touchedSince(contractFile, sinceMs)) out.push(...cached(contractFile, () => {
    const stored = readStoredContract(stateDir, issue)
    if (!stored) return []
    const { contract } = stored
    const text = [contract.intent, ...contract.scope.inScope, ...contract.scope.outOfScope, ...contract.outcomes.map((outcome) => `${outcome.id}: ${outcome.description}`), ...contract.ambiguities.map((item) => item.question), ...contract.touchpoints, ...contract.risks].join(' · ')
    return [doc({ type: 'contract', issue, title: contract.intent, at: stored.generatedAt, source: rel(contractFile), body: { issue, digest: stored.digest, generatedAt: stored.generatedAt, dispatchable: stored.assessment.dispatchable, reasons: stored.assessment.reasons, outcomes: contract.outcomes } }, text)]
  }))
  if (types.has('review') && existsSync(dir)) for (const name of readdirSync(dir).filter((file) => /^review-.+\.json$/.test(file))) {
    const path = join(dir, name)
    if (!touchedSince(path, sinceMs)) continue
    out.push(...cached(path, () => {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return [] }
      const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed }
      const head = name.slice('review-'.length, -'.json'.length)
      return [doc({ type: 'review', issue, title: `Review ${head}`, at: new Date(statSync(path).mtimeMs).toISOString(), source: rel(path), body }, JSON.stringify(body))]
    }))
  }
  const dodEvidenceFile = config?.dod.evidenceFile
  if (types.has('evidence') && config && dodEvidenceFile) {
    const worktree = readDispatchRecord(stateDir, issue)?.worktreePath
    const path = worktree ? join(worktree, dodEvidenceFile) : null
    if (path && touchedSince(path, sinceMs)) out.push(...cached(path, () => {
      const evidence = readDodEvidence(worktree, config)
      return [...evidence.project.map((proof) => ({ proof, list: 'project' })), ...evidence.outcomes.map((proof) => ({ proof, list: 'issue' }))].map(({ proof, list }) =>
        // The worktree lives outside the state dir; name it by issue, never by its absolute path.
        doc({ type: 'evidence', issue, title: `${proof.id} ${proof.status}`, at: proof.at ?? null, source: `worktree:${issue}/${dodEvidenceFile}`, body: { ...proof, list } }, `${proof.id} · ${proof.status} · ${proof.evidence}`))
    }))
  }
  return out
}

const learningDocs = (stateDir: string): readonly Doc[] => cached(learningsPath(stateDir), () => readLearningsLedger(stateDir).records.map((record) =>
  doc({ type: 'learning', issue: null, title: record.text.slice(0, 80), at: record.recordedAt, source: 'learnings.json', body: { ...record } }, `${record.category} · ${record.text} · ${record.source}`)))

export const search = (stateDir: string, query: string, options: SearchOptions = {}, now = new Date()): SearchResult => {
  const started = performance.now()
  const needle = query.trim().toLowerCase()
  const window = options.window ?? '7d'
  const sinceMs = now.getTime() - METRICS_WINDOWS[window]
  const types = new Set(options.types?.length ? options.types : SEARCH_TYPES)
  const issue = options.issue ?? null
  const counts: Record<SearchType, number> = { event: 0, contract: 0, evidence: 0, review: 0, learning: 0 }
  const hits: SearchHit[] = []
  const consider = (candidate: Doc, id: string): void => {
    if (!types.has(candidate.type) || (issue && candidate.issue !== issue)) return
    // Dated documents older than the window are out; learnings are a ledger, not a log, and are never windowed.
    if (candidate.type !== 'learning' && candidate.at !== null && Date.parse(candidate.at) < sinceMs) return
    const index = candidate.lower.indexOf(needle)
    if (index < 0) return
    counts[candidate.type] += 1
    if (hits.length >= SEARCH_HIT_LIMIT) return
    hits.push({
      id, type: candidate.type, issue: candidate.issue, title: candidate.title, at: candidate.at, source: candidate.source, body: candidate.body,
      snippet: { pre: candidate.text.slice(Math.max(0, index - SNIPPET), index), hit: candidate.text.slice(index, index + needle.length), post: candidate.text.slice(index + needle.length, index + needle.length + SNIPPET) },
    })
  }
  if (needle) {
    // Newest events first, so a truncated result keeps the most recent hits.
    if (types.has('event') || types.has('evidence')) {
      const events = eventDocs(stateDir, sinceMs, now)
      for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]!; if (event.ms >= sinceMs && event.ms <= now.getTime()) consider(event, `${event.type}:${event.at}:${index}`) }
    }
    for (const dir of issueDirs(stateDir, issue)) issueDocs(stateDir, dir, sinceMs, options.config, types).forEach((candidate, index) => consider(candidate, `${candidate.source}#${index}`))
    if (types.has('learning') && !issue) learningDocs(stateDir).forEach((candidate) => consider(candidate, `learning:${String(candidate.body['id'])}`))
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { query, window, hits, counts, tookMs: Math.round(performance.now() - started), truncated: total > hits.length }
}
